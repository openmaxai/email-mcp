import { stat } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
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

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function addrList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((a) => (typeof a === 'string' ? a : (a as { address?: string })?.address ?? String(a)));
}

export async function validateAttachments(paths: string[] | undefined) {
  if (!paths?.length) return [];
  const out: { path: string; filename: string }[] = [];
  let total = 0;
  for (const raw of paths) {
    // Relative paths resolve against the server's working directory.
    const p = path.resolve(raw);
    let s;
    try {
      s = await stat(p);
    } catch {
      throw new EmailError('INVALID_INPUT', `Attachment not found or not readable: ${p}`);
    }
    if (!s.isFile()) throw new EmailError('INVALID_INPUT', `Attachment is not a regular file: ${p}`);
    total += s.size;
    out.push({ path: p, filename: path.basename(p) });
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new EmailError('INVALID_INPUT', `Attachments total ${total} bytes, above the ${MAX_ATTACHMENT_BYTES} byte limit`);
  }
  return out;
}

export async function sendMail(cfg: Config, msg: OutgoingMessage): Promise<SendResult> {
  const attachments = await validateAttachments(msg.attachments);
  const ep = cfg.smtp;
  const transporter = nodemailer.createTransport({
    host: ep.host,
    port: ep.port,
    secure: ep.security === 'ssl',
    requireTLS: ep.security === 'starttls',
    ignoreTLS: ep.security === 'none',
    auth: { user: cfg.user, pass: cfg.password },
    tls: { rejectUnauthorized: cfg.tlsRejectUnauthorized, ...sniFor(ep.host) },
    connectionTimeout: cfg.timeoutMs,
    greetingTimeout: Math.min(cfg.timeoutMs, 16_000),
    socketTimeout: cfg.timeoutMs,
    logger: false,
    debug: false,
    disableUrlAccess: true,
  });
  try {
    const info = await withTimeout(
      transporter.sendMail({
        from: cfg.fromName ? { name: cfg.fromName, address: cfg.user } : cfg.user,
        to: msg.to,
        cc: msg.cc?.length ? msg.cc : undefined,
        bcc: msg.bcc?.length ? msg.bcc : undefined,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        attachments,
        inReplyTo: msg.inReplyTo,
        references: msg.references?.length ? msg.references : undefined,
      }),
      cfg.timeoutMs,
      'SMTP send',
      () => transporter.close(),
    );
    return {
      message_id: info.messageId,
      accepted: addrList(info.accepted),
      rejected: addrList(info.rejected),
      response: typeof info.response === 'string' ? info.response.slice(0, 200) : undefined,
    };
  } catch (err) {
    throw classifyError(err, 'smtp');
  } finally {
    transporter.close();
  }
}
