'use strict';
// Tests for ../release-verify-decision.cjs (the verify job's decision logic)
// and a static, dependency-free structural check of release.yml's job graph.
//
// Run: node --test .github/scripts/test/*.test.cjs   (no network, no deps)
//
// release.yml never runs in PR CI, so the regression for "an ambiguous
// `npm publish` failure must not skip verification / the first-publish
// deprecation" is covered in two halves:
//   1. the decision functions + CLI the verify job calls, and
//   2. the workflow wiring: verify is its own job with a job-level always()
//      condition after publish, promotion depends on verify having
//      verified, cleanup needs everything, tokens only on writing steps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const D = require('../release-verify-decision.cjs');

const SCRIPT = path.join(__dirname, '..', 'release-verify-decision.cjs');
const WORKFLOW = path.join(__dirname, '..', '..', 'workflows', 'release.yml');
const MARKER = 'UNVERIFIED RELEASE: npm provenance verification failed in release workflow';
const V = '0.1.0';
const E404_ERR = 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@openmaxai%2femail-mcp - Not found';

const present = { version: V, viewRc: 0, viewOut: `"${V}"\n`, viewErr: '' };
const absent = { version: V, viewRc: 1, viewOut: '', viewErr: E404_ERR };
const last = { attempt: 6, maxAttempts: 6 };

// ---------------------------------------------------------------- presence

for (const publishResult of ['failure', 'cancelled', 'success']) {
  test(`presence: publish job '${publishResult}' + version present on registry -> verify runs`, () => {
    const r = D.presence({ ...present, publishResult, alreadyPublished: 'no', attempt: 1, maxAttempts: 6 });
    assert.equal(r.action, 'verify');
    if (publishResult !== 'success') assert.match(r.message, /ambiguous publish/);
  });
}

test('presence: already published (re-run) + present -> verify runs', () => {
  assert.equal(D.presence({ ...present, publishResult: 'success', alreadyPublished: 'yes' }).action, 'verify');
});

test('presence: publish failed + absent (not last attempt) -> retry (registry lag)', () => {
  assert.equal(D.presence({ ...absent, publishResult: 'failure', alreadyPublished: 'no', attempt: 2, maxAttempts: 6 }).action, 'retry');
});

for (const publishResult of ['failure', 'cancelled']) {
  test(`presence: publish '${publishResult}' + absent after all attempts -> skip with report`, () => {
    const r = D.presence({ ...absent, publishResult, alreadyPublished: 'no', ...last });
    assert.equal(r.action, 'skip');
    assert.equal(r.level, 'notice');
    assert.match(r.message, /not on the registry/);
    assert.match(r.message, /re-run/);
  });
}

test('presence: E404 also recognised in --json stdout', () => {
  const r = D.presence({ version: V, viewRc: 1, viewOut: '{"error":{"code": "E404"}}', viewErr: '', publishResult: 'failure', alreadyPublished: 'no', ...last });
  assert.equal(r.action, 'skip');
});

test('presence: publish succeeded but absent after all attempts -> error', () => {
  const r = D.presence({ ...absent, publishResult: 'success', alreadyPublished: 'no', ...last });
  assert.equal(r.action, 'error');
});

test('presence: plan said already published but absent -> error', () => {
  assert.equal(D.presence({ ...absent, publishResult: 'failure', alreadyPublished: 'yes', ...last }).action, 'error');
});

test('presence: non-404 registry error -> retry, then error (never skip)', () => {
  const bad = { version: V, viewRc: 1, viewOut: '', viewErr: 'npm error code ETIMEDOUT', publishResult: 'failure', alreadyPublished: 'no' };
  assert.equal(D.presence({ ...bad, attempt: 1, maxAttempts: 6 }).action, 'retry');
  assert.equal(D.presence({ ...bad, ...last }).action, 'error');
});

test('presence: rc=0 with unexpected output -> error', () => {
  assert.equal(D.presence({ ...present, viewOut: '"0.0.9"', publishResult: 'success', alreadyPublished: 'no' }).action, 'error');
});

// ------------------------------------------------------------- afterVerify

const firstOnly = { stateRc: 0, stateOut: JSON.stringify({ versions: V, 'dist-tags.latest': V }) };
const firstOnlyArr = { stateRc: 0, stateOut: JSON.stringify({ versions: [V], 'dist-tags.latest': V }) };
const nonFirst = { stateRc: 0, stateOut: JSON.stringify({ versions: ['0.0.9', V], 'dist-tags.latest': '0.0.9' }) };

for (const verifyOutcome of ['failure', 'cancelled', 'skipped', '']) {
  test(`afterVerify: verify '${verifyOutcome || '<empty>'}' on first publish (only version, latest on it) -> deprecate`, () => {
    for (const st of [firstOnly, firstOnlyArr]) {
      const r = D.afterVerify({ version: V, verifyOutcome, ...st, marker: MARKER });
      assert.equal(r.action, 'deprecate');
    }
  });
}

test('afterVerify: verify fail on non-first publish -> fail, no deprecate', () => {
  const r = D.afterVerify({ version: V, verifyOutcome: 'failure', ...nonFirst, marker: MARKER });
  assert.equal(r.action, 'fail');
  assert.equal(r.level, 'error');
});

test('afterVerify: verify fail, only version but latest NOT on it -> fail, no deprecate', () => {
  const r = D.afterVerify({ version: V, verifyOutcome: 'failure', stateRc: 0, stateOut: JSON.stringify({ versions: [V] }), marker: MARKER });
  assert.equal(r.action, 'fail');
});

test('afterVerify: verify fail, registry state unreadable -> unknown (loud), not silently skipped', () => {
  for (const st of [{ stateRc: 1, stateOut: '' }, { stateRc: 0, stateOut: 'not json' }, { stateRc: 0, stateOut: '[]' }]) {
    assert.equal(D.afterVerify({ version: V, verifyOutcome: 'failure', ...st, marker: MARKER }).action, 'unknown');
  }
});

test('afterVerify: verify pass + our marker deprecation -> clear', () => {
  const r = D.afterVerify({ version: V, verifyOutcome: 'success', ...firstOnly, deprecated: `${MARKER} run https://x/runs/1. Do not use.`, marker: MARKER });
  assert.equal(r.action, 'clear');
});

test('afterVerify: verify pass, not deprecated -> none (even on first publish)', () => {
  assert.equal(D.afterVerify({ version: V, verifyOutcome: 'success', ...firstOnly, deprecated: '', marker: MARKER }).action, 'none');
});

test('afterVerify: verify pass + foreign deprecation -> foreign (left in place)', () => {
  const r = D.afterVerify({ version: V, verifyOutcome: 'success', ...nonFirst, deprecated: 'use 0.2.0 instead', marker: MARKER });
  assert.equal(r.action, 'foreign');
  assert.equal(r.level, 'warning');
});

test('afterVerify: marker required', () => {
  assert.throws(() => D.afterVerify({ version: V, verifyOutcome: 'success' }), /marker/);
});

// --------------------------------------------------------------------- CLI

function cli(mode, env) {
  const r = spawnSync(process.execPath, [SCRIPT, mode], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const action = (r.stdout.match(/^action=(.*)$/m) || [])[1];
  return { status: r.status, stdout: r.stdout, action };
}

test('CLI presence: publish failed + present -> action=verify, exit 0', () => {
  const r = cli('presence', { VERSION: V, VIEW_RC: '0', VIEW_OUT: `"${V}"`, PUBLISH_RESULT: 'failure', ALREADY_PUBLISHED: 'no' });
  assert.equal(r.status, 0);
  assert.equal(r.action, 'verify');
  assert.match(r.stdout, /^::notice::/m);
});

test('CLI presence: publish failed + absent -> action=skip with ::notice::, exit 0', () => {
  const r = cli('presence', { VERSION: V, VIEW_RC: '1', VIEW_ERR: E404_ERR, PUBLISH_RESULT: 'failure', ALREADY_PUBLISHED: 'no', ATTEMPT: '6', MAX_ATTEMPTS: '6' });
  assert.equal(r.status, 0);
  assert.equal(r.action, 'skip');
  assert.match(r.stdout, /^::notice::.*not on the registry/m);
});

test('CLI presence: error action exits 1', () => {
  const r = cli('presence', { VERSION: V, VIEW_RC: '1', VIEW_ERR: E404_ERR, PUBLISH_RESULT: 'success', ALREADY_PUBLISHED: 'no' });
  assert.equal(r.status, 1);
  assert.equal(r.action, 'error');
});

test('CLI after-verify: first publish + verify failed -> action=deprecate', () => {
  const r = cli('after-verify', { VERSION: V, VERIFY_OUTCOME: 'failure', STATE_RC: '0', STATE_OUT: firstOnly.stateOut, DEPRECATE_MARKER: MARKER });
  assert.equal(r.status, 0);
  assert.equal(r.action, 'deprecate');
});

test('CLI: missing env / bad mode -> exit 2, no action', () => {
  const a = cli('presence', { VERSION: V });
  assert.equal(a.status, 2);
  assert.equal(a.action, undefined);
  assert.equal(cli('bogus', {}).status, 2);
});

test('CLI: the workflow marker env equals the one release.yml defines', () => {
  const m = fs.readFileSync(WORKFLOW, 'utf8').match(/^ {2}DEPRECATE_MARKER: '([^']+)'$/m);
  assert.ok(m, 'DEPRECATE_MARKER not found in release.yml');
  assert.equal(m[1], MARKER);
});

// --------------------------------------------- static release.yml structure
// (full-line comments are ignored by the reader; see workflow-parse.cjs)

const { parseWorkflow, needsOf, runScript } = require('./workflow-parse.cjs');
const wf = parseWorkflow(fs.readFileSync(WORKFLOW, 'utf8'));

test('workflow: job graph is publish -> verify -> promote, cleanup needs all', () => {
  assert.deepEqual(Object.keys(wf).sort(), ['cleanup', 'promote', 'publish', 'verify']);
  assert.deepEqual(needsOf(wf.publish), []);
  assert.deepEqual(needsOf(wf.verify), ['publish']);
  assert.deepEqual(needsOf(wf.promote).sort(), ['publish', 'verify']);
  assert.deepEqual(needsOf(wf.cleanup).sort(), ['promote', 'publish', 'verify']);
});

test('workflow: verify job runs after ANY publish result (job-level always()), gated on the plan', () => {
  const cond = wf.verify.keys.if;
  assert.ok(cond, 'verify job has no job-level if');
  assert.match(cond, /^always\(\) && /);
  assert.match(cond, /needs\.publish\.outputs\.planned == 'yes'/);
  // not gated on the publish succeeding
  assert.doesNotMatch(cond, /needs\.publish\.result/);
  assert.doesNotMatch(cond, /success\(\)/);
  // the plan output it gates on really exists and is written last by the plan step
  assert.match(wf.publish.text, /planned: \$\{\{ steps\.plan\.outputs\.planned \}\}/);
  const plan = wf.publish.steps.find((s) => s.id === 'plan');
  assert.ok(plan);
  const outputsAt = plan.text.indexOf('node "$ENV_WRITER" output name=');
  const plannedAt = plan.text.indexOf('echo "planned=yes" >> "$GITHUB_OUTPUT"');
  assert.ok(outputsAt > 0 && plannedAt > outputsAt, 'planned=yes must be written after the other plan outputs');
  assert.equal(plan.text.slice(plannedAt).split('\n').filter((l) => /GITHUB_(ENV|OUTPUT)/.test(l)).length, 1, 'nothing written after planned=yes');
});

test('workflow: the publish job no longer verifies, deprecates or moves channel tags', () => {
  assert.doesNotMatch(wf.publish.text, /verify-npm-provenance\.cjs|npm deprecate|npm dist-tag add/);
  assert.equal(wf.publish.steps[wf.publish.steps.length - 1].id, 'publish', 'publish must be the last step of the publish job');
});

test('workflow: verify job steps use the decision script and survive a failed verifier', () => {
  const s = Object.fromEntries(wf.verify.steps.filter((x) => x.id).map((x) => [x.id, x]));
  assert.match(s.presence.text, /release-verify-decision\.cjs" presence/);
  assert.equal(s.verify.if, "always() && steps.presence.outputs.action == 'verify'");
  assert.match(s.verify.text, /verify-npm-provenance\.cjs/);
  assert.match(s.after.if, /^always\(\) && steps\.presence\.outputs\.action == 'verify'$/);
  assert.match(s.after.text, /release-verify-decision\.cjs" after-verify/);
  assert.match(s.after.text, /VERIFY_OUTCOME: \$\{\{ steps\.verify\.outcome \}\}/);
  const dep = wf.verify.steps.find((x) => /npm deprecate "\$NAME@\$VERSION" "\$MSG"/.test(x.text));
  assert.ok(dep, 'no deprecate step');
  assert.equal(dep.if, "always() && steps.after.outputs.action == 'deprecate'");
  // the old, suppressible condition must be gone
  assert.doesNotMatch(fs.readFileSync(WORKFLOW, 'utf8'), /steps\.verify\.outcome == 'failure'/);
  const clear = wf.verify.steps.find((x) => /npm deprecate "\$NAME@\$VERSION" ""/.test(x.text));
  assert.ok(clear, 'no clear-marker step');
  assert.match(clear.if, /^success\(\) && steps\.verify\.outcome == 'success' && steps\.after\.outputs\.action == 'clear'$/);
  assert.match(wf.verify.text, /provenance: \$\{\{ steps\.verify\.outcome \}\}/);
});

test('workflow: promotion depends on verify having verified provenance (no always())', () => {
  const cond = wf.promote.keys.if;
  assert.match(cond, /needs\.publish\.result == 'success'/);
  assert.match(cond, /needs\.verify\.result == 'success'/);
  assert.match(cond, /needs\.verify\.outputs\.provenance == 'success'/);
  assert.doesNotMatch(cond, /always\(\)|\|\||!/);
  // dist-tag add happens ONLY in promote
  for (const [name, j] of Object.entries(wf)) {
    if (name !== 'promote') assert.doesNotMatch(j.text, /npm dist-tag add/, `${name} must not move dist-tags`);
  }
  assert.match(wf.promote.text, /npm dist-tag add/);
  assert.ok(!wf.promote.steps.some((x) => /actions\/checkout/.test(x.text)), 'promote must not check out project code');
});

test('workflow: cleanup runs after everything with always()', () => {
  assert.equal(wf.cleanup.keys.if, 'always()');
});

test('workflow: verify + cleanup steps run in a job started after a cancel (explicit always() chains)', () => {
  // A step's implicit success() is false after a run cancel; every step the
  // mitigation / cleanup depends on must therefore say always() itself and
  // chain on its predecessor. Only the clear-marker convenience keeps success().
  for (const job of ['verify', 'cleanup']) {
    const steps = wf[job].steps;
    assert.equal(steps[0].if, 'always()', `${job}: first step`);
    for (const st of steps.slice(1)) {
      if (job === 'verify' && /Clear this workflow/.test(st.name)) {
        assert.match(st.if, /^success\(\) && /);
        continue;
      }
      assert.match(st.if, /^always\(\) && steps\.[a-z]+\.(outcome == 'success'|outputs\.[a-z]+ == '[a-z]+')$/, `${job}: ${st.name}`);
    }
  }
  // promote must NOT run after a cancel / failure
  for (const st of wf.promote.steps) assert.doesNotMatch(st.if || '', /always\(\)/);
});

test('workflow: environment release ONLY on publish (one approval); NODE_AUTH_TOKEN only on writing steps', () => {
  assert.deepEqual(Object.keys(wf).sort(), ['cleanup', 'promote', 'publish', 'verify']);
  assert.equal(wf.publish.keys.environment, 'release', 'publish environment');
  // Downstream jobs must not have an environment: with required reviewers
  // each would need its own approval and could sit silently in `waiting`.
  for (const name of ['verify', 'promote', 'cleanup']) {
    assert.equal(wf[name].keys.environment, undefined, `${name} must have no environment`);
    assert.doesNotMatch(wf[name].text, /^\s*environment:/m, `${name} must have no environment`);
  }
  const withToken = Object.values(wf).flatMap((j) => j.steps.filter((s) => s.token).map((s) => `${j.name}: ${s.name}`));
  assert.deepEqual(withToken.sort(), [
    'cleanup: Remove holding dist-tag',
    'promote: Move dist-tags (monotonic guard)',
    'publish: Publish to npm (under holding dist-tag)',
    "verify: Clear this workflow's provenance-failure deprecation",
    'verify: Deprecate unverified first release (registry-forced latest)',
  ].sort());
  for (const j of Object.values(wf)) assert.doesNotMatch(j.keys.env || '', /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(fs.readFileSync(WORKFLOW, 'utf8'), /^ {4}env:\n(?: {6}.*\n)*? {6}NODE_AUTH_TOKEN/m);
});

test('workflow: concurrency queue + monotonic guard + EXPECTED_SHA normalisation still present', () => {
  const t = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(t, /^concurrency:\n {2}group: release-\$\{\{ github\.repository \}\}\n {2}cancel-in-progress: false\n {2}queue: max$/m);
  assert.match(wf.publish.text, /git rev-parse --verify "\$\{GITHUB_REF\}\^\{commit\}"/);
  assert.match(wf.publish.text, /expected_sha: \$\{\{ steps\.gate\.outputs\.expected_sha \}\}/);
  assert.match(wf.verify.text, /HEAD_SHA" != "\$EXPECTED_SHA"/);
  assert.match(wf.promote.text, /s\.gt\(v,c\)/);
});

// Timeout budget: a job whose step timeouts add up to (or past) its own
// timeout-minutes can be killed by the job timeout before its last steps
// (e.g. verify's first-publish deprecate fallback) get to run. Conservative
// bound: the sum of ALL step timeouts (not just the worst real path) plus a
// margin must fit inside the job timeout, and every step must carry its own.
const TIMEOUT_MARGIN_MIN = 3;
const stepTimeout = (s) => {
  const m = s.text.match(/^ {8}timeout-minutes:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
};

test('workflow: every job has timeout-minutes >= sum(step timeouts) + margin', () => {
  const budgets = {};
  for (const j of Object.values(wf)) {
    const jobTimeout = Number(j.keys['timeout-minutes']);
    assert.ok(Number.isInteger(jobTimeout) && jobTimeout > 0, `${j.name}: no job-level timeout-minutes`);
    assert.ok(j.steps.length > 0, `${j.name}: no steps parsed`);
    let sum = 0;
    for (const s of j.steps) {
      const t = stepTimeout(s);
      assert.ok(t !== null && t > 0, `${j.name} / ${s.name || s.id}: step has no timeout-minutes`);
      sum += t;
    }
    budgets[j.name] = { sum, jobTimeout };
    assert.ok(
      sum + TIMEOUT_MARGIN_MIN <= jobTimeout,
      `${j.name}: step timeouts sum to ${sum} min; job timeout-minutes ${jobTimeout} leaves < ${TIMEOUT_MARGIN_MIN} min margin`,
    );
  }
  // The parser must actually have seen the four release jobs.
  assert.deepEqual(Object.keys(budgets).sort(), ['cleanup', 'promote', 'publish', 'verify']);
});

test('workflow: verify logs dist-tags after publish, read-only and non-fatal', () => {
  const st = wf.verify.steps.find((x) => x.id === 'disttags');
  assert.ok(st, 'no dist-tags observation step in verify');
  const ids = wf.verify.steps.map((x) => x.id);
  assert.ok(ids.indexOf('presence') < ids.indexOf('disttags') && ids.indexOf('disttags') < ids.indexOf('verify'),
    'dist-tags must be logged after the presence check and before provenance verification');
  assert.equal(st.if, "always() && steps.presence.outputs.action == 'verify'");
  assert.equal(st.token, false, 'observation step must not reference NODE_AUTH_TOKEN');
  assert.doesNotMatch(st.text, /NPM_TOKEN|secrets\./);
  assert.match(st.text, /^ {8}continue-on-error: true$/m);
  assert.match(st.text, /npm view "\$NAME" dist-tags --json/);
  assert.match(st.text, /JSON\.stringify\(JSON\.parse\(out\)\)/);
  assert.match(st.text, /package not visible yet/);
  assert.doesNotMatch(st.text, /npm (dist-tag|deprecate|publish|unpublish)/);
});

// ------------------ behavioural: dist-tags observation cannot inject commands
// The step's `run:` script is extracted from release.yml and executed the way
// the runner does (`bash -e`, the default shell) with a fake `npm` on PATH
// that replays hostile output. The runner parses stdout line by line (CR, LF
// or CRLF) and URL-decodes %25 / %0D / %0A inside a command's message, so a
// safe step prints EXACTLY ONE line, it is the step's own ::notice:: /
// ::warning::, and its decoded message still contains no CR / LF.

const os = require('node:os');

function runDisttags({ rc, out, err }) {
  const st = wf.verify.steps.find((x) => x.id === 'disttags');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disttags-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(dir, 'npm-cwd'));
    fs.writeFileSync(path.join(dir, 'out'), out);
    fs.writeFileSync(path.join(dir, 'err'), err);
    fs.writeFileSync(path.join(bin, 'npm'),
      '#!/bin/bash\nprintf "%s\\n" "$*" >> "$FAKE_DIR/argv"\ncat "$FAKE_DIR/out"\ncat "$FAKE_DIR/err" >&2\nexit "$FAKE_RC"\n',
      { mode: 0o755 });
    const script = path.join(dir, 'step.sh');
    fs.writeFileSync(script, runScript(st));
    const r = spawnSync('bash', ['-e', script], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`, HOME: dir, FAKE_DIR: dir, FAKE_RC: String(rc),
        NPM_CWD: path.join(dir, 'npm-cwd'), RUNNER_TEMP: dir, NAME: '@openmaxai/email-mcp',
      },
    });
    return { status: r.status, stdout: r.stdout, argv: fs.readFileSync(path.join(dir, 'argv'), 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Workflow-command message decoding as the runner does it.
const decodeCmd = (s) => s.replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%25/g, '%');

function assertOneSafeLine(res, kind) {
  assert.equal(res.status, 0, 'observation step must exit 0');
  assert.equal(res.argv, 'view @openmaxai/email-mcp dist-tags --json --prefer-online\n');
  const lines = res.stdout.split(/\r\n|\r|\n/).filter((l) => l !== '');
  assert.equal(lines.length, 1, `expected exactly one output line, got ${JSON.stringify(res.stdout)}`);
  const m = lines[0].match(/^::(notice|warning)::(.*)$/s);
  assert.ok(m, `line is not the step's own ::notice:: / ::warning:: -- ${JSON.stringify(lines[0])}`);
  assert.equal(m[1], kind);
  assert.doesNotMatch(m[2], /::/, 'message must not contain a workflow-command marker');
  assert.doesNotMatch(decodeCmd(m[2]), /[\r\n]/, 'decoded message must stay a single line');
  return m[2];
}

const HOSTILE = [
  'npm warn something',
  '::error::injected-lf',
  'x\r::error::injected-cr',
  'y\r\n::warning::injected-crlf',
  'literal %0A::error::injected-pct-lf and %0D::error::pct-cr and %25',
  'sep ::error::injected-u2028 ::error::u2029',
  '::add-mask::x',
  '::stop-commands::tok',
  '',
].join('\n');

test('workflow: dist-tags observation, npm exit 0 with hostile non-JSON -> one safe ::notice:: line', () => {
  const msg = assertOneSafeLine(runDisttags({ rc: 0, out: HOSTILE, err: HOSTILE }), 'notice');
  assert.match(msg, /^dist-tags after publish: <non-JSON: "/);
  assert.match(msg, /injected-u2028/, 'the untrusted text is shown (escaped), not dropped');
});

test('workflow: dist-tags observation, npm exit 0 with JSON -> re-serialised one-line ::notice::', () => {
  const out = '{\n  "latest": "0.1.0",\n  "evil": "a\\n::error::b%0A::error::c"\n}\n';
  const msg = assertOneSafeLine(runDisttags({ rc: 0, out, err: '' }), 'notice');
  assert.match(msg, /^dist-tags after publish: \{"latest":"0\.1\.0","evil":/);
});

test('workflow: dist-tags observation, npm non-zero with hostile stdout/stderr -> one safe ::warning:: line', () => {
  for (const rc of [1, 2, 127]) {
    const msg = assertOneSafeLine(runDisttags({ rc, out: HOSTILE, err: HOSTILE }), 'warning');
    assert.equal(msg, `dist-tags after publish: npm view failed (rc=${rc})`);
  }
});

test('workflow: dist-tags observation, npm E404 -> one ::notice:: line', () => {
  for (const [out, err] of [['', `${E404_ERR}\n::error::x\n`], ['{\n  "error": {\n    "code": "E404"\n  }\n}\n::error::y\n', '']]) {
    const msg = assertOneSafeLine(runDisttags({ rc: 1, out, err }), 'notice');
    assert.equal(msg, 'dist-tags after publish: package not visible yet (E404)');
  }
});

test('workflow: dist-tags observation keeps its escaping calls (static)', () => {
  const sc = runScript(wf.verify.steps.find((x) => x.id === 'disttags'));
  // esc(): cap, break `::`, and workflow-command-escape % CR LF (% first)
  assert.match(sc, /const esc = \(s\) => String\(s\)\.slice\(0, 2000\)\.replace\(\/::\/g, ": :"\)\s*\.replace\(\/%\/g, "%25"\)\.replace\(\/\\r\/g, "%0D"\)\.replace\(\/\\n\/g, "%0A"\);/);
  // the only untrusted value logged goes through esc(); the non-JSON fallback is JSON-quoted
  assert.match(sc, /console\.log\("::notice::dist-tags after publish: " \+ esc\(line\)\);/);
  assert.match(sc, /catch \{ line = "<non-JSON: " \+ JSON\.stringify\(out\) \+ ">"; \}/);
  assert.match(sc, /"::warning::dist-tags after publish: npm view failed \(rc=" \+ esc\(rc\) \+ "\)"/);
  // npm's exit status must be captured, not fatal under the runner's `bash -e`
  assert.match(sc, /^TAGS_RC=0$/m);
  assert.match(sc, /^TAGS_OUT="\$\(npm view [^\n]*\)" \|\| TAGS_RC=\$\?$/m);
});
