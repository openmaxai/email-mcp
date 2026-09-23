import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

export interface Address {
  name?: string;
  address?: string;
}

export interface EmailSummary {
  uid: string;
  message_id?: string;
  from: Address[];
  to: Address[];
  subject: string;
  date?: string;
  /** IMAP flags. Empty under POP3 (not supported by the protocol). */
  flags: string[];
  /** true / false under IMAP; null under POP3 (unknown). */
  seen: boolean | null;
  snippet: string;
  has_attachments?: boolean;
}

export interface AttachmentInfo {
  filename: string;
  content_type: string;
  size: number;
  path?: string;
}

export interface EmailDetail {
  uid: string;
  folder: string;
  message_id?: string;
  in_reply_to?: string;
  references?: string[];
  from: Address[];
  to: Address[];
  cc: Address[];
  reply_to: Address[];
  subject: string;
  date?: string;
  flags: string[];
  seen: boolean | null;
  text?: string;
  html?: string;
  text_truncated?: boolean;
  html_truncated?: boolean;
  attachments: AttachmentInfo[];
  attachments_dir?: string;
}

/** Everything needed to build a reply. */
export interface OriginalForReply {
  messageId?: string;
  references: string[];
  subject: string;
  from: Address[];
  replyTo: Address[];
  to: Address[];
  cc: Address[];
}

export const SNIPPET_LEN = 200;
export const MAX_BODY_CHARS = 100_000;

export function flattenAddresses(a: AddressObject | AddressObject[] | undefined): Address[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  const out: Address[] = [];
  for (const obj of list) {
    for (const v of obj.value ?? []) {
      if (v.group) {
        for (const g of v.group) out.push(clean({ name: g.name, address: g.address }));
      } else {
        out.push(clean({ name: v.name, address: v.address }));
      }
    }
  }
  return out;
}

function clean(a: Address): Address {
  const o: Address = {};
  if (a.name) o.name = a.name;
  if (a.address) o.address = a.address;
  return o;
}

export function makeSnippet(text: string | undefined, len = SNIPPET_LEN): string {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > len ? t.slice(0, len) + '…' : t;
}

export function normalizeReferences(refs: string | string[] | undefined): string[] {
  if (!refs) return [];
  const arr = Array.isArray(refs) ? refs : refs.split(/\s+/);
  return arr.map((r) => r.trim()).filter(Boolean);
}

export async function parse(source: Buffer | string): Promise<ParsedMail> {
  return simpleParser(source, { skipImageLinks: true, skipTextLinks: true });
}

export function summaryFromParsed(
  uid: string,
  mail: ParsedMail,
  flags: string[],
  seen: boolean | null,
  fallbackDate?: Date,
): EmailSummary {
  const date = mail.date ?? fallbackDate;
  const s: EmailSummary = {
    uid,
    message_id: mail.messageId,
    from: flattenAddresses(mail.from),
    to: flattenAddresses(mail.to),
    subject: mail.subject ?? '',
    date: date ? date.toISOString() : undefined,
    flags,
    seen,
    snippet: makeSnippet(mail.text ?? (typeof mail.html === 'string' ? stripHtml(mail.html) : '')),
  };
  if (mail.attachments?.length) s.has_attachments = true;
  return s;
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function truncate(s: string | undefined): { v?: string; truncated: boolean } {
  if (s === undefined) return { truncated: false };
  if (s.length <= MAX_BODY_CHARS) return { v: s, truncated: false };
  return { v: s.slice(0, MAX_BODY_CHARS), truncated: true };
}

/** Replace characters that are unsafe in file names; never allow path traversal. */
export function safeFilename(name: string | undefined, index: number): string {
  const base = path.basename((name ?? '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').slice(0, 200);
  return cleaned || `attachment-${index + 1}`;
}

export async function detailFromParsed(
  uid: string,
  folder: string,
  mail: ParsedMail,
  flags: string[],
  seen: boolean | null,
  opts: { format: 'full' | 'headers'; includeAttachments: boolean },
): Promise<EmailDetail> {
  const d: EmailDetail = {
    uid,
    folder,
    message_id: mail.messageId,
    in_reply_to: mail.inReplyTo,
    references: normalizeReferences(mail.references),
    from: flattenAddresses(mail.from),
    to: flattenAddresses(mail.to),
    cc: flattenAddresses(mail.cc),
    reply_to: flattenAddresses(mail.replyTo),
    subject: mail.subject ?? '',
    date: mail.date?.toISOString(),
    flags,
    seen,
    attachments: (mail.attachments ?? []).map((a, i) => ({
      filename: safeFilename(a.filename, i),
      content_type: a.contentType,
      size: a.size,
    })),
  };
  if (opts.format === 'full') {
    const t = truncate(mail.text);
    const h = truncate(typeof mail.html === 'string' ? mail.html : undefined);
    d.text = t.v;
    d.html = h.v;
    if (t.truncated) d.text_truncated = true;
    if (h.truncated) d.html_truncated = true;
  }
  if (opts.includeAttachments && mail.attachments?.length) {
    const dir = await mkdtemp(path.join(tmpdir(), 'email-mcp-'));
    const used = new Set<string>();
    for (let i = 0; i < mail.attachments.length; i++) {
      const a = mail.attachments[i];
      let name = safeFilename(a.filename, i);
      if (used.has(name)) name = `${i + 1}-${name}`;
      used.add(name);
      const p = path.join(dir, name);
      await writeFile(p, a.content, { mode: 0o600 });
      d.attachments[i].path = p;
      d.attachments[i].filename = name;
    }
    d.attachments_dir = dir;
  }
  return d;
}

export function originalFromParsed(mail: ParsedMail): OriginalForReply {
  return {
    messageId: mail.messageId,
    references: normalizeReferences(mail.references),
    subject: mail.subject ?? '',
    from: flattenAddresses(mail.from),
    replyTo: flattenAddresses(mail.replyTo),
    to: flattenAddresses(mail.to),
    cc: flattenAddresses(mail.cc),
  };
}

export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^(re|回复|答复)\s*[:：]/i.test(s) ? s : `Re: ${s}`;
}

function fmt(a: Address): string {
  return a.name ? `"${a.name.replace(/"/g, "'")}" <${a.address}>` : `${a.address}`;
}

/**
 * Compute reply recipients and threading headers (RFC 5322 section 3.6.4).
 * `self` is excluded from reply-all recipients.
 */
export function buildReplyHeaders(
  orig: OriginalForReply,
  self: string,
  replyAll: boolean,
): { to: string[]; cc: string[]; subject: string; inReplyTo?: string; references: string[] } {
  const me = self.toLowerCase();
  const primary = (orig.replyTo.length ? orig.replyTo : orig.from).filter((a) => a.address);
  const seen = new Set<string>();
  const pick = (list: Address[]) => {
    const out: string[] = [];
    for (const a of list) {
      const addr = a.address?.toLowerCase();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      out.push(fmt(a));
    }
    return out;
  };
  // If I sent the original, reply to its recipients instead of myself.
  let toList = primary;
  if (primary.every((a) => a.address?.toLowerCase() === me) && orig.to.length) toList = orig.to;
  seen.add(me);
  const to = pick(toList);
  const cc = replyAll ? pick([...orig.to, ...orig.cc]) : [];
  const references = [...orig.references];
  if (orig.messageId && !references.includes(orig.messageId)) references.push(orig.messageId);
  return {
    to,
    cc,
    subject: replySubject(orig.subject),
    inReplyTo: orig.messageId,
    references,
  };
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
}

/** Local filter used for POP3 (IMAP searches server-side). Case-insensitive substring matching. */
export function matchesCriteria(mail: ParsedMail, c: SearchCriteria): boolean {
  const inc = (hay: string | undefined, needle: string) => (hay ?? '').toLowerCase().includes(needle.toLowerCase());
  const addrText = (a: AddressObject | AddressObject[] | undefined) =>
    flattenAddresses(a)
      .map((x) => `${x.name ?? ''} ${x.address ?? ''}`)
      .join(' ');
  if (c.from && !inc(addrText(mail.from), c.from)) return false;
  if (c.to && !inc(`${addrText(mail.to)} ${addrText(mail.cc)}`, c.to)) return false;
  if (c.subject && !inc(mail.subject, c.subject)) return false;
  if (c.text) {
    const body = `${mail.subject ?? ''} ${mail.text ?? ''} ${typeof mail.html === 'string' ? stripHtml(mail.html) : ''}`;
    if (!inc(body, c.text)) return false;
  }
  if (c.since || c.before) {
    const d = mail.date;
    if (!d) return false;
    // IMAP semantics: SINCE is inclusive (date >= since day), BEFORE is exclusive.
    if (c.since && d.getTime() < startOfDay(c.since).getTime()) return false;
    if (c.before && d.getTime() >= startOfDay(c.before).getTime()) return false;
  }
  return true;
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
