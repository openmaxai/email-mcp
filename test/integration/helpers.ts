import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { inject } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';

export const USERS = {
  alice: { user: 'alice@example.com', password: 'alicepw' },
  bob: { user: 'bob@example.com', password: 'bobpw' },
  carol: { user: 'carol@example.com', password: 'carolpw' },
};

export type Mode = 'plain' | 'ssl';

export function envFor(
  who: keyof typeof USERS,
  opts: { protocol?: 'imap' | 'pop3'; mode?: Mode; overrides?: Record<string, string> } = {},
): Record<string, string> {
  const gm = inject('greenmail');
  const { protocol = 'imap', mode = 'plain' } = opts;
  const ssl = mode === 'ssl';
  const env: Record<string, string> = {
    EMAIL_USER: USERS[who].user,
    EMAIL_PASSWORD: USERS[who].password,
    RECEIVE_PROTOCOL: protocol,
    SMTP_HOST: gm.host,
    SMTP_PORT: String(ssl ? gm.smtps : gm.smtp),
    SMTP_SECURE: ssl ? 'ssl' : 'none',
    EMAIL_TLS_REJECT_UNAUTHORIZED: 'false', // GreenMail uses a self-signed certificate
    EMAIL_TIMEOUT_MS: '15000',
  };
  if (protocol === 'imap') {
    env.IMAP_HOST = gm.host;
    env.IMAP_PORT = String(ssl ? gm.imaps : gm.imap);
    env.IMAP_SECURE = ssl ? 'ssl' : 'none';
  } else {
    env.POP3_HOST = gm.host;
    env.POP3_PORT = String(ssl ? gm.pop3s : gm.pop3);
    env.POP3_SECURE = ssl ? 'ssl' : 'none';
  }
  return { ...env, ...(opts.overrides ?? {}) };
}

export interface Harness {
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any }>;
  close: () => Promise<void>;
}

export async function connect(env: Record<string, string>): Promise<Harness> {
  const server = createServer(loadConfig(env));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'it', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = (r.content?.[0] as { text?: string } | undefined)?.text ?? '';
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { isError: Boolean(r.isError), data };
  };
  return {
    client,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function token(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Poll until `fn` returns a truthy value (mail delivery in GreenMail is async but fast). */
export async function eventually<T>(fn: () => Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`condition not met within ${ms} ms${last ? `: ${String(last)}` : ''}`);
}
