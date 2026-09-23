import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { USERS, connect, envFor, eventually, token } from './helpers.js';

async function createFolder(who: keyof typeof USERS, folder: string) {
  const gm = inject('greenmail');
  const c = new ImapFlow({
    host: gm.host,
    port: gm.imap,
    secure: false,
    doSTARTTLS: false,
    auth: { user: USERS[who].user, pass: USERS[who].password },
    logger: false,
  });
  await c.connect();
  try {
    await c.mailboxCreate(folder).catch(() => {});
  } finally {
    await c.logout();
  }
}

describe('save sent mail to the IMAP Sent folder', () => {
  beforeAll(async () => {
    await createFolder('dave', 'Sent');
    await createFolder('frank', '已发送');
  });

  it('send_email appends an identical, \\Seen copy (with Bcc) to "Sent"', async () => {
    const tag = token();
    const dave = await connect(envFor('dave'));
    try {
      const r = await dave.call('send_email', {
        to: ['bob@example.com'],
        bcc: ['carol@example.com'],
        subject: `sent-copy ${tag}`,
        text: 'copy me',
      });
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
      expect(r.data.saved_to_sent).toBe('Sent');
      expect(r.data.warnings).toBeUndefined();

      const s = await dave.call('search_emails', { folder: 'Sent', subject: tag });
      expect(s.data.emails).toHaveLength(1);
      expect(s.data.emails[0].message_id).toBe(r.data.message_id);
      expect(s.data.emails[0].seen).toBe(true);
      const d = await dave.call('get_email', { folder: 'Sent', uid: s.data.emails[0].uid });
      expect(d.data.text).toContain('copy me');
      expect(d.data.bcc).toEqual([{ address: 'carol@example.com' }]);

      // The delivered message has the same Message-ID and no Bcc header
      const bob = await connect(envFor('bob'));
      try {
        const got = await eventually(async () => (await bob.call('search_emails', { subject: tag })).data.emails?.[0]);
        expect(got.message_id).toBe(r.data.message_id);
        const full = await bob.call('get_email', { uid: got.uid, format: 'headers' });
        expect(full.data.bcc).toBeUndefined();
      } finally {
        await bob.close();
      }
    } finally {
      await dave.close();
    }
  });

  it('reply_email is saved too; the fallback name 已发送 is detected', async () => {
    const tag = token();
    const alice = await connect(envFor('alice'));
    const frank = await connect(envFor('frank'));
    try {
      await alice.call('send_email', { to: ['frank@example.com'], subject: `q ${tag}`, text: 'question' });
      const m = await eventually(async () => (await frank.call('search_emails', { subject: tag })).data.emails?.[0]);
      const r = await frank.call('reply_email', { uid: m.uid, text: 'answer' });
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
      expect(r.data.saved_to_sent).toBe('已发送');
      const s = await frank.call('search_emails', { folder: '已发送', subject: tag });
      expect(s.data.emails[0].subject).toBe(`Re: q ${tag}`);
    } finally {
      await alice.close();
      await frank.close();
    }
  });

  it('a missing Sent folder does not fail the send: it returns a warning', async () => {
    const erin = await connect(envFor('erin'));
    try {
      const r = await erin.call('send_email', { to: ['bob@example.com'], subject: `nosent ${token()}`, text: 'x' });
      expect(r.isError).toBe(false);
      expect(r.data.accepted).toEqual(['bob@example.com']);
      expect(r.data.saved_to_sent).toBeUndefined();
      expect(r.data.warnings[0]).toMatch(/saving a copy to the Sent folder failed \(NOT_FOUND\)/);
    } finally {
      await erin.close();
    }
  });

  it('EMAIL_SAVE_SENT=false skips the copy', async () => {
    const tag = token();
    const dave = await connect(envFor('dave', { overrides: { EMAIL_SAVE_SENT: 'false' } }));
    try {
      const r = await dave.call('send_email', { to: ['bob@example.com'], subject: `nocopy ${tag}`, text: 'x' });
      expect(r.isError).toBe(false);
      expect(r.data.saved_to_sent).toBeUndefined();
      expect(r.data.warnings).toBeUndefined();
      const s = await dave.call('search_emails', { folder: 'Sent', subject: tag });
      expect(s.data.emails).toHaveLength(0);
    } finally {
      await dave.close();
    }
  });

  it('POP3 mode never tries to save a copy', async () => {
    const pop = await connect(envFor('dave', { protocol: 'pop3' }));
    try {
      const r = await pop.call('send_email', { to: ['bob@example.com'], subject: `pop-send ${token()}`, text: 'x' });
      expect(r.isError).toBe(false);
      expect(r.data.saved_to_sent).toBeUndefined();
      expect(r.data.warnings).toBeUndefined();
    } finally {
      await pop.close();
    }
  });
});

describe('attachment path policy (end to end)', () => {
  let dir: string;
  let outside: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'email-mcp-roots-'));
    outside = await mkdtemp(path.join(tmpdir(), 'email-mcp-outside-'));
    await writeFile(path.join(dir, 'ok.txt'), 'ok');
    await writeFile(path.join(outside, 'secret.txt'), 'nope');
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
  });

  it('allows files under EMAIL_ATTACHMENT_ROOTS and rejects traversal / symlink escape / system files', async () => {
    const h = await connect(envFor('erin', { overrides: { EMAIL_ATTACHMENT_ROOTS: dir, EMAIL_SAVE_SENT: 'false' } }));
    try {
      const good = await h.call('send_email', { to: ['bob@example.com'], text: 'x', attachments: [path.join(dir, 'ok.txt')] });
      expect(good.isError, JSON.stringify(good.data)).toBe(false);

      for (const bad of [
        path.join(dir, '..', path.basename(outside), 'secret.txt'), // ../ traversal
        path.join(dir, 'link.txt'), // symlink pointing outside the root
        '/etc/passwd',
      ]) {
        const r = await h.call('send_email', { to: ['bob@example.com'], text: 'x', attachments: [bad] });
        expect(r.isError, bad).toBe(true);
        expect(r.data.error.code, bad).toBe('INVALID_INPUT');
        expect(r.data.error.message, bad).toMatch(/outside the allowed directories/);
      }
    } finally {
      await h.close();
    }
  });

  it('enforces EMAIL_MAX_ATTACHMENT_MB', async () => {
    await writeFile(path.join(dir, 'big.bin'), Buffer.alloc(20 * 1024));
    const h = await connect(
      envFor('erin', { overrides: { EMAIL_ATTACHMENT_ROOTS: dir, EMAIL_MAX_ATTACHMENT_MB: '0.01', EMAIL_SAVE_SENT: 'false' } }),
    );
    try {
      const r = await h.call('send_email', { to: ['bob@example.com'], text: 'x', attachments: [path.join(dir, 'big.bin')] });
      expect(r.data.error.code).toBe('INVALID_INPUT');
      expect(r.data.error.message).toMatch(/EMAIL_MAX_ATTACHMENT_MB/);
    } finally {
      await h.close();
    }
  });
});
