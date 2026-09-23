import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { EmailError } from '../../src/errors.js';
import type { Receiver } from '../../src/receiver.js';
import { createServer } from '../../src/server.js';

const env = {
  EMAIL_USER: 'me@example.com',
  EMAIL_PASSWORD: 'pw-unit-123',
  IMAP_HOST: 'imap.example.com',
  POP3_HOST: 'pop.example.com',
  SMTP_HOST: 'smtp.example.com',
};

const fake: Receiver = {
  protocol: 'pop3',
  list: async (p) => ({ folder: p.folder, emails: [], note: `limit=${p.limit}` }),
  get: async () => {
    throw new EmailError('NOT_FOUND', 'nope pw-unit-123');
  },
  search: async () => ({ folder: 'INBOX', emails: [] }),
  getOriginal: async () => {
    throw new Error('should not be called');
  },
};

async function client(e: Record<string, string>, receiver?: Receiver) {
  const server = createServer(loadConfig(e), receiver);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'u', version: '0' });
  await Promise.all([server.connect(b), c.connect(a)]);
  return c;
}

const body = (r: any) => JSON.parse(r.content[0].text);

describe('tool registration', () => {
  it('IMAP registers all 7 tools', async () => {
    const c = await client(env);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(
      ['get_email', 'list_emails', 'list_folders', 'mark_read', 'reply_email', 'search_emails', 'send_email'],
    );
  });

  it('POP3 does not register list_folders / mark_read', async () => {
    const c = await client({ ...env, RECEIVE_PROTOCOL: 'pop3' });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('list_folders');
    expect(names).not.toContain('mark_read');
    expect(names).toHaveLength(5);
  });
});

describe('tool results', () => {
  it('applies schema defaults', async () => {
    const c = await client({ ...env, RECEIVE_PROTOCOL: 'pop3' }, fake);
    const r = await c.callTool({ name: 'list_emails', arguments: {} });
    expect(body(r)).toEqual({ folder: 'INBOX', emails: [], note: 'limit=20' });
  });

  it('returns stable error codes and redacts the password', async () => {
    const c = await client({ ...env, RECEIVE_PROTOCOL: 'pop3' }, fake);
    const r = await c.callTool({ name: 'get_email', arguments: { uid: 'x' } });
    expect(r.isError).toBe(true);
    expect(body(r).error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(r)).not.toContain('pw-unit-123');
  });

  it('INVALID_INPUT for reply without uid/message_id and send without body', async () => {
    const c = await client({ ...env, RECEIVE_PROTOCOL: 'pop3' }, fake);
    const r1 = await c.callTool({ name: 'reply_email', arguments: { text: 'x' } });
    expect(body(r1).error.code).toBe('INVALID_INPUT');
    const r2 = await c.callTool({ name: 'send_email', arguments: { to: ['a@b.c'] } });
    expect(body(r2).error.code).toBe('INVALID_INPUT');
    const r3 = await c.callTool({ name: 'search_emails', arguments: { since: 'not a date' } });
    expect(body(r3).error.code).toBe('INVALID_INPUT');
  });

  it('schema validation rejects bad arguments', async () => {
    const c = await client(env, fake);
    const r = await c.callTool({ name: 'list_emails', arguments: { limit: 1000 } });
    expect(r.isError).toBe(true);
  });
});
