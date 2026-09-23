import type { TlsOptions } from 'node:tls';
import Pop3Command from 'node-pop3';
import type { ParsedMail } from 'mailparser';
import type { Config, Endpoint } from './config.js';
import { EmailError, classifyError, sniFor, withTimeout } from './errors.js';
import {
  detailFromParsed,
  matchesCriteria,
  originalFromParsed,
  parse,
  summaryFromParsed,
  type EmailSummary,
} from './message.js';
import type { GetParams, ListParams, ListResult, Receiver, SearchParams } from './receiver.js';

/** POP3 has no server-side search: we scan at most this many of the newest messages. */
export const POP3_SEARCH_WINDOW = 200;
/** Lines of body requested via TOP for list summaries (for the snippet). */
const SUMMARY_BODY_LINES = 40;
const MAX_MAIL_BYTES = 50 * 1024 * 1024;

const POP3_NOTE =
  'POP3 only exposes INBOX, has no read/unread flags and no server-side search; "uid" is the POP3 UIDL value.';

type Entry = { num: string; uid: string };

function assertInbox(folder: string): void {
  if (folder.toUpperCase() !== 'INBOX') {
    throw new EmailError('INVALID_INPUT', `POP3 only supports the INBOX folder (got "${folder}"). Switch RECEIVE_PROTOCOL to imap for folders.`);
  }
}

export class Pop3Receiver implements Receiver {
  readonly protocol = 'pop3' as const;
  private readonly ep: Endpoint;

  constructor(private readonly cfg: Config) {
    if (!cfg.pop3) throw new Error('POP3 endpoint not configured');
    this.ep = cfg.pop3;
  }

  private async withClient<T>(what: string, fn: (c: Pop3Command) => Promise<T>): Promise<T> {
    const { cfg, ep } = this;
    const c = new Pop3Command({
      user: cfg.user,
      password: cfg.password,
      host: ep.host,
      port: ep.port,
      tls: ep.security === 'ssl',
      timeout: cfg.timeoutMs,
      streamReadTimeout: cfg.timeoutMs,
      maxMailSize: MAX_MAIL_BYTES,
      ...sniFor(ep.host),
      // node-pop3 falls back to `host` for SNI; explicitly unset it for IP hosts (RFC 6066).
      tlsOptions: { rejectUnauthorized: cfg.tlsVerify, servername: sniFor(ep.host).servername } as TlsOptions,
    });
    // Late socket errors must never become unhandled 'error' events.
    c.on('error', () => {});
    const destroy = () => {
      const s = (c as unknown as { _socket?: { destroy(): void } | null })._socket;
      try {
        s?.destroy();
      } catch {
        /* ignore */
      }
    };
    let ok = false;
    try {
      const r = await withTimeout(fn(c), cfg.timeoutMs, `POP3 ${what}`, destroy);
      ok = true;
      return r;
    } catch (err) {
      if (err instanceof EmailError) throw err;
      throw classifyError(err, 'pop3', this.ep);
    } finally {
      if (ok) await withTimeout(c.QUIT(), 5000, 'POP3 QUIT', destroy).catch(destroy);
      else destroy();
    }
  }

  private async entries(c: Pop3Command): Promise<Entry[]> {
    const rows = (await c.UIDL()) as string[][];
    return rows.filter((r) => Array.isArray(r) && r.length >= 2).map((r) => ({ num: r[0], uid: r[1] }));
  }

  private async top(c: Pop3Command, num: string, lines: number): Promise<ParsedMail> {
    return parse((await c.TOP(Number(num), lines)) as string);
  }

  private async retr(c: Pop3Command, num: string): Promise<ParsedMail> {
    return parse((await c.RETR(Number(num))) as string);
  }

  async list(p: ListParams): Promise<ListResult> {
    assertInbox(p.folder);
    return this.withClient('list', async (c) => {
      const all = await this.entries(c);
      const newest = all.slice(-p.limit).reverse();
      const emails: EmailSummary[] = [];
      for (const e of newest) {
        emails.push(summaryFromParsed(e.uid, await this.top(c, e.num, SUMMARY_BODY_LINES), [], null));
      }
      const notes = [POP3_NOTE];
      if (p.unreadOnly) notes.unshift('unread_only is not supported over POP3 (no read/unread state); showing the newest messages instead.');
      return { folder: 'INBOX', total: all.length, emails, note: notes.join(' ') };
    });
  }

  async search(p: SearchParams): Promise<ListResult> {
    assertInbox(p.folder);
    return this.withClient('search', async (c) => {
      const all = await this.entries(c);
      const window = all.slice(-POP3_SEARCH_WINDOW).reverse();
      const needBody = Boolean(p.text);
      const emails: EmailSummary[] = [];
      for (const e of window) {
        if (emails.length >= p.limit) break;
        const mail = needBody ? await this.retr(c, e.num) : await this.top(c, e.num, SUMMARY_BODY_LINES);
        if (matchesCriteria(mail, p)) emails.push(summaryFromParsed(e.uid, mail, [], null));
      }
      const scanned = window.length;
      return {
        folder: 'INBOX',
        emails,
        note: `POP3 search is performed locally over the newest ${scanned} message(s) (max ${POP3_SEARCH_WINDOW}); older messages are not searched. ${POP3_NOTE}`,
      };
    });
  }

  private async numFor(c: Pop3Command, uid: string): Promise<string> {
    const e = (await this.entries(c)).find((x) => x.uid === uid);
    if (!e) throw new EmailError('NOT_FOUND', `No message with POP3 UIDL "${uid}" in INBOX`);
    return e.num;
  }

  async get(p: GetParams) {
    assertInbox(p.folder);
    return this.withClient('get', async (c) => {
      const mail = await this.retr(c, await this.numFor(c, p.uid));
      return detailFromParsed(p.uid, 'INBOX', mail, [], null, {
        format: p.format,
        includeAttachments: p.includeAttachments,
        maxAttachmentBytes: this.cfg.maxAttachmentBytes,
      });
    });
  }

  async getOriginal(p: { uid?: string; messageId?: string; folder: string }) {
    assertInbox(p.folder);
    return this.withClient('fetch original', async (c) => {
      if (p.uid !== undefined) return originalFromParsed(await this.top(c, await this.numFor(c, p.uid), 0));
      const window = (await this.entries(c)).slice(-POP3_SEARCH_WINDOW).reverse();
      for (const e of window) {
        const mail = await this.top(c, e.num, 0);
        if (mail.messageId === p.messageId) return originalFromParsed(mail);
      }
      throw new EmailError('NOT_FOUND', `No message with Message-ID ${p.messageId} among the newest ${window.length} POP3 messages`);
    });
  }
}
