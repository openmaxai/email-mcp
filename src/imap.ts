import { ImapFlow, type FetchMessageObject, type SearchObject } from 'imapflow';
import type { Config, Endpoint } from './config.js';
import { EmailError, classifyError, sniFor, withTimeout } from './errors.js';
import {
  detailFromParsed,
  originalFromParsed,
  parse,
  summaryFromParsed,
  type EmailSummary,
} from './message.js';
import type {
  FolderInfo,
  GetParams,
  ImapExtras,
  ListParams,
  ListResult,
  Receiver,
  SearchParams,
} from './receiver.js';

/** Bytes of the raw message fetched for list/search summaries (headers + start of body). */
const SUMMARY_BYTES = 16 * 1024;

function uidNumber(uid: string): number {
  const n = Number(uid);
  if (!Number.isInteger(n) || n <= 0) throw new EmailError('INVALID_INPUT', `IMAP uid must be a positive integer (got "${uid}")`);
  return n;
}

function isMissingMailbox(err: unknown): boolean {
  const e = err as { mailboxMissing?: boolean; serverResponseCode?: string; responseText?: string; message?: string };
  return (
    e?.mailboxMissing === true ||
    e?.serverResponseCode === 'NONEXISTENT' ||
    /nonexistent|doesn'?t exist|does not exist|no such mailbox|not found|unknown mailbox/i.test(
      `${e?.responseText ?? ''} ${e?.message ?? ''}`,
    )
  );
}

export class ImapReceiver implements Receiver, ImapExtras {
  readonly protocol = 'imap' as const;
  private readonly ep: Endpoint;

  constructor(private readonly cfg: Config) {
    if (!cfg.imap) throw new Error('IMAP endpoint not configured');
    this.ep = cfg.imap;
  }

  /** Open a connection for a single call, always close it afterwards. */
  private async withClient<T>(what: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const { cfg, ep } = this;
    const client = new ImapFlow({
      host: ep.host,
      port: ep.port,
      secure: ep.security === 'ssl',
      doSTARTTLS: ep.security === 'starttls' ? true : ep.security === 'none' ? false : undefined,
      auth: { user: cfg.user, pass: cfg.password },
      tls: { rejectUnauthorized: cfg.tlsRejectUnauthorized, ...sniFor(ep.host) },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: cfg.timeoutMs,
      greetingTimeout: Math.min(cfg.timeoutMs, 16_000),
      socketTimeout: cfg.timeoutMs * 2,
    });
    // Unhandled 'error' events would crash the process.
    client.on('error', () => {});
    const hardClose = () => {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    };
    try {
      return await withTimeout(
        (async () => {
          await client.connect();
          return fn(client);
        })(),
        cfg.timeoutMs,
        `IMAP ${what}`,
        hardClose,
      );
    } catch (err) {
      if (err instanceof EmailError) throw err;
      throw classifyError(err, 'imap');
    } finally {
      if (client.usable) {
        await withTimeout(client.logout(), 5000, 'IMAP logout', hardClose).catch(hardClose);
      } else {
        hardClose();
      }
    }
  }

  private async withMailbox<T>(c: ImapFlow, folder: string, readOnly: boolean, fn: () => Promise<T>): Promise<T> {
    let lock;
    try {
      lock = await c.getMailboxLock(folder, { readOnly });
    } catch (err) {
      if (isMissingMailbox(err)) throw new EmailError('NOT_FOUND', `Folder "${folder}" does not exist. Use list_folders to see available folders.`);
      throw err;
    }
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }

  private async summaries(c: ImapFlow, uids: number[]): Promise<EmailSummary[]> {
    if (!uids.length) return [];
    const msgs: FetchMessageObject[] = await c.fetchAll(
      uids.join(','),
      { uid: true, flags: true, internalDate: true, source: { start: 0, maxLength: SUMMARY_BYTES } },
      { uid: true },
    );
    const byUid = new Map<number, FetchMessageObject>(msgs.map((m) => [m.uid, m]));
    const out: EmailSummary[] = [];
    for (const uid of uids) {
      const m = byUid.get(uid);
      if (!m) continue;
      const parsed = await parse(m.source ?? Buffer.alloc(0));
      const flags = [...(m.flags ?? [])];
      const internal = m.internalDate ? new Date(m.internalDate) : undefined;
      out.push(summaryFromParsed(String(uid), parsed, flags, flags.includes('\\Seen'), internal));
    }
    return out;
  }

  private async searchUids(c: ImapFlow, q: SearchObject): Promise<number[]> {
    const r = await c.search(q, { uid: true });
    return Array.isArray(r) ? r : [];
  }

  async list(p: ListParams): Promise<ListResult> {
    return this.withClient('list', (c) =>
      this.withMailbox(c, p.folder, true, async () => {
        const uids = await this.searchUids(c, p.unreadOnly ? { seen: false } : { all: true });
        uids.sort((a, b) => b - a);
        const emails = await this.summaries(c, uids.slice(0, p.limit));
        return { folder: p.folder, total: uids.length, emails };
      }),
    );
  }

  async search(p: SearchParams): Promise<ListResult> {
    const q: SearchObject = {};
    if (p.from) q.from = p.from;
    if (p.to) q.to = p.to;
    if (p.subject) q.subject = p.subject;
    if (p.text) q.text = p.text;
    if (p.since) q.since = p.since;
    if (p.before) q.before = p.before;
    if (!Object.keys(q).length) q.all = true;
    return this.withClient('search', (c) =>
      this.withMailbox(c, p.folder, true, async () => {
        const uids = await this.searchUids(c, q);
        uids.sort((a, b) => b - a);
        const emails = await this.summaries(c, uids.slice(0, p.limit));
        return { folder: p.folder, total: uids.length, emails };
      }),
    );
  }

  private async fetchFull(c: ImapFlow, uid: number): Promise<FetchMessageObject> {
    const m = await c.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true });
    if (!m || !m.source) throw new EmailError('NOT_FOUND', `No message with uid ${uid} in this folder`);
    return m;
  }

  async get(p: GetParams) {
    const uid = uidNumber(p.uid);
    return this.withClient('get', (c) =>
      this.withMailbox(c, p.folder, true, async () => {
        const m = await this.fetchFull(c, uid);
        const parsed = await parse(m.source!);
        const flags = [...(m.flags ?? [])];
        return detailFromParsed(String(uid), p.folder, parsed, flags, flags.includes('\\Seen'), {
          format: p.format,
          includeAttachments: p.includeAttachments,
        });
      }),
    );
  }

  async getOriginal(p: { uid?: string; messageId?: string; folder: string }) {
    return this.withClient('fetch original', (c) =>
      this.withMailbox(c, p.folder, true, async () => {
        let uid: number;
        if (p.uid !== undefined) {
          uid = uidNumber(p.uid);
        } else {
          const uids = await this.searchUids(c, { header: { 'message-id': p.messageId! } });
          if (!uids.length) throw new EmailError('NOT_FOUND', `No message with Message-ID ${p.messageId} in folder "${p.folder}"`);
          uid = Math.max(...uids);
        }
        const m = await this.fetchFull(c, uid);
        return originalFromParsed(await parse(m.source!));
      }),
    );
  }

  async listFolders(): Promise<FolderInfo[]> {
    return this.withClient('list folders', async (c) => {
      const boxes = await c.list({ statusQuery: { messages: true, unseen: true } });
      return boxes.map((b) => {
        const f: FolderInfo = { path: b.path, name: b.name };
        if (b.delimiter) f.delimiter = b.delimiter;
        if (b.specialUse) f.special_use = b.specialUse;
        if (b.status?.messages !== undefined) f.messages = b.status.messages;
        if (b.status?.unseen !== undefined) f.unseen = b.status.unseen;
        return f;
      });
    });
  }

  async markRead(p: { uid: string; folder: string; read: boolean }) {
    const uid = uidNumber(p.uid);
    return this.withClient('mark read', (c) =>
      this.withMailbox(c, p.folder, false, async () => {
        const found = await this.searchUids(c, { uid: String(uid) });
        if (!found.includes(uid)) throw new EmailError('NOT_FOUND', `No message with uid ${uid} in folder "${p.folder}"`);
        if (p.read) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        else await c.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
        return { uid: String(uid), folder: p.folder, seen: p.read };
      }),
    );
  }
}
