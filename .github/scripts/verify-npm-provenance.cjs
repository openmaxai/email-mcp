#!/usr/bin/env node
// Verify that PKG_NAME@PKG_VERSION on the npm registry carries a
// cryptographically valid SLSA provenance attestation that ties that exact
// tarball to THIS repository + THIS workflow + THIS ref + THIS commit.
//
// Why: the registry's `gitHead` field is plaintext supplied by whoever
// published. A leaked npm token could publish a version with a forged gitHead;
// provenance cannot be forged that way because it is signed by a short-lived
// Fulcio certificate that Fulcio only issues against a GitHub Actions OIDC
// token for the workflow run that actually did the publish.
//
// Dependency-free: node built-ins + the sigstore libraries npm itself bundles
// (the same ones `npm audit signatures` uses), loaded from NPM_MODULES_DIR.
// The module layout of npm's bundled deps is not a public API, so the npm
// version is pinned wherever this runs (release.yml + the CI job that runs
// .github/scripts/test/*.test.cjs against committed fixtures).
//
// Structure (so the logic is unit-testable without network):
//   verifyProvenance({ manifest, attestations, expected, verifyBundle, libs })
//     pure + synchronous: throws ProvenanceError{check} on the first failed
//     check, returns a summary on success.
//     (certificate parsing is injectable too: parseCert)
//   makeBundleVerifier(libs, trustedRoot)
//     real sigstore crypto (DSSE signature, Fulcio chain, SCT, Rekor tlog)
//     against a given Sigstore trusted root. The CLI obtains that root via
//     TUF (online, signed metadata); tests pass a committed trusted_root.json.
//   main()  CLI: env -> registry fetches -> TUF root -> verifyProvenance.
//
// CLI env (all required unless noted):
//   PKG_NAME, PKG_VERSION
//   EXPECT_REPO            owner/repo, e.g. openmaxai/email-mcp
//   EXPECT_REPO_ID         numeric GitHub repository id (github.repository_id)
//   EXPECT_WORKFLOW_PATH   e.g. .github/workflows/release.yml
//   EXPECT_REF             e.g. refs/tags/v0.1.0
//   EXPECT_SHA             40-hex commit sha (peeled, not an annotated tag object)
//   NPM_MODULES_DIR        "$(npm root -g)/npm/node_modules"
//   NPM_REGISTRY           optional, default https://registry.npmjs.org
//   ATTEST_ATTEMPTS        optional, default 12 (x10s) for propagation delay
'use strict';

const path = require('node:path');

const SLSA_V1 = 'https://slsa.dev/provenance/v1';
const GHA_ISSUER = 'https://token.actions.githubusercontent.com';
const GHA_BUILDER = 'https://github.com/actions/runner/github-hosted';
const GHA_BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
// Fulcio certificate extension OIDs (see sigstore/fulcio docs/oid-info.md).
const OID = {
  issuer: '1.3.6.1.4.1.57264.1.8',
  buildSignerURI: '1.3.6.1.4.1.57264.1.9',
  runnerEnvironment: '1.3.6.1.4.1.57264.1.11',
  sourceRepoURI: '1.3.6.1.4.1.57264.1.12',
  sourceRepoDigest: '1.3.6.1.4.1.57264.1.13',
  sourceRepoRef: '1.3.6.1.4.1.57264.1.14',
  sourceRepoIdentifier: '1.3.6.1.4.1.57264.1.15',
};

class ProvenanceError extends Error {
  constructor(check, message, extra) {
    super(`${check}: ${message}`);
    this.name = 'ProvenanceError';
    this.check = check;
    Object.assign(this, extra);
  }
}

function expectEq(log, check, got, want) {
  if (got !== want) {
    throw new ProvenanceError(check, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  log(`  ok  ${check} = ${want}`);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Load npm's bundled sigstore libraries from NPM_MODULES_DIR.
function loadLibs(modDir) {
  const r = (m) => require(path.join(modDir, ...m.split('/')));
  return {
    core: r('@sigstore/core'),
    verify: r('@sigstore/verify'),
    bundle: r('@sigstore/bundle'),
    protobuf: r('@sigstore/protobuf-specs'),
    tuf: r('@sigstore/tuf'),
  };
}

// Same pipeline as sigstore.verify() (sigstore-js createVerifier), minus the
// TUF fetch: the trusted root is an explicit input.
function makeBundleVerifier(libs, trustedRoot) {
  const verifier = new libs.verify.Verifier(libs.verify.toTrustMaterial(trustedRoot));
  return (bundleJSON, policy) => {
    const b = libs.bundle.bundleFromJSON(bundleJSON);
    verifier.verify(libs.verify.toSignedEntity(b), policy);
  };
}

function trustedRootFromJSON(libs, json) {
  return libs.protobuf.TrustedRoot.fromJSON(json);
}

// Fulcio v2 extensions (.1.8+) hold a DER-encoded UTF8String.
function certExt(libs, cert, oid) {
  const ext = cert.extension(oid);
  if (!ext) return undefined;
  // ext.value = raw extnValue OCTET STRING contents = DER UTF8String (tag 0x0c).
  const obj = libs.core.ASN1Obj.parseBuffer(ext.value);
  if (obj.tag.number !== 0x0c) throw new ProvenanceError('cert.extension', `${oid} is not a UTF8String`);
  return obj.value.toString('utf8');
}

function validateExpected(e) {
  const need = ['name', 'version', 'repo', 'repoId', 'workflowPath', 'ref', 'sha'];
  for (const k of need) {
    if (typeof e[k] !== 'string' || e[k] === '') throw new ProvenanceError(`input.${k}`, 'missing');
  }
  if (!/^[0-9a-f]{40}$/.test(e.sha)) throw new ProvenanceError('input.sha', `not a 40-hex commit sha: ${e.sha}`);
  if (!/^[0-9]+$/.test(e.repoId)) throw new ProvenanceError('input.repoId', `not numeric: ${e.repoId}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.repo)) throw new ProvenanceError('input.repo', `not owner/repo: ${e.repo}`);
  if (!/^refs\//.test(e.ref)) throw new ProvenanceError('input.ref', `not a full ref: ${e.ref}`);
}

function purlFor(name, version) {
  return `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
}

/**
 * Pure verification (no network, no process exit).
 * @param {object} a
 * @param {object} a.manifest       registry version manifest (GET /<name>/<version>)
 * @param {object} a.attestations   registry attestations doc (GET /-/npm/v1/attestations/<name>@<version>)
 * @param {object} a.expected       { name, version, repo, repoId, workflowPath, ref, sha }
 * @param {Function} a.verifyBundle (bundleJSON, policy) => void, throws on failure (makeBundleVerifier)
 * @param {object} a.libs           loadLibs() result (X509/ASN1 parsing)
 * @param {Function} [a.parseCert]  (derBuffer) => cert with .subjectAltName and
 *                                  .extension(oid) -> { value } | undefined;
 *                                  default libs.core.X509Certificate.parse.
 *                                  Injectable (like verifyBundle) so tests can
 *                                  present certificates whose identity
 *                                  extensions differ from the real fixture's.
 * @param {Function} [a.log]
 */
function verifyProvenance({
  manifest, attestations, expected, verifyBundle, libs,
  parseCert = (der) => libs.core.X509Certificate.parse(der),
  log = () => {},
}) {
  validateExpected(expected);
  const { name, version, repo, repoId, workflowPath, ref, sha } = expected;
  const repoURL = `https://github.com/${repo}`;
  const signerURI = `${repoURL}/${workflowPath}@${ref}`;
  const purl = purlFor(name, version);

  log(`verifying provenance of ${name}@${version}`);
  log(`  expected signer ${signerURI} @ ${sha}`);

  // 1. Version manifest: the tarball integrity the registry serves.
  expectEq(log, 'manifest.name', manifest && manifest.name, name);
  expectEq(log, 'manifest.version', manifest.version, version);
  const integrity = manifest.dist && manifest.dist.integrity;
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new ProvenanceError('manifest.integrity', `no sha512 dist.integrity (${integrity})`);
  }
  const tarballSha512 = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');

  // 2. Exactly one SLSA v1 provenance attestation.
  const list = attestations && Array.isArray(attestations.attestations) ? attestations.attestations : [];
  const prov = list.filter((a) => a && a.predicateType === SLSA_V1);
  if (prov.length !== 1) {
    throw new ProvenanceError('attestations.count', `expected exactly 1 SLSA v1 provenance attestation, found ${prov.length}`);
  }
  const bundle = prov[0].bundle;

  // 3. Cryptographic verification: DSSE signature by the leaf cert, cert chain
  //    to the Sigstore (Fulcio) root, SCT, Rekor transparency-log inclusion,
  //    and the cert identity (SAN + OIDC issuer) as policy.
  try {
    verifyBundle(bundle, {
      extensions: { issuer: GHA_ISSUER },
      // @sigstore/verify matches the SAN with String#match -> anchor + escape.
      subjectAlternativeName: `^${escapeRegExp(signerURI)}$`,
    });
  } catch (e) {
    throw new ProvenanceError('bundle.sigstore', `${e && e.code ? e.code : ''} ${e && e.message}`.trim(), {
      sigstoreCode: e && e.code,
      cause: e,
    });
  }
  log('  ok  sigstore bundle signature, certificate chain, tlog, SAN, issuer');

  // 4. Certificate extensions (signed by Fulcio from the OIDC token claims):
  //    these, not the free-form predicate, are the authoritative identity.
  const vm = bundle.verificationMaterial || {};
  const leafB64 = (vm.certificate && vm.certificate.rawBytes)
    || (vm.x509CertificateChain && vm.x509CertificateChain.certificates
      && vm.x509CertificateChain.certificates[0] && vm.x509CertificateChain.certificates[0].rawBytes);
  if (!leafB64) throw new ProvenanceError('cert.present', 'bundle has no signing certificate');
  const cert = parseCert(Buffer.from(leafB64, 'base64'));
  expectEq(log, 'cert.san', cert.subjectAltName, signerURI);
  expectEq(log, 'cert.issuer', certExt(libs, cert, OID.issuer), GHA_ISSUER);
  expectEq(log, 'cert.buildSignerURI', certExt(libs, cert, OID.buildSignerURI), signerURI);
  expectEq(log, 'cert.runnerEnvironment', certExt(libs, cert, OID.runnerEnvironment), 'github-hosted');
  expectEq(log, 'cert.sourceRepoURI', certExt(libs, cert, OID.sourceRepoURI), repoURL);
  expectEq(log, 'cert.sourceRepoIdentifier', certExt(libs, cert, OID.sourceRepoIdentifier), repoId);
  expectEq(log, 'cert.sourceRepoRef', certExt(libs, cert, OID.sourceRepoRef), ref);
  expectEq(log, 'cert.sourceRepoDigest', certExt(libs, cert, OID.sourceRepoDigest), sha);

  // 5. The signed in-toto statement: subject must be exactly this tarball, and
  //    the predicate must agree with the certificate.
  const env = bundle.dsseEnvelope;
  expectEq(log, 'dsse.payloadType', env && env.payloadType, 'application/vnd.in-toto+json');
  let st;
  try {
    st = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'));
  } catch (e) {
    throw new ProvenanceError('dsse.payload', `not JSON: ${e.message}`);
  }
  expectEq(log, 'statement.predicateType', st.predicateType, SLSA_V1);
  if (!Array.isArray(st.subject) || st.subject.length !== 1) {
    throw new ProvenanceError('subject.count', 'statement must have exactly 1 subject');
  }
  expectEq(log, 'subject.name', st.subject[0].name, purl);
  expectEq(log, 'subject.digest', st.subject[0].digest && st.subject[0].digest.sha512, tarballSha512);
  const bd = (st.predicate && st.predicate.buildDefinition) || {};
  const wf = (bd.externalParameters && bd.externalParameters.workflow) || {};
  expectEq(log, 'predicate.buildType', bd.buildType, GHA_BUILD_TYPE);
  expectEq(log, 'predicate.workflow.repository', wf.repository, repoURL);
  expectEq(log, 'predicate.workflow.path', wf.path, workflowPath);
  expectEq(log, 'predicate.workflow.ref', wf.ref, ref);
  const gh = (bd.internalParameters && bd.internalParameters.github) || {};
  expectEq(log, 'predicate.repository_id', gh.repository_id, repoId);
  const deps = bd.resolvedDependencies || [];
  if (deps.length !== 1) {
    throw new ProvenanceError('predicate.resolvedDependencies', `expected exactly 1, found ${deps.length}`);
  }
  expectEq(log, 'predicate.gitCommit', deps[0].digest && deps[0].digest.gitCommit, sha);
  const rd = (st.predicate && st.predicate.runDetails) || {};
  expectEq(log, 'predicate.builder.id', rd.builder && rd.builder.id, GHA_BUILDER);

  log(`OK: ${name}@${version} has verified provenance from ${signerURI} @ ${sha}`);
  return { signerURI, sha, integrity };
}

// ---------------------------------------------------------------- CLI ----

function env(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (def !== undefined) return def;
    cliFail(`missing required env ${name}`);
  }
  return v;
}

function cliFail(msg) {
  console.log(`::error::provenance verification FAILED: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, attempts) {
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
    } catch (e) {
      res = { ok: false, status: `network error: ${e.message}` };
    }
    if (res.ok) return res.json();
    // 404 = not there (yet); retry only for propagation, then give up.
    if (i >= attempts) cliFail(`GET ${url} -> ${res.status}`);
    console.log(`  GET ${url} -> ${res.status}; retrying (${i}/${attempts})...`);
    await sleep(10000);
  }
}

function encodePkgName(name) {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

async function main() {
  const expected = {
    name: env('PKG_NAME'),
    version: env('PKG_VERSION'),
    repo: env('EXPECT_REPO'),
    repoId: env('EXPECT_REPO_ID'),
    workflowPath: env('EXPECT_WORKFLOW_PATH'),
    ref: env('EXPECT_REF'),
    sha: env('EXPECT_SHA'),
  };
  const modDir = env('NPM_MODULES_DIR');
  const registry = env('NPM_REGISTRY', 'https://registry.npmjs.org').replace(/\/+$/, '');
  const attempts = Number(env('ATTEST_ATTEMPTS', '12'));
  // Fail fast on malformed input before any network traffic.
  try { validateExpected(expected); } catch (e) { cliFail(e.message); }

  const libs = loadLibs(modDir);
  const encName = encodePkgName(expected.name);
  const encVer = encodeURIComponent(expected.version);
  // URLs constructed here, never taken from the manifest.
  const manifest = await getJSON(`${registry}/${encName}/${encVer}`, attempts);
  const attestations = await getJSON(`${registry}/-/npm/v1/attestations/${encName}@${encVer}`, attempts);
  // Sigstore public-good trusted root via TUF (signed, versioned metadata) --
  // identical to what sigstore.verify() / `npm audit signatures` use.
  const trustedRoot = await libs.tuf.getTrustedRoot({ retry: { retries: 2 }, timeout: 5000 });

  verifyProvenance({
    manifest,
    attestations,
    expected,
    verifyBundle: makeBundleVerifier(libs, trustedRoot),
    libs,
    log: (m) => console.log(m),
  });
}

module.exports = {
  OID,
  ProvenanceError,
  verifyProvenance,
  makeBundleVerifier,
  trustedRootFromJSON,
  loadLibs,
  purlFor,
  SLSA_V1,
};

if (require.main === module) {
  main().catch((e) => cliFail(e instanceof ProvenanceError ? e.message : (e && e.stack) || String(e)));
}
