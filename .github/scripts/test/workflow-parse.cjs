'use strict';
// Shared by the release-*.test.cjs files (not itself a test file).
const assert = require('node:assert/strict');
const path = require('node:path');
//
// Tiny indentation-based reader for the parts of release.yml we assert on
// (no YAML dependency): jobs (2-space keys under `jobs:`), their job-level
// scalar keys (4 spaces), and steps (`      - ` items) with their name / id /
// if and whether they reference NODE_AUTH_TOKEN. Full-line comments are
// dropped, so prose in comments never satisfies or breaks an assertion.

function parseWorkflow(text) {
  const lines = text.split('\n');
  const jobsAt = lines.indexOf('jobs:');
  assert.ok(jobsAt >= 0, 'no top-level jobs:');
  const jobs = {};
  let job = null;
  let step = null;
  let inSteps = false;
  for (let line of lines.slice(jobsAt + 1)) {
    if (/^\S/.test(line)) break; // next top-level key
    let m;
    if ((m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/))) {
      job = { name: m[1], keys: {}, steps: [], text: '' };
      jobs[m[1]] = job;
      step = null;
      inSteps = false;
      continue;
    }
    if (!job) continue;
    if (/^\s*#/.test(line)) continue; // full-line comments are not config
    job.text += `${line}\n`;
    if ((m = line.match(/^ {4}([A-Za-z0-9_-]+):\s*(.*)$/))) {
      job.keys[m[1]] = m[2].trim();
      inSteps = m[1] === 'steps';
      step = null;
      continue;
    }
    if (!inSteps) continue;
    if ((m = line.match(/^ {6}- (.*)$/))) {
      step = { name: '', id: '', if: '', token: false, text: '' };
      job.steps.push(step);
      line = `        ${m[1]}`;
    }
    if (!step) continue;
    step.text += `${line}\n`;
    if ((m = line.match(/^ {8}(name|id|if):\s*(.*)$/))) step[m[1]] = m[2].trim();
    if (/NODE_AUTH_TOKEN:/.test(line)) step.token = true;
  }
  return jobs;
}

const needsOf = (j) => {
  const v = j.keys.needs || '';
  return v.startsWith('[') ? v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : [v].filter(Boolean);
};


// The literal `run: |` script of a step (block scalar, dedented).
function runScript(step) {
  const lines = step.text.split('\n');
  const at = lines.findIndex((l) => /^ {8}run: \|\s*$/.test(l));
  if (at < 0) throw new Error(`step ${step.name} has no run: | block`);
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === '') { out.push(''); continue; }
    if (!/^ {10}/.test(l)) break;
    out.push(l.slice(10));
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

module.exports = { parseWorkflow, needsOf, runScript, WORKFLOW: path.join(__dirname, '..', '..', 'workflows', 'release.yml') };
