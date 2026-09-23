/**
 * Configuration is read exclusively from environment variables.
 *
 * Platform constraint: EMAIL_PASSWORD is the only env key whose name contains
 * any of TOKEN / KEY / SECRET / PASSWORD / PAT / AUTHORIZATION
 * (case-insensitive). Do not add keys that break this rule; a unit test
 * enforces it against SUPPORTED_ENV_KEYS.
 */

import os from 'node:os';
import path from 'node:path';

export type Security = 'ssl' | 'starttls' | 'none';
export type ReceiveProtocol = 'imap' | 'pop3';

export interface Endpoint {
  host: string;
  port: number;
  security: Security;
}

export interface Config {
  user: string;
  password: string;
  fromName?: string;
  receiveProtocol: ReceiveProtocol;
  imap?: Endpoint;
  pop3?: Endpoint;
  smtp: Endpoint;
  tlsVerify: boolean;
  timeoutMs: number;
  /** IMAP only: APPEND a copy of sent mail to the Sent folder. */
  saveSent: boolean;
  /** Canonical-or-configured directories attachments may be read from. */
  attachmentRoots: string[];
  /** Per-attachment and per-message total limit, in bytes. */
  maxAttachmentBytes: number;
  /** Lower-cased addresses that belong to this account (EMAIL_USER + EMAIL_ALIASES). */
  ownAddresses: string[];
}

export const SUPPORTED_ENV_KEYS = [
  'EMAIL_USER',
  'EMAIL_PASSWORD',
  'EMAIL_FROM_NAME',
  'RECEIVE_PROTOCOL',
  'IMAP_HOST',
  'IMAP_PORT',
  'IMAP_SECURE',
  'POP3_HOST',
  'POP3_PORT',
  'POP3_SECURE',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'EMAIL_TLS_VERIFY',
  'EMAIL_TIMEOUT_MS',
  'EMAIL_SAVE_SENT',
  'EMAIL_ATTACHMENT_ROOTS',
  'EMAIL_MAX_ATTACHMENT_MB',
  'EMAIL_ALIASES',
  'EMAIL_LOG_LEVEL',
] as const;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid email-mcp configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_PORTS: Record<'imap' | 'pop3' | 'smtp', Record<Security, number>> = {
  imap: { ssl: 993, starttls: 143, none: 143 },
  pop3: { ssl: 995, starttls: 110, none: 110 },
  smtp: { ssl: 465, starttls: 587, none: 25 },
};

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Security implied by a well-known port when *_SECURE is not set. */
const PORT_SECURITY: Record<'imap' | 'pop3' | 'smtp', Record<number, Security>> = {
  imap: { 993: 'ssl', 143: 'starttls' },
  pop3: { 995: 'ssl' },
  smtp: { 465: 'ssl', 587: 'starttls', 25: 'starttls' },
};

function parseSecurity(env: Env, key: string, problems: string[]): Security | undefined {
  const raw = str(env, key);
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === 'ssl' || v === 'tls' || v === 'true') return 'ssl';
  if (v === 'starttls') return 'starttls';
  if (v === 'none' || v === 'false' || v === 'plain') return 'none';
  problems.push(`${key} must be one of ssl | starttls | none (got "${raw}")`);
  return 'ssl';
}

function parsePort(env: Env, key: string, fallback: number, problems: string[]): number {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    problems.push(`${key} must be an integer between 1 and 65535 (got "${raw}")`);
    return fallback;
  }
  return n;
}

function parseBool(env: Env, key: string, fallback: boolean, problems: string[]): boolean {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  problems.push(`${key} must be true or false (got "${raw}")`);
  return fallback;
}

function endpoint(
  env: Env,
  prefix: 'IMAP' | 'POP3' | 'SMTP',
  problems: string[],
): Endpoint {
  const kind = prefix.toLowerCase() as 'imap' | 'pop3' | 'smtp';
  const explicit = parseSecurity(env, `${prefix}_SECURE`, problems);
  const host = str(env, `${prefix}_HOST`);
  if (!host) problems.push(`${prefix}_HOST is required`);
  const portGiven = str(env, `${prefix}_PORT`) !== undefined;
  let security: Security = explicit ?? 'ssl';
  let port = parsePort(env, `${prefix}_PORT`, DEFAULT_PORTS[kind][security], problems);
  if (explicit === undefined && portGiven) {
    // No *_SECURE: infer from well-known ports (e.g. SMTP 465 -> ssl, 587/25 -> starttls).
    const implied = PORT_SECURITY[kind][port];
    if (implied) security = implied;
    else if (kind === 'pop3' && port === 110) {
      problems.push('POP3_PORT=110 is plaintext POP3: set POP3_SECURE=none explicitly, or use POP3_PORT=995 (ssl)');
    }
  }
  return { host: host ?? '', port, security };
}

/** Parse and validate config. Never includes the password in any message. */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const user = str(env, 'EMAIL_USER');
  if (!user) problems.push('EMAIL_USER is required (your full email address / login name)');

  // Do not trim the password: some providers allow leading/trailing spaces.
  const password = env.EMAIL_PASSWORD;
  if (password === undefined || password === '') {
    problems.push('EMAIL_PASSWORD is required (use the provider app password / authorization code)');
  }

  const protoRaw = (str(env, 'RECEIVE_PROTOCOL') ?? 'imap').toLowerCase();
  let receiveProtocol: ReceiveProtocol = 'imap';
  if (protoRaw === 'imap' || protoRaw === 'pop3') {
    receiveProtocol = protoRaw;
  } else {
    problems.push(`RECEIVE_PROTOCOL must be imap or pop3 (got "${protoRaw}")`);
  }

  const smtp = endpoint(env, 'SMTP', problems);
  let imap: Endpoint | undefined;
  let pop3: Endpoint | undefined;
  if (receiveProtocol === 'imap') {
    imap = endpoint(env, 'IMAP', problems);
  } else {
    pop3 = endpoint(env, 'POP3', problems);
    if (pop3.security === 'starttls') {
      problems.push(
        'POP3_SECURE=starttls is not supported by the POP3 client; use POP3_SECURE=ssl (usually port 995)',
      );
    }
  }

  const tlsVerify = parseBool(env, 'EMAIL_TLS_VERIFY', true, problems);
  const saveSent = parseBool(env, 'EMAIL_SAVE_SENT', true, problems);

  const rootsRaw = str(env, 'EMAIL_ATTACHMENT_ROOTS');
  const attachmentRoots = rootsRaw
    ? rootsRaw
        .split(path.delimiter)
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => path.resolve(r))
    : [process.cwd(), os.tmpdir()];
  if (rootsRaw && !attachmentRoots.length) problems.push('EMAIL_ATTACHMENT_ROOTS is set but contains no directories');

  let maxAttachmentBytes = 25 * 1024 * 1024;
  const mbRaw = str(env, 'EMAIL_MAX_ATTACHMENT_MB');
  if (mbRaw !== undefined) {
    const n = Number(mbRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 1024) {
      problems.push(`EMAIL_MAX_ATTACHMENT_MB must be a number greater than 0 and at most 1024 (got "${mbRaw}")`);
    } else {
      maxAttachmentBytes = Math.floor(n * 1024 * 1024);
    }
  }

  const aliases = (str(env, 'EMAIL_ALIASES') ?? '')
    .split(/[,;\s]+/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  let timeoutMs = 30_000;
  const tRaw = str(env, 'EMAIL_TIMEOUT_MS');
  if (tRaw !== undefined) {
    const n = Number(tRaw);
    if (!Number.isInteger(n) || n < 1000 || n > 600_000) {
      problems.push(`EMAIL_TIMEOUT_MS must be an integer between 1000 and 600000 (got "${tRaw}")`);
    } else {
      timeoutMs = n;
    }
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    user: user!,
    password: password!,
    fromName: str(env, 'EMAIL_FROM_NAME'),
    receiveProtocol,
    imap,
    pop3,
    smtp,
    tlsVerify,
    timeoutMs,
    saveSent,
    attachmentRoots,
    maxAttachmentBytes,
    ownAddresses: [...new Set([user!.toLowerCase(), ...aliases])],
  };
}

/** A redacted view of the config that is safe to log. */
export function describeConfig(c: Config): string {
  const ep = (e?: Endpoint) => (e ? `${e.host}:${e.port}/${e.security}` : '-');
  return [
    `user=${c.user}`,
    `receive=${c.receiveProtocol}`,
    c.imap ? `imap=${ep(c.imap)}` : `pop3=${ep(c.pop3)}`,
    `smtp=${ep(c.smtp)}`,
    `tlsVerify=${c.tlsVerify}`,
    `timeoutMs=${c.timeoutMs}`,
    `saveSent=${c.saveSent && c.receiveProtocol === 'imap'}`,
    `maxAttachmentMB=${(c.maxAttachmentBytes / 1024 / 1024).toFixed(1)}`,
  ].join(' ');
}
