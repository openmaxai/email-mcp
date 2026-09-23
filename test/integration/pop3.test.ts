import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, envFor, eventually, token, type Harness } from './helpers.js';

for (const mode of ['plain', 'ssl'] as const) {
  describe(`POP3 (${mode})`, () => {
    let sender: Harness;
    let pop: Harness;
    const tag = token();

    beforeAll(async () => {
      sender = await connect(envFor('alice'));
      pop = await connect(envFor('carol', { protocol: 'pop3', mode }));
      for (const i of [1, 2, 3]) {
        const r = await sender.call('send_email', {
          to: ['carol@example.com'],
          subject: `pop ${tag} #${i}`,
          text: `message number ${i} keyword-${tag}-${i}`,
        });
        expect(r.isError, JSON.stringify(r.data)).toBe(false);
      }
    });

    afterAll(async () => {
      await sender?.close();
      await pop?.close();
    });

    it('does not register IMAP-only tools', async () => {
      const names = (await pop.client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('list_folders');
      expect(names).not.toContain('mark_read');
      expect(names).toEqual(expect.arrayContaining(['send_email', 'reply_email', 'list_emails', 'get_email', 'search_emails']));
    });

    it('list_emails uses UIDL as uid, newest first, and get_email reads the message', async () => {
      const mine = await eventually(async () => {
        const r = await pop.call('list_emails', { limit: 100 });
        const m = r.data.emails?.filter((e: any) => e.subject.startsWith(`pop ${tag}`));
        return m?.length === 3 ? { list: r.data, m } : undefined;
      });
      expect(mine.m.map((e: any) => e.subject)).toEqual([`pop ${tag} #3`, `pop ${tag} #2`, `pop ${tag} #1`]);
      expect(mine.m[0].seen).toBeNull();
      expect(mine.m[0].flags).toEqual([]);
      expect(typeof mine.m[0].uid).toBe('string');
      expect(mine.list.note).toMatch(/POP3/);

      const g = await pop.call('get_email', { uid: mine.m[1].uid });
      expect(g.isError).toBe(false);
      expect(g.data.text).toContain(`keyword-${tag}-2`);
      expect(g.data.folder).toBe('INBOX');
    });

    it('unread_only returns a clear note instead of failing', async () => {
      const r = await pop.call('list_emails', { unread_only: true, limit: 5 });
      expect(r.isError).toBe(false);
      expect(r.data.note).toMatch(/unread_only is not supported over POP3/);
    });

    it('search_emails filters locally', async () => {
      const bySubject = await pop.call('search_emails', { subject: `pop ${tag} #2` });
      expect(bySubject.data.emails.map((e: any) => e.subject)).toEqual([`pop ${tag} #2`]);
      expect(bySubject.data.note).toMatch(/newest/);

      const byText = await pop.call('search_emails', { text: `keyword-${tag}-3` });
      expect(byText.data.emails.map((e: any) => e.subject)).toEqual([`pop ${tag} #3`]);

      const byFrom = await pop.call('search_emails', { from: 'alice@', subject: tag, limit: 2 });
      expect(byFrom.data.emails).toHaveLength(2);

      const none = await pop.call('search_emails', { subject: tag, before: '2000-01-01' });
      expect(none.data.emails).toHaveLength(0);
    });

    it('reply_email works from POP3 (uid = UIDL)', async () => {
      const l = await pop.call('search_emails', { subject: `pop ${tag} #1` });
      const r = await pop.call('reply_email', { uid: l.data.emails[0].uid, text: 'got it' });
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
      expect(r.data.subject).toBe(`Re: pop ${tag} #1`);
      expect(r.data.in_reply_to).toBe(l.data.emails[0].message_id);
    });

    it('rejects non-INBOX folders and unknown uids', async () => {
      const f = await pop.call('list_emails', { folder: 'Sent' });
      expect(f.data.error.code).toBe('INVALID_INPUT');
      const nf = await pop.call('get_email', { uid: 'no-such-uidl' });
      expect(nf.data.error.code).toBe('NOT_FOUND');
    });
  });
}
