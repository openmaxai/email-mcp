import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, envFor } from './helpers.js';

const WRONG = 'wrong-password-XYZ';

async function expectCode(env: Record<string, string>, tool: string, args: Record<string, unknown>, code: string) {
  const h = await connect(env);
  try {
    const r = await h.call(tool, args);
    expect(r.isError, JSON.stringify(r.data)).toBe(true);
    expect(r.data.error.code, JSON.stringify(r.data)).toBe(code);
    // The password must never be echoed back
    expect(JSON.stringify(r.data)).not.toContain(env.EMAIL_PASSWORD);
    return r.data.error.message as string;
  } finally {
    await h.close();
  }
}

describe('AUTH_FAILED', () => {
  it('IMAP wrong password', async () => {
    await expectCode(envFor('bob', { overrides: { EMAIL_PASSWORD: WRONG } }), 'list_emails', {}, 'AUTH_FAILED');
  });
  it('IMAPS wrong password', async () => {
    await expectCode(envFor('bob', { mode: 'ssl', overrides: { EMAIL_PASSWORD: WRONG } }), 'list_folders', {}, 'AUTH_FAILED');
  });
  it('POP3 wrong password', async () => {
    await expectCode(envFor('bob', { protocol: 'pop3', overrides: { EMAIL_PASSWORD: WRONG } }), 'list_emails', {}, 'AUTH_FAILED');
  });
  it('SMTP wrong password', async () => {
    await expectCode(
      envFor('bob', { overrides: { EMAIL_PASSWORD: WRONG } }),
      'send_email',
      { to: ['alice@example.com'], text: 'x' },
      'AUTH_FAILED',
    );
  });
});

describe('UNREACHABLE', () => {
  const badHost = { IMAP_HOST: 'no-such-host.invalid', POP3_HOST: 'no-such-host.invalid', SMTP_HOST: 'no-such-host.invalid' };
  it('IMAP unknown host', async () => {
    await expectCode(envFor('bob', { overrides: badHost }), 'list_emails', {}, 'UNREACHABLE');
  });
  it('POP3 unknown host', async () => {
    await expectCode(envFor('bob', { protocol: 'pop3', overrides: badHost }), 'list_emails', {}, 'UNREACHABLE');
  });
  it('SMTP unknown host', async () => {
    await expectCode(envFor('bob', { overrides: badHost }), 'send_email', { to: ['a@example.com'], text: 'x' }, 'UNREACHABLE');
  });
  it('connection refused (closed port)', async () => {
    const refused = { IMAP_HOST: '127.0.0.1', IMAP_PORT: '1', POP3_HOST: '127.0.0.1', POP3_PORT: '1', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' };
    await expectCode(envFor('bob', { overrides: refused }), 'list_emails', {}, 'UNREACHABLE');
    await expectCode(envFor('bob', { protocol: 'pop3', overrides: refused }), 'list_emails', {}, 'UNREACHABLE');
    await expectCode(envFor('bob', { overrides: refused }), 'send_email', { to: ['a@example.com'], text: 'x' }, 'UNREACHABLE');
  });
});

describe('TIMEOUT', () => {
  // A server that accepts TCP connections but never sends a greeting.
  let silent: net.Server;
  let port: number;
  const sockets = new Set<net.Socket>();
  beforeAll(async () => {
    silent = net.createServer((s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    port = (silent.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => silent.close(r));
  });

  const env = (protocol: 'imap' | 'pop3') =>
    envFor('bob', {
      protocol,
      overrides: {
        EMAIL_TIMEOUT_MS: '1500',
        IMAP_HOST: '127.0.0.1',
        IMAP_PORT: String(port),
        POP3_HOST: '127.0.0.1',
        POP3_PORT: String(port),
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(port),
      },
    });

  it('IMAP greeting never arrives', async () => {
    await expectCode(env('imap'), 'list_emails', {}, 'TIMEOUT');
  });
  it('POP3 greeting never arrives', async () => {
    await expectCode(env('pop3'), 'list_emails', {}, 'TIMEOUT');
  });
  it('SMTP greeting never arrives', async () => {
    await expectCode(env('imap'), 'send_email', { to: ['a@example.com'], text: 'x' }, 'TIMEOUT');
  });
});
