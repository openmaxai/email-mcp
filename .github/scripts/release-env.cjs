#!/usr/bin/env node
// Validating writer for $GITHUB_ENV / $GITHUB_OUTPUT in release.yml.
//
// Both files are line-oriented KEY=VALUE lists: a value containing "\n" or
// "\r" (e.g. a package.json version "9.9.9\nnpm_config_registry=http://x")
// would inject extra variables into every later step. Shell checks such as
// `grep -Eq '^...$'` are line-oriented and do NOT catch that. So every
// variable value the release workflow exports goes through here (in jobs
// whose checkout is the vetted, main-contained commit; the cleanup job,
// which runs on an unvetted checkout, validates inline instead):
//   - only known keys, each with a FULL-STRING pattern (JS regex without the
//     m flag: ^/$ anchor the whole string, not a line);
//   - any \r or \n is rejected outright;
//   - the whole batch is validated before anything is written, and written
//     with a single append (all or nothing).
//
// CLI:
//   node release-env.cjs env    KEY=VALUE...   append to $GITHUB_ENV
//   node release-env.cjs output KEY=VALUE...   append to $GITHUB_OUTPUT
//   node release-env.cjs check  KEY=VALUE...   validate only
// Exit 1 (with a ::error:: annotation, nothing written) on any invalid pair.
'use strict';

const fs = require('node:fs');

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
// npm package name: optional @scope/, lowercase URL-safe chars, <= 214.
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const ABS_PATH = /^\/[A-Za-z0-9._\/+@-]+$/;
const YES_NO = /^(yes|no)$/;

const RULES = {
  NAME: NPM_NAME,
  name: NPM_NAME,
  VERSION: SEMVER,
  version: SEMVER,
  EXPECTED_SHA: /^[0-9a-f]{40}$/,
  expected_sha: /^[0-9a-f]{40}$/,
  channel: /^(alpha|latest)$/,
  ALREADY_PUBLISHED: YES_NO,
  already_published: YES_NO,
  first_publish: YES_NO,
  planned: /^yes$/,
  action: /^[a-z]+$/,
  NPM_CWD: ABS_PATH,
  SCRIPTS: ABS_PATH,
  NPM_MODULES_DIR: ABS_PATH,
};

class EnvValueError extends Error {}

function validatePair(key, value) {
  const rule = Object.prototype.hasOwnProperty.call(RULES, key) ? RULES[key] : null;
  if (!rule) throw new EnvValueError(`unknown key ${JSON.stringify(key)}`);
  if (typeof value !== 'string') throw new EnvValueError(`${key}: not a string`);
  if (/[\r\n]/.test(value)) throw new EnvValueError(`${key}: value contains a line break: ${JSON.stringify(value)}`);
  if (value.length > 214 && key !== 'NPM_CWD' && key !== 'SCRIPTS' && key !== 'NPM_MODULES_DIR') {
    throw new EnvValueError(`${key}: value too long`);
  }
  if (!rule.test(value)) throw new EnvValueError(`${key}: invalid value ${JSON.stringify(value)}`);
}

// ['K=V', ...] -> 'K=V\n...' (throws EnvValueError, writes nothing)
function format(args) {
  if (!args.length) throw new EnvValueError('no KEY=VALUE pairs');
  const seen = new Set();
  return args.map((a) => {
    const i = String(a).indexOf('=');
    if (i <= 0) throw new EnvValueError(`not KEY=VALUE: ${JSON.stringify(a)}`);
    const key = a.slice(0, i);
    const value = a.slice(i + 1);
    if (seen.has(key)) throw new EnvValueError(`duplicate key ${key}`);
    seen.add(key);
    validatePair(key, value);
    return `${key}=${value}\n`;
  }).join('');
}

function main(argv, env) {
  const [mode, ...args] = argv;
  const target = { env: 'GITHUB_ENV', output: 'GITHUB_OUTPUT', check: null }[mode];
  if (target === undefined) throw new EnvValueError(`usage: release-env.cjs env|output|check KEY=VALUE...`);
  const text = format(args);
  if (target) {
    const file = env[target];
    if (!file) throw new EnvValueError(`$${target} is not set`);
    fs.appendFileSync(file, text);
  }
}

module.exports = { format, validatePair, EnvValueError, RULES, SEMVER, NPM_NAME };

if (require.main === module) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (e) {
    console.log(`::error::release-env: refusing to write: ${e && e.message}`);
    process.exit(1);
  }
}
