import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, envFor, eventually, token, type Harness } from './helpers.js';

describe('IMAP + SMTP (plain ports)', () => {
  let alice: Harness;
  let bob: Harness;
  let carol: Harness;
  const tag = token();
  let attachmentPath: string;

  beforeAll(async () => {
    alice = await connect(envFor('alice'));
    bob = await connect(envFor('bob'));
    carol = await connect(envFor('carol'));
    const dir = await mkdtemp(path.join(tmpdir(), 'email-mcp-it-'));
    attachmentPath = path.join(dir, 'report.txt');
    await writeFile(attachmentPath, `attachment body ${tag}`);
  });

  afterAll(async () => {
    await Promise.all([alice?.close(), bob?.close(), carol?.close()]);
  });

  it('registers the IMAP-only tools', async () => {
    const { tools } = await alice.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['get_email', 'list_emails', 'list_folders', 'mark_read', 'reply_email', 'search_emails', 'send_email'].sort(),
    );
  });

  let bobUid: string;
  let originalMessageId: string;

  it('send_email then list_emails / get_email / search_emails', async () => {
    const sent = await alice.call('send_email', {
      to: ['Bob <bob@example.com>'],
      cc: ['carol@example.com'],
      subject: `Quarterly report ${tag}`,
      text: `Hello Bob, the magic word is ${tag}-body.`,
      html: `<p>Hello Bob, the magic word is <b>${tag}-body</b>.</p>`,
      attachments: [attachmentPath],
    });
    expect(sent.isError).toBe(false);
    expect(sent.data.accepted).toEqual(expect.arrayContaining(['bob@example.com', 'carol@example.com']));
    originalMessageId = sent.data.message_id;

    const listed = await eventually(async () => {
      const r = await bob.call('list_emails', { limit: 50 });
      return r.data.emails?.find((e: any) => e.subject === `Quarterly report ${tag}`);
    });
    expect(listed.from[0].address).toBe('alice@example.com');
    expect(listed.to[0].address).toBe('bob@example.com');
    expect(listed.seen).toBe(false);
    expect(listed.snippet).toContain(`${tag}-body`);
    expect(listed.message_id).toBe(originalMessageId);
    bobUid = listed.uid;

    const full = await bob.call('get_email', { uid: bobUid, include_attachments: true });
    expect(full.isError).toBe(false);
    expect(full.data.text).toContain(`${tag}-body`);
    expect(full.data.html).toContain('<b>');
    expect(full.data.cc[0].address).toBe('carol@example.com');
    expect(full.data.attachments).toHaveLength(1);
    expect(full.data.attachments[0].filename).toBe('report.txt');
    expect(await readFile(full.data.attachments[0].path, 'utf8')).toBe(`attachment body ${tag}`);

    const headers = await bob.call('get_email', { uid: Number(bobUid), format: 'headers' });
    expect(headers.data.subject).toBe(`Quarterly report ${tag}`);
    expect(headers.data.text).toBeUndefined();
    expect(headers.data.html).toBeUndefined();

    // Reading with get_email must not mark as seen (BODY.PEEK)
    const stillUnread = await bob.call('list_emails', { unread_only: true, limit: 100 });
    expect(stillUnread.data.emails.some((e: any) => e.uid === bobUid)).toBe(true);

    for (const q of [
      { subject: tag },
      { from: 'alice@example.com', subject: 'quarterly' },
      { text: `${tag}-body` },
      { to: 'bob@example.com', subject: tag, since: '2000-01-01' },
    ]) {
      const s = await bob.call('search_emails', q);
      expect(s.isError, JSON.stringify(q)).toBe(false);
      expect(s.data.emails.map((e: any) => e.uid), JSON.stringify(q)).toContain(bobUid);
    }
    const none = await bob.call('search_emails', { subject: tag, before: '2000-01-01' });
    expect(none.data.emails).toHaveLength(0);
    const other = await bob.call('search_emails', { subject: `${tag}-nope` });
    expect(other.data.emails).toHaveLength(0);
  });

  it('mark_read toggles \\Seen and unread_only honours it', async () => {
    const r1 = await bob.call('mark_read', { uid: bobUid, read: true });
    expect(r1.isError).toBe(false);
    expect(r1.data.seen).toBe(true);
    const unread = await bob.call('list_emails', { unread_only: true, limit: 100 });
    expect(unread.data.emails.some((e: any) => e.uid === bobUid)).toBe(false);
    const all = await bob.call('get_email', { uid: bobUid, format: 'headers' });
    expect(all.data.seen).toBe(true);
    expect(all.data.flags).toContain('\\Seen');

    await bob.call('mark_read', { uid: bobUid, read: false });
    const again = await bob.call('get_email', { uid: bobUid, format: 'headers' });
    expect(again.data.seen).toBe(false);
  });

  it('list_folders returns INBOX with counts', async () => {
    const r = await bob.call('list_folders');
    expect(r.isError).toBe(false);
    const inbox = r.data.folders.find((f: any) => f.path === 'INBOX');
    expect(inbox).toBeDefined();
    expect(inbox.messages).toBeGreaterThan(0);
  });

  it('reply_email by uid sets threading headers and Re: subject', async () => {
    const reply = await bob.call('reply_email', { uid: bobUid, text: `Thanks! ${tag}-reply` });
    expect(reply.isError, JSON.stringify(reply.data)).toBe(false);
    expect(reply.data.subject).toBe(`Re: Quarterly report ${tag}`);
    expect(reply.data.in_reply_to).toBe(originalMessageId);
    expect(reply.data.to).toEqual(['alice@example.com']);
    expect(reply.data.cc).toEqual([]);

    const got = await eventually(async () => {
      const s = await alice.call('search_emails', { subject: `Re: Quarterly report ${tag}` });
      return s.data.emails?.[0];
    });
    const detail = await alice.call('get_email', { uid: got.uid, format: 'headers' });
    expect(detail.data.in_reply_to).toBe(originalMessageId);
    expect(detail.data.references).toContain(originalMessageId);
    expect(detail.data.from[0].address).toBe('bob@example.com');

    // Second-level reply: References must chain both ids and not double the Re:
    const reply2 = await alice.call('reply_email', { uid: got.uid, text: 'np' });
    expect(reply2.data.subject).toBe(`Re: Quarterly report ${tag}`);
    expect(reply2.data.references).toEqual([originalMessageId, detail.data.message_id]);
  });

  it('reply_email by message_id with reply_all includes other recipients but not self', async () => {
    const r = await carol.call('reply_email', { message_id: originalMessageId, reply_all: true, text: 'all' });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.to).toEqual(['alice@example.com']);
    expect(r.data.cc.join(' ')).toContain('bob@example.com');
    expect(r.data.cc.join(' ')).not.toContain('carol@example.com');
    const atBob = await eventually(async () => {
      const s = await bob.call('search_emails', { from: 'carol@example.com', subject: tag });
      return s.data.emails?.[0];
    });
    const d = await bob.call('get_email', { uid: atBob.uid, format: 'headers' });
    expect(d.data.in_reply_to).toBe(originalMessageId);
  });

  it('NOT_FOUND and INVALID_INPUT errors', async () => {
    const nf = await bob.call('get_email', { uid: 99999999 });
    expect(nf.isError).toBe(true);
    expect(nf.data.error.code).toBe('NOT_FOUND');

    const nfFolder = await bob.call('list_emails', { folder: 'NoSuchFolder' });
    expect(nfFolder.data.error.code).toBe('NOT_FOUND');

    const nfMark = await bob.call('mark_read', { uid: 99999999 });
    expect(nfMark.data.error.code).toBe('NOT_FOUND');

    const nfReply = await bob.call('reply_email', { message_id: '<nope@nowhere>', text: 'x' });
    expect(nfReply.data.error.code).toBe('NOT_FOUND');

    const badUid = await bob.call('get_email', { uid: 'abc' });
    expect(badUid.data.error.code).toBe('INVALID_INPUT');

    const noBody = await bob.call('send_email', { to: ['alice@example.com'], subject: 'x' });
    expect(noBody.data.error.code).toBe('INVALID_INPUT');

    const missingFile = await bob.call('send_email', {
      to: ['alice@example.com'],
      text: 'x',
      attachments: ['/definitely/not/here.txt'],
    });
    expect(missingFile.data.error.code).toBe('INVALID_INPUT');

    const both = await bob.call('reply_email', { uid: bobUid, message_id: originalMessageId, text: 'x' });
    expect(both.data.error.code).toBe('INVALID_INPUT');

    const badDate = await bob.call('search_emails', { since: 'yesterday-ish' });
    expect(badDate.data.error.code).toBe('INVALID_INPUT');
  });
});

describe('IMAPS + SMTPS (implicit TLS)', () => {
  it('sends and reads over TLS when certificate verification is disabled', async () => {
    const tag = token();
    const alice = await connect(envFor('alice', { mode: 'ssl' }));
    const bob = await connect(envFor('bob', { mode: 'ssl' }));
    try {
      const s = await alice.call('send_email', { to: ['bob@example.com'], subject: `tls ${tag}`, text: 'over tls' });
      expect(s.isError, JSON.stringify(s.data)).toBe(false);
      const found = await eventually(async () => (await bob.call('search_emails', { subject: tag })).data.emails?.[0]);
      expect(found.subject).toBe(`tls ${tag}`);
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it('rejects the self-signed certificate by default (UNREACHABLE)', async () => {
    const h = await connect(envFor('bob', { mode: 'ssl', overrides: { EMAIL_TLS_REJECT_UNAUTHORIZED: 'true' } }));
    try {
      const r = await h.call('list_emails');
      expect(r.isError).toBe(true);
      expect(r.data.error.code).toBe('UNREACHABLE');
      const s = await h.call('send_email', { to: ['alice@example.com'], text: 'x' });
      expect(s.data.error.code).toBe('UNREACHABLE');
    } finally {
      await h.close();
    }
  });
});
