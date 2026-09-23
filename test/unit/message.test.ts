import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_CHARS,
  buildReplyHeaders,
  detailFromParsed,
  makeSnippet,
  matchesCriteria,
  parse,
  replySubject,
  safeFilename,
  summaryFromParsed,
  type OriginalForReply,
} from '../../src/message.js';

const RAW = [
  'From: "Alice A" <alice@example.com>',
  'To: bob@example.com, "Carol" <carol@example.com>',
  'Cc: dave@example.com',
  'Subject: Hello world',
  'Date: Tue, 15 Sep 2026 10:00:00 +0000',
  'Message-ID: <m2@example.com>',
  'In-Reply-To: <m1@example.com>',
  'References: <m0@example.com> <m1@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Body   line with    spaces and the word Pineapple.',
  '--b1',
  'Content-Type: application/octet-stream; name="../../etc/passwd"',
  'Content-Disposition: attachment; filename="../../etc/passwd"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('not really').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

describe('parsing helpers', () => {
  it('builds a summary', async () => {
    const s = summaryFromParsed('7', await parse(RAW), ['\\Seen'], true);
    expect(s).toMatchObject({
      uid: '7',
      message_id: '<m2@example.com>',
      subject: 'Hello world',
      seen: true,
      has_attachments: true,
      date: '2026-09-15T10:00:00.000Z',
    });
    expect(s.from).toEqual([{ name: 'Alice A', address: 'alice@example.com' }]);
    expect(s.to.map((a) => a.address)).toEqual(['bob@example.com', 'carol@example.com']);
    expect(s.snippet).toBe('Body line with spaces and the word Pineapple.');
  });

  it('detail with attachments saves files safely inside a private temp dir', async () => {
    const d = await detailFromParsed('7', 'INBOX', await parse(RAW), [], false, { format: 'full', includeAttachments: true });
    expect(d.references).toEqual(['<m0@example.com>', '<m1@example.com>']);
    expect(d.in_reply_to).toBe('<m1@example.com>');
    expect(d.attachments).toHaveLength(1);
    const a = d.attachments[0];
    expect(a.filename).toBe('passwd');
    expect(a.path!.startsWith(d.attachments_dir!)).toBe(true);
    expect(existsSync(a.path!)).toBe(true);
    expect(readFileSync(a.path!, 'utf8')).toBe('not really');
    expect(statSync(a.path!).mode & 0o077).toBe(0);
  });

  it('headers format omits bodies', async () => {
    const d = await detailFromParsed('7', 'INBOX', await parse(RAW), [], false, { format: 'headers', includeAttachments: false });
    expect(d.text).toBeUndefined();
    expect(d.attachments[0].path).toBeUndefined();
  });

  it('skips saving attachments above the size limit, with a reason', async () => {
    const d = await detailFromParsed('7', 'INBOX', await parse(RAW), [], false, { format: 'full', includeAttachments: true, maxAttachmentBytes: 3 });
    expect(d.attachments[0].path).toBeUndefined();
    expect(d.attachments[0].skipped_reason).toMatch(/EMAIL_MAX_ATTACHMENT_MB/);
  });

  it('truncates very large bodies and flags it', async () => {
    const big = `Subject: big\r\nContent-Type: text/plain\r\n\r\n${'a'.repeat(MAX_BODY_CHARS + 50)}\r\n`;
    const d = await detailFromParsed('1', 'INBOX', await parse(big), [], false, { format: 'full', includeAttachments: false });
    expect(d.text!.length).toBe(MAX_BODY_CHARS);
    expect(d.text_truncated).toBe(true);
    const small = await detailFromParsed('1', 'INBOX', await parse(RAW), [], false, { format: 'full', includeAttachments: false });
    expect(small.text_truncated).toBeUndefined();
  });

  it('makeSnippet truncates and collapses whitespace', () => {
    expect(makeSnippet('a\n\n b', 10)).toBe('a b');
    expect(makeSnippet('x'.repeat(300)).length).toBe(201);
    expect(makeSnippet(undefined)).toBe('');
  });

  it('safeFilename strips paths and control chars', () => {
    expect(safeFilename('..\\..\\win.ini', 0)).toBe('win.ini');
    expect(safeFilename('a/b/c:d?.txt', 0)).toBe('c_d_.txt');
    expect(safeFilename('...', 2)).toBe('attachment-3');
    expect(safeFilename(undefined, 0)).toBe('attachment-1');
  });
});

describe('reply headers', () => {
  const orig: OriginalForReply = {
    messageId: '<m2@example.com>',
    references: ['<m0@example.com>', '<m1@example.com>'],
    subject: 'Hello',
    from: [{ name: 'Alice', address: 'alice@example.com' }],
    replyTo: [],
    to: [{ address: 'me@example.com' }, { address: 'carol@example.com' }],
    cc: [{ address: 'dave@example.com' }, { address: 'ALICE@example.com' }],
  };

  it('replySubject adds Re: once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('RE:Hello')).toBe('RE:Hello');
    expect(replySubject('回复：你好')).toBe('回复：你好');
  });

  it('reply goes to sender and chains References', () => {
    const h = buildReplyHeaders(orig, 'me@example.com', false);
    expect(h.to).toEqual(['"Alice" <alice@example.com>']);
    expect(h.cc).toEqual([]);
    expect(h.inReplyTo).toBe('<m2@example.com>');
    expect(h.references).toEqual(['<m0@example.com>', '<m1@example.com>', '<m2@example.com>']);
    expect(h.subject).toBe('Re: Hello');
  });

  it('reply_all adds To/Cc minus self and duplicates', () => {
    const h = buildReplyHeaders(orig, 'ME@example.com', true);
    expect(h.cc).toEqual(['carol@example.com', 'dave@example.com']);
  });

  it('prefers Reply-To', () => {
    const h = buildReplyHeaders({ ...orig, replyTo: [{ address: 'list@example.com' }] }, 'me@example.com', false);
    expect(h.to).toEqual(['list@example.com']);
  });

  it('excludes every own address (aliases) from reply-all and dedups case-insensitively', () => {
    const o: OriginalForReply = {
      ...orig,
      replyTo: [{ address: 'Alice@Example.com' }],
      to: [{ address: 'alias@example.com' }, { address: 'carol@example.com' }, { address: 'CAROL@example.com' }],
      cc: [{ address: 'me@example.com' }, { address: 'alice@example.com' }, { address: 'dave@example.com' }],
    };
    const h = buildReplyHeaders(o, ['me@example.com', 'alias@example.com'], true);
    expect(h.to).toEqual(['Alice@Example.com']);
    expect(h.cc).toEqual(['carol@example.com', 'dave@example.com']);
  });

  it('falls back to From when Reply-To is empty or has no address', () => {
    const h = buildReplyHeaders({ ...orig, replyTo: [{ name: 'nobody' }] }, 'me@example.com', false);
    expect(h.to).toEqual(['"Alice" <alice@example.com>']);
  });

  it('replying to my own sent message targets its recipients', () => {
    const h = buildReplyHeaders({ ...orig, from: [{ address: 'me@example.com' }] }, 'me@example.com', false);
    expect(h.to).toEqual(['carol@example.com']);
  });
});

describe('matchesCriteria (POP3 local search)', () => {
  it('matches case-insensitively on each field', async () => {
    const m = await parse(RAW);
    expect(matchesCriteria(m, {})).toBe(true);
    expect(matchesCriteria(m, { from: 'ALICE' })).toBe(true);
    expect(matchesCriteria(m, { from: 'bob' })).toBe(false);
    expect(matchesCriteria(m, { to: 'dave@' })).toBe(true); // cc counts as recipient
    expect(matchesCriteria(m, { subject: 'hello' })).toBe(true);
    expect(matchesCriteria(m, { text: 'pineapple' })).toBe(true);
    expect(matchesCriteria(m, { text: 'mango' })).toBe(false);
    expect(matchesCriteria(m, { since: new Date('2026-09-15') })).toBe(true);
    expect(matchesCriteria(m, { since: new Date('2026-09-16') })).toBe(false);
    expect(matchesCriteria(m, { before: new Date('2026-09-15') })).toBe(false);
    expect(matchesCriteria(m, { before: new Date('2026-09-16') })).toBe(true);
  });
});
