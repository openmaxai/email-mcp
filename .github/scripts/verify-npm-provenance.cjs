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
//
// Env (all required unless noted):
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

function env(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (def !== undefined) return def;
    fail(`missing required env ${name}`);
  }
  return v;
}

function fail(msg) {
  console.log(`::error::provenance verification FAILED: ${msg}`);
  process.exit(1);
}

function expectEq(what, got, want) {
  if (got !== want) fail(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  console.log(`  ok  ${what} = ${want}`);
}

let X509Certificate;
let ASN1Obj;

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
    if (i >= attempts) fail(`GET ${url} -> ${res.status}`);
    console.log(`  GET ${url} -> ${res.status}; retrying (${i}/${attempts})...`);
    await sleep(10000);
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fulcio v2 extensions (.1.8+) hold a DER-encoded UTF8String.
function certExt(cert, oid) {
  const ext = cert.extension(oid);
  if (!ext) return undefined;
  // ext.value = raw extnValue OCTET STRING contents = DER UTF8String (tag 0x0c).
  const obj = ASN1Obj.parseBuffer(ext.value);
  if (obj.tag.number !== 0x0c) fail(`cert extension ${oid} is not a UTF8String`);
  return obj.value.toString('utf8');
}

async function main() {
  const name = env('PKG_NAME');
  const version = env('PKG_VERSION');
  const repo = env('EXPECT_REPO');
  const repoId = env('EXPECT_REPO_ID');
  const wfPath = env('EXPECT_WORKFLOW_PATH');
  const ref = env('EXPECT_REF');
  const sha = env('EXPECT_SHA');
  const modDir = env('NPM_MODULES_DIR');
  const registry = env('NPM_REGISTRY', 'https://registry.npmjs.org').replace(/\/+$/, '');
  const attempts = Number(env('ATTEST_ATTEMPTS', '12'));
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`EXPECT_SHA is not a 40-hex commit sha: ${sha}`);

  const sigstore = require(path.join(modDir, 'sigstore'));
  ({ X509Certificate, ASN1Obj } = require(path.join(modDir, '@sigstore', 'core')));

  const repoURL = `https://github.com/${repo}`;
  const signerURI = `${repoURL}/${wfPath}@${ref}`;
  const encName = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const purl = `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;

  console.log(`verifying provenance of ${name}@${version}`);
  console.log(`  expected signer ${signerURI} @ ${sha}`);

  // 1. Version manifest: the tarball integrity the registry serves.
  const manifest = await getJSON(`${registry}/${encName}/${encodeURIComponent(version)}`, attempts);
  expectEq('manifest version', manifest.version, version);
  const integrity = manifest.dist && manifest.dist.integrity;
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    fail(`manifest has no sha512 dist.integrity (${integrity})`);
  }
  const tarballSha512 = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');

  // 2. Attestations (URL constructed here, not taken from the manifest).
  const att = await getJSON(`${registry}/-/npm/v1/attestations/${encName}@${encodeURIComponent(version)}`, attempts);
  const prov = (att.attestations || []).filter((a) => a.predicateType === SLSA_V1);
  if (prov.length !== 1) fail(`expected exactly 1 SLSA v1 provenance attestation, found ${prov.length}`);
  const bundle = prov[0].bundle;

  // 3. Cryptographic verification: DSSE signature by the leaf cert, cert chain
  //    to the Sigstore (Fulcio) root via TUF, SCT, Rekor transparency-log
  //    inclusion, and the cert identity (SAN + OIDC issuer) as policy.
  try {
    await sigstore.verify(bundle, {
      certificateIssuer: GHA_ISSUER,
      // @sigstore/verify matches the SAN with String#match -> anchor + escape.
      certificateIdentityURI: `^${escapeRegExp(signerURI)}$`,
    });
  } catch (e) {
    fail(`sigstore signature/identity verification: ${e.code || ''} ${e.message}`);
  }
  console.log('  ok  sigstore bundle signature, certificate chain, tlog, SAN, issuer');

  // 4. Certificate extensions (signed by Fulcio from the OIDC token claims):
  //    these, not the free-form predicate, are the authoritative identity.
  const vm = bundle.verificationMaterial || {};
  const leafB64 = (vm.certificate && vm.certificate.rawBytes)
    || (vm.x509CertificateChain && vm.x509CertificateChain.certificates
      && vm.x509CertificateChain.certificates[0] && vm.x509CertificateChain.certificates[0].rawBytes);
  if (!leafB64) fail('bundle has no signing certificate');
  const cert = X509Certificate.parse(Buffer.from(leafB64, 'base64'));
  expectEq('cert SAN', cert.subjectAltName, signerURI);
  expectEq('cert issuer ext', certExt(cert, OID.issuer), GHA_ISSUER);
  expectEq('cert build signer URI', certExt(cert, OID.buildSignerURI), signerURI);
  expectEq('cert runner environment', certExt(cert, OID.runnerEnvironment), 'github-hosted');
  expectEq('cert source repo URI', certExt(cert, OID.sourceRepoURI), repoURL);
  expectEq('cert source repo id', certExt(cert, OID.sourceRepoIdentifier), repoId);
  expectEq('cert source repo ref', certExt(cert, OID.sourceRepoRef), ref);
  expectEq('cert source repo digest', certExt(cert, OID.sourceRepoDigest), sha);

  // 5. The signed in-toto statement: subject must be exactly this tarball, and
  //    the predicate must agree with the certificate.
  const env_ = bundle.dsseEnvelope;
  expectEq('DSSE payloadType', env_ && env_.payloadType, 'application/vnd.in-toto+json');
  const st = JSON.parse(Buffer.from(env_.payload, 'base64').toString('utf8'));
  expectEq('statement predicateType', st.predicateType, SLSA_V1);
  if (!Array.isArray(st.subject) || st.subject.length !== 1) fail('statement must have exactly 1 subject');
  expectEq('subject name', st.subject[0].name, purl);
  expectEq('subject sha512 == registry dist.integrity', st.subject[0].digest && st.subject[0].digest.sha512, tarballSha512);
  const bd = (st.predicate && st.predicate.buildDefinition) || {};
  const wf = (bd.externalParameters && bd.externalParameters.workflow) || {};
  expectEq('predicate buildType', bd.buildType, GHA_BUILD_TYPE);
  expectEq('predicate workflow.repository', wf.repository, repoURL);
  expectEq('predicate workflow.path', wf.path, wfPath);
  expectEq('predicate workflow.ref', wf.ref, ref);
  const gh = (bd.internalParameters && bd.internalParameters.github) || {};
  expectEq('predicate repository_id', gh.repository_id, repoId);
  const deps = bd.resolvedDependencies || [];
  if (deps.length !== 1) fail(`expected exactly 1 resolvedDependency, found ${deps.length}`);
  expectEq('predicate resolved commit', deps[0].digest && deps[0].digest.gitCommit, sha);
  const rd = (st.predicate && st.predicate.runDetails) || {};
  expectEq('predicate builder.id', rd.builder && rd.builder.id, GHA_BUILDER);

  console.log(`OK: ${name}@${version} has verified provenance from ${signerURI} @ ${sha}`);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
