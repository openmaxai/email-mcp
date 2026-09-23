'use strict';
// GITHUB_ENV / GITHUB_OUTPUT injection hardening of release.yml.
//
// $GITHUB_ENV and $GITHUB_OUTPUT are line-oriented KEY=VALUE files, so a
// value with "\n" / "\r" (e.g. a package.json version
// "9.9.9\nnpm_config_registry=http://evil") injects variables into every
// later step. Covered here:
//   1. ../release-env.cjs (the validating writer used by publish + verify):
//      full-string patterns, line breaks rejected, all-or-nothing writes.
//   2. The cleanup job's INLINE validation (it runs on an unvetted checkout,
//      so it cannot use the repo script): its real `run:` script is
//      extracted from release.yml and executed under bash with a fake
//      $GITHUB_ENV and hostile package.json files.
//   3. A static check that every variable write in release.yml goes through
//      the writer (or is the cleanup inline writer / a constant).

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

// ------------------------------------ cleanup job's inline validation (real)

const wf = parseWorkflow(fs.readFileSync(WORKFLOW, 'utf8'));
const cleanupMeta = wf.cleanup.steps.find((s) => s.id === 'meta');

function runCleanupMeta({ name = '@openmaxai/email-mcp', version, rawPackageJson, ref = 'v0.1.0' }) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'ws', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runner-temp'));
  const pj = rawPackageJson !== undefined ? rawPackageJson : JSON.stringify({ name, version });
  fs.writeFileSync(path.join(dir, 'ws', 'src', 'package.json'), pj);
  const envFile = path.join(dir, 'github_env');
  fs.writeFileSync(envFile, '');
  const scriptFile = path.join(dir, 'meta.sh');
  fs.writeFileSync(scriptFile, runScript(cleanupMeta));
  const r = spawnSync('bash', ['-e', scriptFile], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_WORKSPACE: path.join(dir, 'ws'),
      GITHUB_ENV: envFile,
      RUNNER_TEMP: path.join(dir, 'runner-temp'),
      GITHUB_REF_NAME: ref,
      EXPECT_NAME: '@openmaxai/email-mcp',
      PUBLISH_RESULT: 'failure', VERIFY_RESULT: 'skipped', PROMOTE_RESULT: 'skipped',
    },
  });
  return { status: r.status, out: r.stdout + r.stderr, env: fs.readFileSync(envFile, 'utf8'), dir };
}

test('cleanup meta (real script from release.yml): valid package.json -> exactly NAME/VERSION/NPM_CWD', () => {
  const r = runCleanupMeta({ version: '0.1.0' });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.env, `NAME=@openmaxai/email-mcp\nVERSION=0.1.0\nNPM_CWD=${path.join(r.dir, 'runner-temp')}/npm-cwd\n`);
  const p = runCleanupMeta({ version: '0.2.0-alpha.1', ref: 'v0.2.0-alpha.1' });
  assert.equal(p.status, 0, p.out);
});

for (const v of HOSTILE_VERSIONS) {
  test(`cleanup meta: hostile version ${JSON.stringify(v)} -> fails, nothing appended to GITHUB_ENV`, () => {
    // ref = the hostile version too, so ONLY the format check can stop it
    const r = runCleanupMeta({ version: v, ref: `v${v}` });
    assert.notEqual(r.status, 0, r.out);
    assert.equal(r.env, '');
    assert.match(r.out, /::error::package\.json version/);
  });
}

test('cleanup meta: non-string / multi-line name, wrong name, bad JSON -> fails, nothing appended', () => {
  for (const pj of [
    JSON.stringify({ name: '@openmaxai/email-mcp\nnpm_config_registry=http://evil', version: '0.1.0' }),
    JSON.stringify({ name: 'left-pad', version: '0.1.0' }),
    JSON.stringify({ name: ['@openmaxai/email-mcp'], version: '0.1.0' }),
    JSON.stringify({ name: '@openmaxai/email-mcp', version: 1 }),
    '{not json',
    'null',
  ]) {
    const r = runCleanupMeta({ rawPackageJson: pj });
    assert.notEqual(r.status, 0, `${pj}: ${r.out}`);
    assert.equal(r.env, '', pj);
  }
});

test('cleanup meta: tag / package.json version mismatch is a HARD failure', () => {
  const r = runCleanupMeta({ version: '0.1.0', ref: 'v0.1.1' });
  assert.notEqual(r.status, 0);
  assert.equal(r.env, '');
  assert.match(r.out, /::error::tag "v0\.1\.1" != package\.json version "0\.1\.0"/);
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
        // (c) the cleanup job's inline full-string-validated writer
        if (j.name === 'cleanup' && s.id === 'meta' && /(const \{ .*GITHUB_ENV.* \} = process\.env;|fs\.appendFileSync\(GITHUB_ENV, )/.test(line)) continue;
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

test('workflow: cleanup runs no repo script (unvetted checkout) and its meta step validates full-string', () => {
  assert.doesNotMatch(wf.cleanup.text, /\.github\/scripts|ENV_WRITER/);
  const sc = runScript(cleanupMeta);
  assert.match(sc, /\/\[\\r\\n\]\/\.test\(v\)/);
  assert.doesNotMatch(sc, /grep -E/);
});

test('workflow: the old line-oriented version check is gone everywhere', () => {
  assert.doesNotMatch(fs.readFileSync(WORKFLOW, 'utf8'), /grep -Eq '\^\[0-9\]\+/);
});
