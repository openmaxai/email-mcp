#!/usr/bin/env node
// Decision logic of the `verify` job in .github/workflows/release.yml,
// extracted so it is unit-testable (release.yml never runs in PR CI; see
// .github/scripts/test/release-verify-decision.test.cjs).
//
// Dependency-free (node built-ins only). No network: the workflow queries
// the registry with npm and passes the raw results in via env.
//
// Why a separate job: `npm publish` can fail AMBIGUOUSLY -- the registry
// accepted the tarball but the client errored / timed out / was cancelled.
// On a first-ever publish the registry then already points `latest` at the
// unverified version. The verify job therefore runs after ANY publish-job
// result (job-level always(), gated only on the plan having produced
// NAME/VERSION) and decides from the REGISTRY, not from the publish outcome.
//
//   presence(s)     -> is NAME@VERSION on the registry?
//                      verify | retry | skip | error
//   afterVerify(s)  -> what to do once provenance verification has run
//                      clear | none | foreign | deprecate | fail | unknown
//
// CLI:  node release-verify-decision.cjs presence|after-verify
//   Reads its inputs from env (see cliPresence / cliAfterVerify), prints a
//   GitHub annotation for the decision followed by a last line
//   `action=<x>`, and exits 0 -- except for the `error` presence action
//   (exit 1) and bad input (exit 2). The workflow step re-prints the
//   annotation, exports `action` as a step output and acts on it.
'use strict';

const isE404 = (out, err) =>
  /code E404/.test(String(err || '')) || /"code":\s*"E404"/.test(String(out || ''));

// s: { version, viewRc, viewOut, viewErr, publishResult, alreadyPublished,
//      attempt, maxAttempts }
//   viewRc/viewOut/viewErr: result of `npm view NAME@VERSION version --json`
//   publishResult: needs.publish.result (success|failure|cancelled|...)
//   alreadyPublished: plan's ALREADY_PUBLISHED (yes|no)
function presence(s) {
  const { version } = s;
  const rc = Number(s.viewRc);
  const attempt = Number(s.attempt || 1);
  const max = Number(s.maxAttempts || 1);
  const publishOk = s.publishResult === 'success';

  if (rc === 0) {
    if (String(s.viewOut || '').trim() === JSON.stringify(version)) {
      return {
        action: 'verify',
        level: 'notice',
        message: publishOk
          ? `${version} is on the registry -> verifying provenance`
          : `${version} is on the registry although the publish job ended '${s.publishResult}' (ambiguous publish: the registry accepted it) -> verifying provenance anyway`,
      };
    }
    return { action: 'error', level: 'error', message: `npm view returned rc=0 but unexpected output '${String(s.viewOut || '').trim()}'; refusing to guess` };
  }
  if (!isE404(s.viewOut, s.viewErr)) {
    // Transient registry errors are retried; after that we cannot tell
    // whether an unverified version is live, so fail loudly.
    if (attempt < max) return { action: 'retry', level: 'info', message: `npm view failed (rc=${rc}, non-404); retrying` };
    return { action: 'error', level: 'error', message: `npm view failed (rc=${rc}) with a non-404 error ${max} times; cannot tell whether ${version} is live UNVERIFIED -- check the registry and re-run this job` };
  }
  // Absent. Registry visibility can lag the publish, also after an
  // ambiguous client failure, so keep looking before concluding.
  if (attempt < max) return { action: 'retry', level: 'info', message: `${version} not visible yet (attempt ${attempt}/${max})` };
  if (publishOk || s.alreadyPublished === 'yes') {
    return { action: 'error', level: 'error', message: `${version} is NOT on the registry although the publish job succeeded (alreadyPublished=${s.alreadyPublished}); nothing can be verified -- investigate` };
  }
  return {
    action: 'skip',
    level: 'notice',
    message: `${version} is not on the registry (publish job ended '${s.publishResult}'): nothing was published, nothing to verify. If it appears later, re-run the workflow: the plan then finds it and verifies it.`,
  };
}

// s: { version, verifyOutcome, stateRc, stateOut, deprecated, marker }
//   verifyOutcome: steps.verify.outcome; only 'success' counts as verified
//     (failure / cancelled -> NOT verified)
//   stateRc/stateOut: `npm view NAME versions dist-tags.latest --json`
//   deprecated: `npm view NAME@VERSION deprecated` (only used when verified)
function afterVerify(s) {
  const { version, marker } = s;
  if (!marker) throw new Error('afterVerify: marker is required');

  if (s.verifyOutcome === 'success') {
    const dep = String(s.deprecated || '').trim();
    if (dep === '') return { action: 'none', level: 'notice', message: `${version} verified; not deprecated` };
    if (dep.startsWith(marker)) return { action: 'clear', level: 'notice', message: `${version} verified; clearing this workflow's provenance-failure deprecation` };
    return { action: 'foreign', level: 'warning', message: `${version} verified but carries a deprecation not set by this workflow; leaving it: ${dep}` };
  }

  // NOT verified. Deprecate only in the registry-forced first-publish
  // situation: VERSION is the package's ONLY version and `latest` points at
  // it (this workflow never moves `latest` before verification, so that can
  // only be the registry's own first-publish tag).
  let o = null;
  if (Number(s.stateRc) === 0) {
    try { o = JSON.parse(String(s.stateOut || '')); } catch { o = null; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { action: 'unknown', level: 'error', message: `${version} did NOT verify and the registry state is unreadable (rc=${s.stateRc}); cannot tell whether it is 'latest' -- check it and deprecate it manually if so` };
  }
  let vs = o.versions;
  vs = Array.isArray(vs) ? vs : (vs ? [vs] : []);
  if (vs.length === 1 && vs[0] === version && o['dist-tags.latest'] === version) {
    return { action: 'deprecate', level: 'error', message: `${version} is the package's FIRST and only version and the registry made it 'latest', but its provenance did NOT verify -> deprecating` };
  }
  return { action: 'fail', level: 'error', message: `${version} did NOT verify; not the first-publish situation (versions=${JSON.stringify(vs)}, latest=${o['dist-tags.latest'] || '<unset>'}): no deprecation, this workflow moves no dist-tag` };
}

function annotate(r) {
  const msg = String(r.message).replace(/\r?\n/g, ' ');
  if (r.level === 'info') console.log(msg);
  else console.log(`::${r.level}::${msg}`);
}

function emit(r) {
  annotate(r);
  console.log(`action=${r.action}`);
}

function need(name) {
  const v = process.env[name];
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

function cliPresence() {
  return presence({
    version: need('VERSION'),
    viewRc: need('VIEW_RC'),
    viewOut: process.env.VIEW_OUT || '',
    viewErr: process.env.VIEW_ERR || '',
    publishResult: need('PUBLISH_RESULT'),
    alreadyPublished: need('ALREADY_PUBLISHED'),
    attempt: process.env.ATTEMPT || '1',
    maxAttempts: process.env.MAX_ATTEMPTS || '1',
  });
}

function cliAfterVerify() {
  return afterVerify({
    version: need('VERSION'),
    verifyOutcome: need('VERIFY_OUTCOME'),
    stateRc: need('STATE_RC'),
    stateOut: process.env.STATE_OUT || '',
    deprecated: process.env.DEPRECATED || '',
    marker: need('DEPRECATE_MARKER'),
  });
}

module.exports = { presence, afterVerify, isE404 };

if (require.main === module) {
  let r;
  try {
    const mode = process.argv[2];
    if (mode === 'presence') r = cliPresence();
    else if (mode === 'after-verify') r = cliAfterVerify();
    else throw new Error(`usage: ${process.argv[1]} presence|after-verify`);
  } catch (e) {
    console.log(`::error::release-verify-decision: ${e && e.message}`);
    process.exit(2);
  }
  emit(r);
  process.exit(r.action === 'error' ? 1 : 0);
}
