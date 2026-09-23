#!/usr/bin/env node
// Runtime smoke test for the PACKED artifact, meant to run on the minimum
// supported Node version (package.json engines) with no dev toolchain.
// Usage: node scripts/smoke-packed.mjs <path-to-installed-bin>
// Spawns the stdio MCP server with dummy config (no network is touched at
// startup), sends `initialize` + `tools/list` over stdin, and asserts both
// JSON-RPC responses arrive. Uses only Node built-ins.
import { spawn } from 'node:child_process';

const bin = process.argv[2];
if (!bin) {
  console.error('usage: smoke-packed.mjs <path-to-email-mcp-bin>');
  process.exit(2);
}

const env = {
  ...process.env,
  EMAIL_USER: 'smoke@example.invalid',
  EMAIL_PASSWORD: 'dummy',
  RECEIVE_PROTOCOL: 'imap',
  IMAP_HOST: 'imap.example.invalid',
  SMTP_HOST: 'smtp.example.invalid',
};

const child = spawn(process.execPath, [bin], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map([[1, 'initialize'], [2, 'tools/list']]);
let buf = '';
let failed = false;

const fail = (msg) => {
  if (failed) return;
  failed = true;
  console.error(`smoke FAILED: ${msg}`);
  child.kill('SIGKILL');
  process.exit(1);
};
const timer = setTimeout(() => fail('timed out waiting for MCP responses'), 20_000);

child.stdin.on('error', () => {}); // EPIPE if the server dies; reported via 'exit'
const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

child.on('exit', (code, signal) => {
  if (pending.size) fail(`server exited early (code=${code}, signal=${signal})`);
});

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`non-JSON on stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (!pending.has(msg.id)) continue;
    if (msg.error) fail(`${pending.get(msg.id)} returned error: ${JSON.stringify(msg.error)}`);
    if (msg.id === 1) {
      const name = msg.result?.serverInfo?.name;
      console.log(`initialize ok: server=${name} version=${msg.result?.serverInfo?.version} protocol=${msg.result?.protocolVersion}`);
      pending.delete(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    } else if (msg.id === 2) {
      const tools = (msg.result?.tools ?? []).map((t) => t.name);
      if (!tools.length) fail('tools/list returned no tools');
      console.log(`tools/list ok: ${tools.join(', ')}`);
      pending.delete(2);
      clearTimeout(timer);
      console.log(`smoke OK on node ${process.version}`);
      child.kill('SIGTERM');
    }
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  },
});
