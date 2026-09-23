import { describe, expect, it } from 'vitest';
import { ConfigError, SUPPORTED_ENV_KEYS, describeConfig, loadConfig } from '../../src/config.js';

const base = {
  EMAIL_USER: 'me@example.com',
  EMAIL_PASSWORD: 'hunter2-SECRET',
  IMAP_HOST: 'imap.example.com',
  SMTP_HOST: 'smtp.example.com',
};

describe('env key naming (platform credential detection)', () => {
  it('exactly one supported env key contains a credential token, and it is EMAIL_PASSWORD', () => {
    const tokens = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'PAT', 'AUTHORIZATION'];
    const hits = SUPPORTED_ENV_KEYS.filter((k) => tokens.some((t) => k.toUpperCase().includes(t)));
    expect(hits).toEqual(['EMAIL_PASSWORD']);
  });

  it('every env key read by the source is declared in SUPPORTED_ENV_KEYS', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const dir = new URL('../../src/', import.meta.url);
    const found = new Set<string>();
    for (const f of await readdir(dir)) {
      const src = await readFile(new URL(f, dir), 'utf8');
      for (const m of src.matchAll(/(?:env|process\.env)\.([A-Z0-9_]+)/g)) found.add(m[1]);
      for (const m of src.matchAll(/str\(env, '([A-Z0-9_]+)'\)/g)) found.add(m[1]);
      for (const m of src.matchAll(/`\$\{prefix\}_([A-Z]+)`/g)) for (const p of ['IMAP', 'POP3', 'SMTP']) found.add(`${p}_${m[1]}`);
    }
    for (const k of found) expect(SUPPORTED_ENV_KEYS as readonly string[]).toContain(k);
  });
});

describe('loadConfig', () => {
  it('applies defaults (imap, ssl, standard ports, TLS verification on)', () => {
    const c = loadConfig(base);
    expect(c.receiveProtocol).toBe('imap');
    expect(c.imap).toEqual({ host: 'imap.example.com', port: 993, security: 'ssl' });
    expect(c.smtp).toEqual({ host: 'smtp.example.com', port: 465, security: 'ssl' });
    expect(c.pop3).toBeUndefined();
    expect(c.tlsRejectUnauthorized).toBe(true);
    expect(c.timeoutMs).toBe(30000);
  });

  it('derives default ports from SECURE', () => {
    const c = loadConfig({ ...base, IMAP_SECURE: 'starttls', SMTP_SECURE: 'starttls' });
    expect(c.imap!.port).toBe(143);
    expect(c.smtp!.port).toBe(587);
    const n = loadConfig({ ...base, SMTP_SECURE: 'none' });
    expect(n.smtp.port).toBe(25);
  });

  it('pop3 mode requires POP3_HOST, not IMAP_HOST', () => {
    const c = loadConfig({ EMAIL_USER: 'a@b.c', EMAIL_PASSWORD: 'x', RECEIVE_PROTOCOL: 'POP3', POP3_HOST: 'pop.b.c', SMTP_HOST: 's' });
    expect(c.receiveProtocol).toBe('pop3');
    expect(c.pop3).toEqual({ host: 'pop.b.c', port: 995, security: 'ssl' });
    expect(c.imap).toBeUndefined();
  });

  it('explicit ports, from name, tls flag and timeout', () => {
    const c = loadConfig({
      ...base,
      IMAP_PORT: '1993',
      SMTP_PORT: '2465',
      EMAIL_FROM_NAME: 'Me Myself',
      EMAIL_TLS_REJECT_UNAUTHORIZED: 'false',
      EMAIL_TIMEOUT_MS: '5000',
    });
    expect(c.imap!.port).toBe(1993);
    expect(c.smtp.port).toBe(2465);
    expect(c.fromName).toBe('Me Myself');
    expect(c.tlsRejectUnauthorized).toBe(false);
    expect(c.timeoutMs).toBe(5000);
  });

  it('collects all problems into a single ConfigError', () => {
    let err: unknown;
    try {
      loadConfig({ RECEIVE_PROTOCOL: 'mapi', SMTP_SECURE: 'maybe', SMTP_PORT: '99999', EMAIL_TLS_REJECT_UNAUTHORIZED: 'perhaps' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    for (const k of ['EMAIL_USER', 'EMAIL_PASSWORD', 'RECEIVE_PROTOCOL', 'SMTP_SECURE', 'SMTP_PORT', 'SMTP_HOST', 'EMAIL_TLS_REJECT_UNAUTHORIZED']) {
      expect(msg).toContain(k);
    }
  });

  it('rejects POP3 STARTTLS with a clear message', () => {
    expect(() =>
      loadConfig({ ...base, RECEIVE_PROTOCOL: 'pop3', POP3_HOST: 'p', POP3_SECURE: 'starttls' }),
    ).toThrow(/POP3_SECURE=starttls is not supported/);
  });

  it('never echoes the password in errors or in describeConfig', () => {
    try {
      loadConfig({ EMAIL_PASSWORD: 'p@ss-DO-NOT-LEAK', SMTP_PORT: 'p@ss-DO-NOT-LEAK-no' });
    } catch (e) {
      // the port value is echoed (it is not the password) but the password alone never is
      expect((e as Error).message.replace('p@ss-DO-NOT-LEAK-no', '')).not.toContain('p@ss-DO-NOT-LEAK');
    }
    const c = loadConfig(base);
    expect(describeConfig(c)).not.toContain(base.EMAIL_PASSWORD);
  });
});
