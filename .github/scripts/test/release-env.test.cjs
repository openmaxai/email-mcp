'use strict';
// GITHUB_ENV / GITHUB_OUTPUT injection hardening of release.yml.
//
// $GITHUB_ENV and $GITHUB_OUTPUT are line-oriented KEY=VALUE files, so a
// value with "\n" / "\r" (e.g. a package.json version
// "9.9.9\nnpm_config_registry=http://evil") injects variables into every
// later step. Covered here:
//   1. ../release-env.cjs (the validating writer used by publish + verify):
//      full-string patterns, line breaks rejected, all-or-nothing writes.
//   2. The cleanup job (no checkout, never reads the tag tree): its real
//      `run:` scripts are extracted from release.yml and chained under bash
//      with a fake npm, fake $GITHUB_ENV / $GITHUB_OUTPUT and valid /
//      missing / hostile publish-job VERSION outputs.
//   3. A static check that every variable write in release.yml goes through
//      the writer (or is a constant).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const W = require('../release-env.cjs');
const { parseWorkflow, runScript, WORKFLOW } = require('./workflow-parse.cjs');

const WRITER = path.join(__dirname, '..', 'release-env.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'release-env-'));

const HOSTILE_VERSIONS = [
  '9.9.9\nnpm_config_registry=http://evil',
  '9.9.9\r\nNODE_OPTIONS=--require=/tmp/x.js',
  '9.9.9\rnpm_config_registry=http://evil',
  '9.9.9\n',
  '\n9.9.9',
  '9.9.9 ',
  '9.9.9;id',
  '9.9.9-a$b',
  '9.9.9+build',
  '09.9.9',
  '9.9',
  '',
];

// ------------------------------------------------------------------ writer

test('writer: valid values pass', () => {
  assert.equal(W.format(['VERSION=0.1.0', 'NAME=@openmaxai/email-mcp']), 'VERSION=0.1.0\nNAME=@openmaxai/email-mcp\n');
  assert.equal(W.format(['version=0.1.0-alpha.3']), 'version=0.1.0-alpha.3\n');
  assert.equal(W.format(['expected_sha=' + 'a'.repeat(40), 'channel=alpha', 'planned=yes', 'action=deprecate']).split('\n').length, 5);
  assert.equal(W.format(['NPM_CWD=/home/runner/work/_temp/npm-cwd']), 'NPM_CWD=/home/runner/work/_temp/npm-cwd\n');
});

for (const v of HOSTILE_VERSIONS) {
  test(`writer: hostile version ${JSON.stringify(v)} rejected`, () => {
    for (const k of ['VERSION', 'version']) assert.throws(() => W.format([`${k}=${v}`]), W.EnvValueError);
  });
}

test('writer: hostile values rejected for every key', () => {
  for (const k of Object.keys(W.RULES)) {
    assert.throws(() => W.format([`${k}=x\ny=z`]), W.EnvValueError, k);
    assert.throws(() => W.format([`${k}=x\rz`]), W.EnvValueError, k);
  }
  assert.throws(() => W.format(['NAME=@openmaxai/email-mcp\nnpm_config_registry=http://evil']), W.EnvValueError);
  assert.throws(() => W.format(['NAME=Evil Name']), W.EnvValueError);
  assert.throws(() => W.format(['EXPECTED_SHA=' + 'A'.repeat(40)]), W.EnvValueError);
  assert.throws(() => W.format(['NPM_CWD=relative/dir']), W.EnvValueError);
  assert.throws(() => W.format(['NPM_CWD=/tmp/a b']), W.EnvValueError);
  assert.throws(() => W.format(['channel=next']), W.EnvValueError);
  assert.throws(() => W.format(['planned=no']), W.EnvValueError);
});

test('writer: unknown / malformed / duplicate keys rejected', () => {
  assert.throws(() => W.format(['NODE_OPTIONS=--x']), /unknown key/);
  assert.throws(() => W.format(['npm_config_registry=http://evil']), /unknown key/);
  assert.throws(() => W.format(['=1']), /not KEY=VALUE/);
  assert.throws(() => W.format(['VERSION']), /not KEY=VALUE/);
  assert.throws(() => W.format(['VERSION=1.0.0', 'VERSION=2.0.0']), /duplicate/);
  assert.throws(() => W.format([]), /no KEY=VALUE/);
});

function writerCli(args, extraEnv = {}) {
  const dir = tmp();
  const envFile = path.join(dir, 'env');
  const outFile = path.join(dir, 'out');
  fs.writeFileSync(envFile, '');
  fs.writeFileSync(outFile, '');
  const r = spawnSync(process.execPath, [WRITER, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_ENV: envFile, GITHUB_OUTPUT: outFile, ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout, env: fs.readFileSync(envFile, 'utf8'), out: fs.readFileSync(outFile, 'utf8') };
}

test('writer CLI: writes validated pairs to GITHUB_ENV / GITHUB_OUTPUT', () => {
  const a = writerCli(['env', 'NAME=@openmaxai/email-mcp', 'VERSION=0.1.0']);
  assert.equal(a.status, 0, a.stdout);
  assert.equal(a.env, 'NAME=@openmaxai/email-mcp\nVERSION=0.1.0\n');
  assert.equal(a.out, '');
  const b = writerCli(['output', 'action=verify']);
  assert.equal(b.status, 0, b.stdout);
  assert.equal(b.out, 'action=verify\n');
  const c = writerCli(['check', 'VERSION=0.1.0']);
  assert.equal(c.status, 0);
  assert.equal(c.env + c.out, '');
});

test('writer CLI: one hostile value -> exit 1 and NOTHING appended (all or nothing)', () => {
  for (const v of HOSTILE_VERSIONS) {
    for (const mode of ['env', 'output', 'check']) {
      const r = writerCli([mode, 'NAME=@openmaxai/email-mcp', `VERSION=${v}`]);
      assert.equal(r.status, 1, `${mode} ${JSON.stringify(v)}`);
      assert.match(r.stdout, /^::error::release-env: refusing to write/);
      // the annotation itself must stay on ONE line (no workflow-command injection)
      assert.equal(r.stdout.trimEnd().split('\n').length, 1, r.stdout);
      assert.equal(r.env, '', `GITHUB_ENV touched for ${JSON.stringify(v)}`);
      assert.equal(r.out, '', `GITHUB_OUTPUT touched for ${JSON.stringify(v)}`);
    }
  }
});

test('writer CLI: missing target file / bad mode -> exit 1', () => {
  const r = spawnSync(process.execPath, [WRITER, 'env', 'VERSION=0.1.0'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.equal(writerCli(['bogus', 'VERSION=0.1.0']).status, 1);
});

// ------------------ cleanup job (real step scripts, fake npm, fake files)
//
// cleanup has NO checkout and never reads the tagged tree: NAME is the
// workflow constant, VERSION comes only from the publish job's outputs and
// is re-validated whole-string by the meta step. Missing / invalid outputs
// -> the holding tag is removed version-independently and the job goes red.
// The real `run:` scripts are extracted from release.yml and chained here
// with the step `if:` conditions they carry (asserted below).

const wf = parseWorkflow(fs.readFileSync(WORKFLOW, 'utf8'));
const cstep = (re) => {
  const st = wf.cleanup.steps.find((x) => re.test(x.name) || re.test(x.id));
  assert.ok(st, `cleanup step ${re}`);
  return st;
};
const C = {
  meta: cstep(/^meta$/),
  inspect: cstep(/^inspect$/),
  remove: cstep(/^Remove holding dist-tag$/),
  report: cstep(/^Fail if the version was unknown or invalid$/),
};

const FAKE_NPM = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [ "$1" = view ]; then
  if [ -n "\${FAKE_E404:-}" ]; then echo "npm error code E404" >&2; exit 1; fi
  printf '%s' "$FAKE_TAGS"; exit 0
fi
if [ "$1" = dist-tag ] && [ "$2" = rm ]; then exit 0; fi
exit 99
`;

const readKv = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
  const i = l.indexOf('=');
  return [l.slice(0, i), l.slice(i + 1)];
}));

// Runs meta -> inspect -> remove -> report as the runner would (each step
// gets its own GITHUB_OUTPUT; GITHUB_ENV is shared and must stay EMPTY).
function runCleanup({ version, planned = 'yes', tags = {}, e404 = false }) {
  const dir = tmp();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'runner-temp'));
  const envFile = path.join(dir, 'github_env');
  fs.writeFileSync(envFile, '');
  const npmLog = path.join(dir, 'npm.log');
  fs.writeFileSync(npmLog, '');
  const base = {
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_ENV: envFile,
    RUNNER_TEMP: path.join(dir, 'runner-temp'),
    EXPECT_NAME: '@openmaxai/email-mcp',
    HOLD_TAG: 'publish-staging',
    PUB_VERSION: version,
    PUB_PLANNED: planned,
    FAKE_TAGS: JSON.stringify(tags),
    FAKE_NPM_LOG: npmLog,
    ...(e404 ? { FAKE_E404: '1' } : {}),
  };
  const run = (key, extra = {}) => {
    const out = path.join(dir, `out-${key}`);
    fs.writeFileSync(out, '');
    const script = path.join(dir, `${key}.sh`);
    fs.writeFileSync(script, runScript(C[key]));
    const r = spawnSync('bash', ['-e', script], {
      encoding: 'utf8',
      env: { ...base, GITHUB_OUTPUT: out, PUBLISH_RESULT: 'x', VERIFY_RESULT: 'x', PROMOTE_RESULT: 'x', ...extra },
    });
    return { status: r.status, log: r.stdout + r.stderr, out: readKv(out), raw: fs.readFileSync(out, 'utf8') };
  };
  const res = {};
  res.meta = run('meta');
  if (res.meta.status === 0) res.inspect = run('inspect', { KNOWN: res.meta.out.known || '' });
  if (res.inspect && res.inspect.out.action === 'remove') res.remove = run('remove', { NODE_AUTH_TOKEN: 'fake' });
  if (res.meta.out.known === 'no') {
    res.report = run('report', { INVALID: res.meta.out.invalid || '', ACTION: (res.inspect && res.inspect.out.action) || '' });
  }
  res.env = fs.readFileSync(envFile, 'utf8');
  res.npm = fs.readFileSync(npmLog, 'utf8');
  res.rm = /^dist-tag rm @openmaxai\/email-mcp publish-staging$/m.test(res.npm);
  return res;
}

test('cleanup step conditions are the ones the harness simulates', () => {
  assert.equal(C.inspect.if, "always() && steps.meta.outcome == 'success'");
  assert.equal(C.remove.if, "always() && steps.inspect.outputs.action == 'remove'");
  assert.equal(C.report.if, "always() && steps.meta.outputs.known == 'no'");
  assert.match(wf.cleanup.text, /^ {6}PUB_VERSION: \$\{\{ needs\.publish\.outputs\.version \}\}$/m);
  assert.match(wf.cleanup.text, /^ {6}PUB_PLANNED: \$\{\{ needs\.publish\.outputs\.planned \}\}$/m);
  assert.match(C.inspect.text, /KNOWN: \$\{\{ steps\.meta\.outputs\.known \}\}/);
  assert.match(C.report.text, /INVALID: \$\{\{ steps\.meta\.outputs\.invalid \}\}/);
  assert.match(C.report.text, /ACTION: \$\{\{ steps\.inspect\.outputs\.action \}\}/);
});

test('cleanup: valid version, holding tag -> this version: removed, green, nothing in GITHUB_ENV', () => {
  for (const v of ['0.1.0', '0.2.0-alpha.1']) {
    const r = runCleanup({ version: v, tags: { latest: '0.0.9', 'publish-staging': v } });
    assert.equal(r.meta.status, 0, r.meta.log);
    assert.equal(r.meta.raw, 'known=yes\n');
    assert.equal(r.inspect.out.action, 'remove');
    assert.equal(r.remove.status, 0, r.remove.log);
    assert.ok(r.rm);
    assert.equal(r.report, undefined);
    assert.equal(r.env, '');
  }
});

test('cleanup: valid version, holding tag -> other version: left in place (foreign)', () => {
  const r = runCleanup({ version: '0.1.0', tags: { 'publish-staging': '0.0.5' } });
  assert.equal(r.inspect.out.action, 'foreign');
  assert.equal(r.rm, false);
  assert.equal(r.env, '');
});

test('cleanup: package not on the registry -> nothing to do', () => {
  const r = runCleanup({ version: '0.1.0', e404: true });
  assert.equal(r.inspect.out.action, 'none');
  assert.equal(r.rm, false);
});

for (const [label, version, planned] of [
  ['no outputs at all', '', ''],
  ['version but planned missing', '0.1.0', ''],
  ['planned but version empty', '', 'yes'],
]) {
  test(`cleanup: missing outputs (${label}) + holding tag -> removed version-independently, job RED`, () => {
    const r = runCleanup({ version, planned, tags: { latest: '0.0.9', 'publish-staging': '7.7.7' } });
    assert.equal(r.meta.status, 0, r.meta.log);
    assert.equal(r.meta.raw, 'known=no\n');
    assert.equal(r.inspect.out.action, 'remove');
    assert.ok(r.rm, r.npm);
    assert.notEqual(r.report.status, 0);
    assert.match(r.report.log, /::error::version unknown/);
    assert.equal(r.env, '');
  });
  test(`cleanup: missing outputs (${label}), no holding tag -> nothing removed, not red`, () => {
    const r = runCleanup({ version, planned, tags: { latest: '0.0.9' } });
    assert.equal(r.inspect.out.action, 'none');
    assert.equal(r.rm, false);
    assert.equal(r.report.status, 0, r.report.log);
    assert.equal(r.env, '');
  });
}

// Hostile publish outputs (the outputs are produced by the validating writer,
// so these can only arrive through a bug -- still: reject, never write, red).
// NUL cannot be carried by an environment variable at all (the JS check still
// rejects it; asserted statically below).
const HOSTILE_OUTPUTS = [
  ...HOSTILE_VERSIONS.filter((v) => v !== ''),
  '9.9.9\u2028npm_config_registry=http://evil',
  '9.9.9\u2029',
  '9.9.9=1',
  '9.9.9<<EOF',
  'VERSION<<EOF\nevil\nEOF',
  `1.0.0-${'a'.repeat(100)}`,
  '9.9.9\t',
  '\u0669.9.9',
];
for (const v of HOSTILE_OUTPUTS) {
  test(`cleanup: hostile publish output ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v)} -> rejected, only constants written, RED`, () => {
    for (const tags of [{ 'publish-staging': '7.7.7' }, {}]) {
      const r = runCleanup({ version: v, tags });
      assert.equal(r.meta.status, 0, r.meta.log);
      assert.equal(r.meta.raw, 'known=no\ninvalid=yes\n');
      assert.match(r.meta.log, /::error::publish output version .* REJECTED/);
      assert.doesNotMatch(r.meta.log, /[\r\u2028\u2029]|npm_config_registry=|evil\n/);
      assert.equal(r.rm, 'publish-staging' in tags);
      assert.notEqual(r.report.status, 0, 'report step must fail');
      assert.match(r.report.log, /::error::.*INVALID/);
      assert.equal(r.env, '', 'GITHUB_ENV must stay empty');
      for (const k of ['inspect', 'remove', 'report']) {
        if (r[k]) assert.match(r[k].raw, /^(action=(none|remove|foreign)\n)?$/, `${k} output`);
      }
    }
  });
}

test('cleanup: no checkout, never reads package.json / the tag tree, never writes GITHUB_ENV', () => {
  const t = wf.cleanup.text;
  assert.doesNotMatch(t, /actions\/checkout/);
  assert.doesNotMatch(t, /package\.json|GITHUB_WORKSPACE|GITHUB_REF/);
  assert.doesNotMatch(t, /GITHUB_ENV/);
  assert.doesNotMatch(t, /\.github\/scripts|ENV_WRITER/);
  // NAME is the workflow constant, VERSION only from the validated output
  for (const st of [C.inspect, C.remove]) assert.match(runScript(st), /^NAME="\$EXPECT_NAME"$/m);
  const sc = runScript(C.meta);
  assert.match(sc, /\/\[\\0\\r\\n\\u2028\\u2029\]\/\.test\(v\)/);
  assert.match(sc, /v\.length <= 64/);
  assert.match(sc, /\/\^\[0-9A-Za-z\.-\]\+\$\/\.test\(v\)/);
  assert.doesNotMatch(sc, /grep -E/);
});

// --------------------------- static: every variable write is validated

test('workflow: every $GITHUB_ENV / $GITHUB_OUTPUT write is validated or constant', () => {
  const offenders = [];
  for (const j of Object.values(wf)) {
    for (const s of j.steps) {
      for (const line of s.text.split('\n')) {
        if (!/GITHUB_(ENV|OUTPUT)/.test(line)) continue;
        if (/^\s*(run|env|if|name|id|[A-Z_]+):/.test(line) && !/>>/.test(line)) continue;
        // (a) validating writer (script from the vetted checkout)
        if (/node "\$(ENV_WRITER|SCRIPTS\/release-env\.cjs)" (env|output|check) /.test(line)) continue;
        // (b) constant: echo "key=literal" >> "$GITHUB_OUTPUT|ENV"
        if (/^\s*(.*; )?(if .*then )?echo "[a-z_]+=[a-z0-9_-]*" >> "\$GITHUB_(OUTPUT|ENV)"(; (exit 0|else echo "[a-z_]+=[a-z0-9_-]*" >> "\$GITHUB_OUTPUT"; fi))?$/.test(line)) continue;
        offenders.push(`${j.name} / ${s.name || s.id}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
  // no brace-group / heredoc bulk writes, and no bare variable echo
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  assert.doesNotMatch(text, /\}\s*>>\s*"\$GITHUB_(ENV|OUTPUT)"/);
  assert.doesNotMatch(text, /echo "[A-Za-z_]+=\$/);
});

test('workflow: the old line-oriented version check is gone everywhere', () => {
  assert.doesNotMatch(fs.readFileSync(WORKFLOW, 'utf8'), /grep -Eq '\^\[0-9\]\+/);
});
