'use strict';
// Deterministic, offline tests for ../verify-npm-provenance.cjs.
//
// Run: node --test .github/scripts/test/*.test.cjs
// Needs npm's bundled sigstore libs (NPM_MODULES_DIR, default
// "$(npm root -g)/npm/node_modules"); CI pins the npm version (see ci.yml).
//
// Fixtures (fetched read-only from the public registry / Sigstore TUF CDN,
// committed verbatim so the tests never touch the network):
//   openmax-agent-sdk-1.1.0.{manifest,attestations}.json
//     GET https://registry.npmjs.org/@openmaxai%2fopenmax-agent-sdk/1.1.0
//     GET https://registry.npmjs.org/-/npm/v1/attestations/@openmaxai%2fopenmax-agent-sdk@1.1.0
//     (sigstore bundle v0.2, x509CertificateChain, tag ref, annotated tag)
//   sigstore-5.0.0.{manifest,attestations}.json
//     same endpoints for sigstore@5.0.0
//     (sigstore bundle v0.3, single certificate, branch ref, inclusion proof)
//   sigstore-trusted-root.json
//     targets/trusted_root.json from https://tuf-repo-cdn.sigstore.dev
//     (Sigstore public-good root: Fulcio CAs, Rekor + CT log keys). Bundles
//     are verified at their Rekor integratedTime, so the result does not
//     depend on the current date.
//
// Each negative test asserts WHICH check failed (err.check / sigstoreCode),
// so removing that check from the verifier makes the test fail even when a
// later defense-in-depth check would still reject the input.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const V = require('../verify-npm-provenance.cjs');

const FIX = path.join(__dirname, 'fixtures');
const load = (f) => require(path.join(FIX, f));
const clone = (o) => structuredClone(o);

const MOD_DIR = process.env.NPM_MODULES_DIR
  || path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'npm', 'node_modules');
const libs = V.loadLibs(MOD_DIR);
const realVerifyBundle = V.makeBundleVerifier(libs, V.trustedRootFromJSON(libs, load('sigstore-trusted-root.json')));
// Deliberately skips crypto: used ONLY to reach the post-crypto
// certificate/predicate checks with a tampered payload, which real crypto
// would (correctly) reject first.
const noCrypto = () => {};

const CASES = {
  sdk: {
    manifest: load('openmax-agent-sdk-1.1.0.manifest.json'),
    attestations: load('openmax-agent-sdk-1.1.0.attestations.json'),
    expected: {
      name: '@openmaxai/openmax-agent-sdk',
      version: '1.1.0',
      repo: 'openmaxai/openmax-agent-sdk',
      repoId: '1303756971',
      workflowPath: '.github/workflows/release.yml',
      ref: 'refs/tags/v1.1.0',
      sha: '536904d4e00bb3f2f7010ac636d6099286af01bd',
    },
    // `git ls-remote`: refs/tags/v1.1.0 (tag object) vs refs/tags/v1.1.0^{}
    tagObjectSha: 'ac3d29752c796e086c5583a8156331c4cb501709',
  },
  sigstore: {
    manifest: load('sigstore-5.0.0.manifest.json'),
    attestations: load('sigstore-5.0.0.attestations.json'),
    expected: {
      name: 'sigstore',
      version: '5.0.0',
      repo: 'sigstore/sigstore-js',
      repoId: '495574555',
      workflowPath: '.github/workflows/release.yml',
      ref: 'refs/heads/main',
      sha: '7d2900eca1c22b3f87c13987c8d4b7c9a29b733a',
    },
    tagObjectSha: '16f41bab7ab462b17992152353687044e3e581d4', // refs/tags/sigstore@5.0.0
  },
};

function run(c, { manifest, attestations, expected, verifyBundle } = {}) {
  return V.verifyProvenance({
    manifest: manifest || clone(c.manifest),
    attestations: attestations || clone(c.attestations),
    expected: { ...c.expected, ...expected },
    verifyBundle: verifyBundle || realVerifyBundle,
    libs,
  });
}

function rejects(fn, check, sigstoreCode) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected failure at ${check}, but verification passed`);
  assert.ok(err instanceof V.ProvenanceError, `unexpected non-ProvenanceError: ${err && err.stack}`);
  assert.equal(err.check, check, `failed at ${err.check} (${err.message}), want ${check}`);
  if (sigstoreCode) assert.match(String(err.sigstoreCode), sigstoreCode, err.message);
  return err;
}

const provOf = (att) => att.attestations.find((a) => a.predicateType === V.SLSA_V1);
function editStatement(att, fn) {
  const b = provOf(att).bundle;
  const st = JSON.parse(Buffer.from(b.dsseEnvelope.payload, 'base64').toString('utf8'));
  fn(st);
  b.dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString('base64');
  return att;
}
function flipB64(s, at = 10) {
  const buf = Buffer.from(s, 'base64');
  buf[at] ^= 0x01;
  return buf.toString('base64');
}

for (const [label, c] of Object.entries(CASES)) {
  test(`${label}: genuine registry attestation verifies`, () => {
    const r = run(c);
    assert.equal(r.sha, c.expected.sha);
    assert.equal(r.integrity, c.manifest.dist.integrity);
  });

  // --- expected identity mismatches (real crypto) ---------------------------
  test(`${label}: wrong repo -> rejected by sigstore SAN policy`, () => {
    rejects(() => run(c, { expected: { repo: 'openmaxai/email-mcp' } }), 'bundle.sigstore', /UNTRUSTED_SIGNER/);
  });
  test(`${label}: wrong workflow path -> rejected by sigstore SAN policy`, () => {
    rejects(() => run(c, { expected: { workflowPath: '.github/workflows/ci.yml' } }), 'bundle.sigstore', /UNTRUSTED_SIGNER/);
  });
  test(`${label}: wrong ref -> rejected by sigstore SAN policy`, () => {
    rejects(() => run(c, { expected: { ref: 'refs/tags/v9.9.9' } }), 'bundle.sigstore', /UNTRUSTED_SIGNER/);
  });
  test(`${label}: SAN regex is anchored (prefix of real ref) -> rejected`, () => {
    rejects(() => run(c, { expected: { ref: c.expected.ref.slice(0, -1) } }), 'bundle.sigstore', /UNTRUSTED_SIGNER/);
  });
  test(`${label}: wrong repo id -> rejected by cert source repo identifier`, () => {
    rejects(() => run(c, { expected: { repoId: '1' } }), 'cert.sourceRepoIdentifier');
  });
  test(`${label}: wrong commit -> rejected by cert source repo digest`, () => {
    rejects(() => run(c, { expected: { sha: 'f'.repeat(40) } }), 'cert.sourceRepoDigest');
  });
  test(`${label}: annotated tag OBJECT sha (not peeled) -> rejected`, () => {
    rejects(() => run(c, { expected: { sha: c.tagObjectSha } }), 'cert.sourceRepoDigest');
  });
  test(`${label}: malformed expected sha -> rejected before anything else`, () => {
    rejects(() => run(c, { expected: { sha: c.expected.sha.slice(0, 7) } }), 'input.sha');
    rejects(() => run(c, { expected: { sha: c.expected.sha.toUpperCase() } }), 'input.sha');
  });

  // --- registry manifest ----------------------------------------------------
  test(`${label}: tarball integrity mismatch -> rejected by subject digest`, () => {
    const m = clone(c.manifest);
    m.dist.integrity = `sha512-${crypto.createHash('sha512').update('other tarball').digest('base64')}`;
    rejects(() => run(c, { manifest: m }), 'subject.digest');
  });
  test(`${label}: non-sha512 integrity -> rejected`, () => {
    const m = clone(c.manifest);
    m.dist.integrity = 'sha1-AAAA';
    rejects(() => run(c, { manifest: m }), 'manifest.integrity');
  });
  test(`${label}: manifest for another version -> rejected`, () => {
    rejects(() => run(c, { expected: { version: '0.0.1' } }), 'manifest.version');
  });
  test(`${label}: manifest for another package -> rejected`, () => {
    rejects(() => run(c, { expected: { name: 'left-pad' } }), 'manifest.name');
  });

  // --- attestation document -------------------------------------------------
  test(`${label}: missing provenance attestation -> rejected`, () => {
    const a = clone(c.attestations);
    a.attestations = a.attestations.filter((x) => x.predicateType !== V.SLSA_V1);
    assert.ok(a.attestations.length >= 1, 'publish attestation remains');
    rejects(() => run(c, { attestations: a }), 'attestations.count');
    rejects(() => run(c, { attestations: {} }), 'attestations.count');
  });
  test(`${label}: multiple provenance attestations -> rejected`, () => {
    const a = clone(c.attestations);
    a.attestations.push(clone(provOf(a)));
    rejects(() => run(c, { attestations: a }), 'attestations.count');
  });

  // --- cryptographic tampering (real crypto) --------------------------------
  test(`${label}: payload tamper (re-bind to a forged tarball) -> rejected by signature`, () => {
    // Every non-crypto check would pass: subject digest AND registry integrity
    // both point at the forged tarball. Only the DSSE signature catches it.
    const forged = crypto.createHash('sha512').update('forged tarball');
    const a = editStatement(clone(c.attestations), (st) => { st.subject[0].digest.sha512 = forged.copy().digest('hex'); });
    const m = clone(c.manifest);
    m.dist.integrity = `sha512-${forged.digest('base64')}`;
    // sigstore-js compares the envelope with the Rekor-logged entry before the
    // DSSE signature itself, so the tampered payload is reported there.
    const e = rejects(() => run(c, { manifest: m, attestations: a }), 'bundle.sigstore', /^(TLOG_BODY_ERROR|SIGNATURE_ERROR)$/);
    assert.match(e.message, /payload hash mismatch|signature/i);
    // sanity: the same tampered input passes when crypto is skipped
    assert.doesNotThrow(() => run(c, { manifest: m, attestations: a, verifyBundle: noCrypto }));
  });
  test(`${label}: signature tamper -> rejected`, () => {
    const a = clone(c.attestations);
    const sig = provOf(a).bundle.dsseEnvelope.signatures[0];
    sig.sig = flipB64(sig.sig, 20);
    const e = rejects(() => run(c, { attestations: a }), 'bundle.sigstore', /^(TLOG_BODY_ERROR|SIGNATURE_ERROR)$/);
    assert.match(e.message, /signature/i);
  });
  test(`${label}: tlog tamper (Rekor integratedTime) -> rejected`, () => {
    const a = clone(c.attestations);
    const t = provOf(a).bundle.verificationMaterial.tlogEntries[0];
    t.integratedTime = String(Number(t.integratedTime) + 1);
    rejects(() => run(c, { attestations: a }), 'bundle.sigstore', /TLOG/);
  });
  test(`${label}: tlog tamper (canonicalized body) -> rejected`, () => {
    const a = clone(c.attestations);
    const t = provOf(a).bundle.verificationMaterial.tlogEntries[0];
    const body = JSON.parse(Buffer.from(t.canonicalizedBody, 'base64').toString('utf8'));
    body.spec.content = body.spec.content || {};
    body.spec.content.payloadHash = { algorithm: 'sha256', value: '0'.repeat(64) };
    t.canonicalizedBody = Buffer.from(JSON.stringify(body)).toString('base64');
    rejects(() => run(c, { attestations: a }), 'bundle.sigstore', /TLOG/);
  });
  test(`${label}: certificate tamper -> rejected`, () => {
    const a = clone(c.attestations);
    const vm = provOf(a).bundle.verificationMaterial;
    const holder = vm.certificate || vm.x509CertificateChain.certificates[0];
    holder.rawBytes = flipB64(holder.rawBytes, 200);
    rejects(() => run(c, { attestations: a }), 'bundle.sigstore');
  });

  // --- post-crypto checks, reached by skipping crypto ------------------------
  // Real crypto rejects all of these first (asserted once below); these tests
  // pin the defense-in-depth predicate checks themselves.
  const predicateTampers = {
    'statement.predicateType': (st) => { st.predicateType = 'https://slsa.dev/provenance/v0.2'; },
    'subject.count': (st) => { st.subject.push(clone(st.subject[0])); },
    'subject.name': (st) => { st.subject[0].name = 'pkg:npm/evil@1.0.0'; },
    'predicate.buildType': (st) => { st.predicate.buildDefinition.buildType = 'https://example.com/other'; },
    'predicate.workflow.repository': (st) => { st.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/evil/repo'; },
    'predicate.workflow.path': (st) => { st.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/evil.yml'; },
    'predicate.workflow.ref': (st) => { st.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/evil'; },
    'predicate.repository_id': (st) => { st.predicate.buildDefinition.internalParameters.github.repository_id = '1'; },
    'predicate.resolvedDependencies': (st) => { st.predicate.buildDefinition.resolvedDependencies.push({ uri: 'x', digest: {} }); },
    'predicate.gitCommit': (st) => { st.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'f'.repeat(40); },
    'predicate.builder.id': (st) => { st.predicate.runDetails.builder.id = 'https://example.com/self-hosted'; },
  };
  for (const [check, fn] of Object.entries(predicateTampers)) {
    test(`${label}: predicate tamper -> ${check}`, () => {
      const a = editStatement(clone(c.attestations), fn);
      rejects(() => run(c, { attestations: a, verifyBundle: noCrypto }), check);
      rejects(() => run(c, { attestations: a }), 'bundle.sigstore');
    });
  }
  test(`${label}: DSSE payloadType tamper -> rejected`, () => {
    const a = clone(c.attestations);
    provOf(a).bundle.dsseEnvelope.payloadType = 'text/plain';
    rejects(() => run(c, { attestations: a, verifyBundle: noCrypto }), 'dsse.payloadType');
    rejects(() => run(c, { attestations: a }), 'bundle.sigstore');
  });
  test(`${label}: bundle without certificate -> rejected`, () => {
    const a = clone(c.attestations);
    const vm = provOf(a).bundle.verificationMaterial;
    delete vm.certificate;
    delete vm.x509CertificateChain;
    rejects(() => run(c, { attestations: a, verifyBundle: noCrypto }), 'cert.present');
    rejects(() => run(c, { attestations: a }), 'bundle.sigstore');
  });
}

// The attestation of one package must not verify another package's identity.
test('cross-package: sdk attestation presented for sigstore identity -> rejected', () => {
  rejects(() => V.verifyProvenance({
    manifest: clone(CASES.sigstore.manifest),
    attestations: clone(CASES.sdk.attestations),
    expected: CASES.sigstore.expected,
    verifyBundle: realVerifyBundle,
    libs,
  }), 'bundle.sigstore', /UNTRUSTED_SIGNER/);
});

// CLI entry: validates input before any network access and exits 1 with a
// GitHub ::error:: annotation.
test('CLI: malformed EXPECT_SHA exits 1 without network', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'verify-npm-provenance.cjs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PKG_NAME: 'x', PKG_VERSION: '1.0.0', EXPECT_REPO: 'o/r', EXPECT_REPO_ID: '1',
      EXPECT_WORKFLOW_PATH: '.github/workflows/release.yml', EXPECT_REF: 'refs/tags/v1.0.0',
      EXPECT_SHA: 'deadbeef', NPM_MODULES_DIR: MOD_DIR, NPM_REGISTRY: 'http://127.0.0.1:9',
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::provenance verification FAILED: input\.sha/);
});
test('CLI: missing env exits 1', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'verify-npm-provenance.cjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /missing required env PKG_NAME/);
});
