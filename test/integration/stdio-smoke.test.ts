import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { envFor, eventually, token } from './helpers.js';

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');

async function spawnServer(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (d) => stderr.push(String(d)));
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr };
}

describe('built server over stdio (dist/index.js)', () => {
  it('dist/index.js exists (run `npm run build` first)', () => {
    expect(existsSync(entry)).toBe(true);
  });

  it('tools/list + send_email + list_emails (IMAP)', async () => {
    const env = envFor('bob');
    const { client, stderr } = await spawnServer(env);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        ['get_email', 'list_emails', 'list_folders', 'mark_read', 'reply_email', 'search_emails', 'send_email'].sort(),
      );
      const tag = token();
      const sent = await client.callTool({
        name: 'send_email',
        arguments: { to: ['bob@example.com'], subject: `smoke ${tag}`, text: 'secret body text' },
      });
      expect(sent.isError).toBeFalsy();
      await eventually(async () => {
        const r = await client.callTool({ name: 'list_emails', arguments: { limit: 50 } });
        const data = JSON.parse((r.content as any)[0].text);
        return data.emails.some((e: any) => e.subject === `smoke ${tag}`);
      });
      const log = stderr.join('');
      expect(log).toContain('ready');
      expect(log).not.toContain(env.EMAIL_PASSWORD);
      expect(log).not.toContain('secret body text');
      expect(log).not.toContain(`smoke ${tag}`);
    } finally {
      await client.close();
    }
  });

  it('POP3 mode hides IMAP-only tools', async () => {
    const { client } = await spawnServer(envFor('bob', { protocol: 'pop3' }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.sort()).toEqual(['get_email', 'list_emails', 'reply_email', 'search_emails', 'send_email']);
    } finally {
      await client.close();
    }
  });
});
