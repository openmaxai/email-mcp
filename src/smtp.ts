import { randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import type { Config } from './config.js';
import { EmailError, classifyError, sniFor, withTimeout } from './errors.js';

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: string[];
  inReplyTo?: string;
  references?: string[];
}

export interface SendResult {
  message_id: string;
  accepted: string[];
  rejected: string[];
  response?: string;
}

export interface SendOutcome {
  result: SendResult;
  /** RFC 822 copy of what was sent (Bcc kept), for saving to the Sent folder. */
  raw?: Buffer;
}

function addrList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((a) => (typeof a === 'string' ? a : (a as { address?: string })?.address ?? String(a)));
}

function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' ? false : !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function canonicalRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(await realpath(r));
    } catch {
      /* a configured root that does not exist simply allows nothing */
    }
  }
  return out;
}

export interface LoadedAttachment {
  filename: string;
  content: Buffer;
  path: string;
}

/**
 * Validate and read attachments.
 * - Paths are resolved against the working directory, then canonicalised with realpath,
 *   so `../` traversal and symlinks pointing outside the allowed roots are rejected.
 * - Only files under the allowed roots (cwd + os.tmpdir() by default, or EMAIL_ATTACHMENT_ROOTS) are readable.
 * - The file is opened once and read from that handle (no re-open by path later).
 */
export async function loadAttachments(
  paths: string[] | undefined,
  opts: { roots: string[]; maxBytes: number },
): Promise<LoadedAttachment[]> {
  if (!paths?.length) return [];
  const roots = await canonicalRoots(opts.roots);
  const out: LoadedAttachment[] = [];
  let total = 0;
  for (const raw of paths) {
    let real: string;
    try {
      real = await realpath(path.resolve(raw));
    } catch {
      throw new EmailError('INVALID_INPUT', `Attachment not found or not readable: ${raw}`);
    }
    if (!roots.some((r) => isInside(real, r))) {
      throw new EmailError(
        'INVALID_INPUT',
        `Attachment ${raw} is outside the allowed directories (${opts.roots.join(path.delimiter)}). Move the file there or set EMAIL_ATTACHMENT_ROOTS.`,
      );
    }
    const fh = await open(real, 'r').catch(() => {
      throw new EmailError('INVALID_INPUT', `Attachment not readable: ${raw}`);
    });
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new EmailError('INVALID_INPUT', `Attachment is not a regular file: ${raw}`);
      if (st.size > opts.maxBytes) {
        throw new EmailError('INVALID_INPUT', `Attachment ${raw} is ${st.size} bytes, above the ${opts.maxBytes} byte limit (EMAIL_MAX_ATTACHMENT_MB)`);
      }
      total += st.size;
      if (total > opts.maxBytes) {
        throw new EmailError('INVALID_INPUT', `Attachments total more than the ${opts.maxBytes} byte limit (EMAIL_MAX_ATTACHMENT_MB)`);
      }
      out.push({ filename: path.basename(real), content: await fh.readFile(), path: real });
    } finally {
      await fh.close();
    }
  }
  return out;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  const d = at >= 0 ? address.slice(at + 1).replace(/[^A-Za-z0-9.-]/g, '') : '';
  return d || 'localhost';
}

export async function sendMail(cfg: Config, msg: OutgoingMessage, opts: { buildCopy?: boolean } = {}): Promise<SendOutcome> {
  const attachments = await loadAttachments(msg.attachments, { roots: cfg.attachmentRoots, maxBytes: cfg.maxAttachmentBytes });
  const ep = cfg.smtp;
  // Fixed Message-ID and Date so the Sent copy matches the delivered message.
  const mail: Mail.Options = {
    from: cfg.fromName ? { name: cfg.fromName, address: cfg.user } : cfg.user,
    to: msg.to,
    cc: msg.cc?.length ? msg.cc : undefined,
    bcc: msg.bcc?.length ? msg.bcc : undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })),
    inReplyTo: msg.inReplyTo,
    references: msg.references?.length ? msg.references : undefined,
    messageId: `<${randomUUID()}@${domainOf(cfg.user)}>`,
    date: new Date(),
  };
  const transporter = nodemailer.createTransport({
    host: ep.host,
    port: ep.port,
    secure: ep.security === 'ssl',
    requireTLS: ep.security === 'starttls',
    ignoreTLS: ep.security === 'none',
    auth: { user: cfg.user, pass: cfg.password },
    tls: { rejectUnauthorized: cfg.tlsVerify, ...sniFor(ep.host) },
    connectionTimeout: cfg.timeoutMs,
    greetingTimeout: Math.min(cfg.timeoutMs, 16_000),
    socketTimeout: cfg.timeoutMs,
    logger: false,
    debug: false,
    disableUrlAccess: true,
    disableFileAccess: true,
  });
  let info;
  try {
    info = await withTimeout(transporter.sendMail(mail), cfg.timeoutMs, 'SMTP send', () => transporter.close());
  } catch (err) {
    throw classifyError(err, 'smtp', ep);
  } finally {
    transporter.close();
  }
  const outcome: SendOutcome = {
    result: {
      message_id: info.messageId,
      accepted: addrList(info.accepted),
      rejected: addrList(info.rejected),
      response: typeof info.response === 'string' ? info.response.slice(0, 200) : undefined,
    },
  };
  if (opts.buildCopy) {
    try {
      const node = new MailComposer(mail).compile();
      (node as unknown as { keepBcc: boolean }).keepBcc = true;
      outcome.raw = await node.build();
    } catch {
      /* building the copy is best effort; the caller reports a warning */
    }
  }
  return outcome;
}
