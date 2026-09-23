import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { EmailError, classifyError, registerSecret } from './errors.js';
import { ImapReceiver } from './imap.js';
import { log } from './logger.js';
import { buildReplyHeaders } from './message.js';
import { Pop3Receiver } from './pop3.js';
import type { Receiver } from './receiver.js';
import { sendMail, type OutgoingMessage } from './smtp.js';

export const VERSION = '0.1.0';

export const COMMON_TOOLS = ['send_email', 'reply_email', 'list_emails', 'get_email', 'search_emails'] as const;
export const IMAP_ONLY_TOOLS = ['list_folders', 'mark_read'] as const;

const addressList = z.array(z.string().min(3).regex(/@/, 'must contain an email address')).max(100);
const uidSchema = z
  .union([z.string().min(1), z.number().int().positive()])
  .describe('Message uid as returned by list_emails / search_emails (IMAP UID, or POP3 UIDL)');
const folderSchema = z.string().min(1).default('INBOX').describe('Mailbox folder (IMAP). POP3 only supports INBOX.');
const limitSchema = z.number().int().min(1).max(100).default(20);
const attachmentsSchema = z
  .array(z.string().min(1))
  .max(20)
  .optional()
  .describe('Local file paths to attach. Only files under the allowed directories (working directory and the temp dir by default) can be attached.');

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err: EmailError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code: err.code, message: err.message } }, null, 2) }],
  };
}

async function run(tool: string, fn: () => Promise<unknown>): Promise<CallToolResult> {
  const t0 = Date.now();
  try {
    const data = await fn();
    log.info(`tool=${tool} ok ms=${Date.now() - t0}`);
    return ok(data);
  } catch (err) {
    const e = classifyError(err);
    log.warn(`tool=${tool} error=${e.code} ms=${Date.now() - t0}`);
    if (e.code === 'UNKNOWN') log.debug(`tool=${tool} detail=${e.message}`);
    return fail(e);
  }
}

function parseDate(v: string | undefined, field: string): Date | undefined {
  if (v === undefined || v === '') return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new EmailError('INVALID_INPUT', `${field} must be an ISO date like 2026-09-01 (got "${v}")`);
  return d;
}

function requireBody(text?: string, html?: string): void {
  if (!text && !html) throw new EmailError('INVALID_INPUT', 'Provide at least one of "text" or "html"');
}

/**
 * Send, then (IMAP + EMAIL_SAVE_SENT) append a copy to Sent.
 * A failed append never fails the send: it is reported in `warnings`.
 */
async function sendAndSave(cfg: Config, receiver: Receiver, msg: OutgoingMessage) {
  const wantCopy = cfg.saveSent && receiver instanceof ImapReceiver;
  const { result, raw } = await sendMail(cfg, msg, { buildCopy: wantCopy });
  const out: Record<string, unknown> = { ...result };
  if (wantCopy) {
    if (!raw) {
      out.warnings = ['Sent successfully, but a copy could not be built for the Sent folder.'];
    } else {
      try {
        out.saved_to_sent = await (receiver as ImapReceiver).appendToSent(raw);
      } catch (err) {
        const e = classifyError(err, 'imap');
        log.warn(`save to Sent failed: ${e.code}`);
        out.warnings = [`Sent successfully, but saving a copy to the Sent folder failed (${e.code}): ${e.message}`];
      }
    }
  }
  return out;
}

export function createReceiver(cfg: Config): Receiver {
  return cfg.receiveProtocol === 'pop3' ? new Pop3Receiver(cfg) : new ImapReceiver(cfg);
}

export function createServer(cfg: Config, receiver: Receiver = createReceiver(cfg)): McpServer {
  registerSecret(cfg.password);
  const server = new McpServer({ name: 'email-mcp', version: VERSION });
  const proto = cfg.receiveProtocol.toUpperCase();

  server.registerTool(
    'send_email',
    {
      title: 'Send email',
      description: `Send an email via SMTP from ${cfg.user}. Recipients accept "addr@example.com" or "Name <addr@example.com>".${
        cfg.saveSent && cfg.receiveProtocol === 'imap' ? ' A copy is saved to the IMAP Sent folder.' : ''
      }`,
      inputSchema: {
        to: addressList.min(1).describe('Recipient addresses'),
        cc: addressList.optional(),
        bcc: addressList.optional(),
        subject: z.string().max(998).default(''),
        text: z.string().optional().describe('Plain-text body'),
        html: z.string().optional().describe('HTML body'),
        attachments: attachmentsSchema,
      },
    },
    async (a) =>
      run('send_email', async () => {
        requireBody(a.text, a.html);
        return sendAndSave(cfg, receiver, {
          to: a.to,
          cc: a.cc,
          bcc: a.bcc,
          subject: a.subject,
          text: a.text,
          html: a.html,
          attachments: a.attachments,
        });
      }),
  );

  server.registerTool(
    'reply_email',
    {
      title: 'Reply to email',
      description:
        'Reply to a received message (identified by uid or message_id). Sets In-Reply-To / References so the reply stays in the same thread, and prefixes the subject with "Re:".',
      inputSchema: {
        uid: uidSchema.optional(),
        message_id: z.string().min(3).optional().describe('Message-ID header of the original, e.g. <abc@example.com>'),
        folder: folderSchema,
        text: z.string().optional(),
        html: z.string().optional(),
        reply_all: z.boolean().default(false).describe('Also reply to the original To/Cc recipients (excluding yourself)'),
        cc: addressList.optional(),
        bcc: addressList.optional(),
        attachments: attachmentsSchema,
      },
    },
    async (a) =>
      run('reply_email', async () => {
        if ((a.uid === undefined) === (a.message_id === undefined)) {
          throw new EmailError('INVALID_INPUT', 'Provide exactly one of "uid" or "message_id"');
        }
        requireBody(a.text, a.html);
        const orig = await receiver.getOriginal({
          uid: a.uid === undefined ? undefined : String(a.uid),
          messageId: a.message_id,
          folder: a.folder,
        });
        const h = buildReplyHeaders(orig, cfg.ownAddresses, a.reply_all);
        if (!h.to.length) throw new EmailError('INVALID_INPUT', 'Original message has no usable sender address to reply to');
        const cc = [...h.cc, ...(a.cc ?? [])];
        const res = await sendAndSave(cfg, receiver, {
          to: h.to,
          cc,
          bcc: a.bcc,
          subject: h.subject,
          text: a.text,
          html: a.html,
          attachments: a.attachments,
          inReplyTo: h.inReplyTo,
          references: h.references,
        });
        return { ...res, to: h.to, cc, subject: h.subject, in_reply_to: h.inReplyTo, references: h.references };
      }),
  );

  server.registerTool(
    'list_emails',
    {
      title: 'List emails',
      description: `List the newest messages in a folder (via ${proto}), newest first. Returns summaries: uid, from, to, subject, date, flags/seen, snippet.${
        cfg.receiveProtocol === 'pop3' ? ' POP3: INBOX only, unread_only is not supported.' : ''
      }`,
      inputSchema: {
        folder: folderSchema,
        limit: limitSchema,
        unread_only: z.boolean().default(false),
      },
    },
    async (a) => run('list_emails', () => receiver.list({ folder: a.folder, limit: a.limit, unreadOnly: a.unread_only })),
  );

  server.registerTool(
    'get_email',
    {
      title: 'Get email',
      description:
        'Read one message by uid. format=full returns text/html bodies; format=headers returns only headers. include_attachments=true saves attachments to a private temp dir and returns their paths.',
      inputSchema: {
        uid: uidSchema,
        folder: folderSchema,
        format: z.enum(['full', 'headers']).default('full'),
        include_attachments: z.boolean().default(false),
      },
    },
    async (a) =>
      run('get_email', () =>
        receiver.get({ uid: String(a.uid), folder: a.folder, format: a.format, includeAttachments: a.include_attachments }),
      ),
  );

  server.registerTool(
    'search_emails',
    {
      title: 'Search emails',
      description: `Search messages (case-insensitive substring match). since/before are dates (YYYY-MM-DD); since is inclusive, before exclusive.${
        cfg.receiveProtocol === 'pop3' ? ' POP3: searched locally over the newest 200 messages only.' : ' Runs server-side via IMAP SEARCH.'
      }`,
      inputSchema: {
        from: z.string().min(1).optional(),
        to: z.string().min(1).optional(),
        subject: z.string().min(1).optional(),
        text: z.string().min(1).optional().describe('Matches headers or body'),
        since: z.string().optional(),
        before: z.string().optional(),
        folder: folderSchema,
        limit: limitSchema,
      },
    },
    async (a) =>
      run('search_emails', async () =>
        receiver.search({
          from: a.from,
          to: a.to,
          subject: a.subject,
          text: a.text,
          since: parseDate(a.since, 'since'),
          before: parseDate(a.before, 'before'),
          folder: a.folder,
          limit: a.limit,
        }),
      ),
  );

  if (receiver instanceof ImapReceiver) {
    const imap = receiver;
    server.registerTool(
      'list_folders',
      {
        title: 'List folders',
        description: 'List IMAP folders with message / unseen counts.',
        inputSchema: {},
      },
      async () => run('list_folders', async () => ({ folders: await imap.listFolders() })),
    );

    server.registerTool(
      'mark_read',
      {
        title: 'Mark read / unread',
        description: 'Set or clear the \\Seen flag on a message.',
        inputSchema: {
          uid: uidSchema,
          folder: folderSchema,
          read: z.boolean().default(true),
        },
      },
      async (a) => run('mark_read', () => imap.markRead({ uid: String(a.uid), folder: a.folder, read: a.read })),
    );
  }

  return server;
}
