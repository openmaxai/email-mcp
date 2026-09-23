import { isIP } from 'node:net';

export const ERROR_CODES = [
  'AUTH_FAILED',
  'UNREACHABLE',
  'SEND_REJECTED',
  'NOT_FOUND',
  'INVALID_INPUT',
  'TIMEOUT',
  'UNKNOWN',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class EmailError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}

const secrets = new Set<string>();

/** Register a value that must never appear in any error text or log line. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 1) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join('***');
  }
  return out;
}

type AnyErr = {
  code?: unknown;
  message?: unknown;
  authenticationFailed?: unknown;
  responseCode?: unknown;
  serverResponseCode?: unknown;
  eventName?: unknown;
  command?: unknown;
  tlsFailed?: unknown;
  cause?: unknown;
};

const NET_UNREACHABLE = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'ECONNECTION', // nodemailer
  'EDNS', // nodemailer
  'ESOCKET', // nodemailer
  'ETLS', // nodemailer
  'NoConnection', // imapflow
  'EConnectionClosed', // imapflow
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ETIMEOUT',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ESOCKETTIMEDOUT',
]);

function isTlsProblem(code: string, msg: string): boolean {
  return /CERT|SSL|TLS/i.test(code) || /certificate|self[- ]signed|wrong version number|handshake/i.test(msg);
}

/**
 * Map an arbitrary library error to a stable error code.
 * `stage` helps disambiguate errors from libraries with weak error typing.
 */
export interface ErrorContext {
  host: string;
  port: number;
  security: 'ssl' | 'starttls' | 'none';
}

interface ProviderHint {
  match: RegExp;
  name: string;
  auth: string;
}

/** Provider-specific guidance, matched on the configured server host name. */
const PROVIDERS: ProviderHint[] = [
  { match: /(^|\.)exmail\.qq\.com$/i, name: 'Tencent Exmail', auth: 'enable IMAP/SMTP in the mailbox client settings; if secure login is on, use a client-specific password (客户端专用密码).' },
  { match: /(^|\.)qq\.com$/i, name: 'QQ Mail', auth: 'in QQ Mail Settings > Account, enable the IMAP/SMTP (or POP3/SMTP) service and use the generated authorization code (授权码), not your QQ password.' },
  { match: /(^|\.)(163|126|yeah)\.net$|(^|\.)(163|126)\.com$/i, name: 'NetEase Mail', auth: 'in Settings > POP3/SMTP/IMAP, enable the service and use the authorization code (授权码), not your login password.' },
  { match: /(^|\.)aliyun\.com$|(^|\.)mxhichina\.com$/i, name: 'Aliyun Mail', auth: 'make sure the administrator allows IMAP/POP/SMTP for your account, and use a third-party client password if one is required.' },
  { match: /(^|\.)(office365|outlook)\.com$/i, name: 'Outlook / Microsoft 365', auth: 'use an app password (requires 2-step verification). Many Microsoft 365 tenants disable basic authentication for IMAP/POP/SMTP entirely; this server does not support OAuth.' },
  { match: /(^|\.)gmail\.com$|(^|\.)googlemail\.com$/i, name: 'Gmail', auth: 'turn on 2-Step Verification, create an App Password, and enable IMAP in Gmail settings.' },
];

const GENERIC_AUTH_HINT =
  'Most providers require you to enable IMAP/SMTP (or POP3/SMTP) in the mailbox settings and to use an authorization code / app password instead of the normal login password.';

export function providerAuthHint(host: string | undefined): string {
  const p = host ? PROVIDERS.find((x) => x.match.test(host)) : undefined;
  return p ? `${p.name}: ${p.auth}` : GENERIC_AUTH_HINT;
}

const STANDARD_PORTS: Record<string, Record<string, number[]>> = {
  imap: { ssl: [993], starttls: [143], none: [143] },
  pop3: { ssl: [995], starttls: [110], none: [110] },
  smtp: { ssl: [465], starttls: [587, 25], none: [25, 587] },
};

function unreachableHint(stage: string, ctx: ErrorContext | undefined, tls: boolean): string {
  if (!ctx) return '';
  const hints: string[] = [];
  const P = stage.toUpperCase();
  const std = STANDARD_PORTS[stage]?.[ctx.security];
  if (std && !std.includes(ctx.port)) {
    hints.push(`${P}_PORT=${ctx.port} is unusual for ${P}_SECURE=${ctx.security} (usually ${std.join(' or ')}); check that port and security match`);
  }
  if (tls) hints.push(`TLS handshake/certificate problem: check ${P}_SECURE (ssl vs starttls) and ${P}_PORT; set EMAIL_TLS_VERIFY=false only for self-signed test servers`);
  hints.push(`verify ${P}_HOST=${ctx.host} is correct and that outbound port ${ctx.port} is not blocked by a firewall`);
  return ` Hints: ${hints.join('; ')}.`;
}

export function classifyError(
  err: unknown,
  stage: 'smtp' | 'imap' | 'pop3' | 'other' = 'other',
  ctx?: ErrorContext,
): EmailError {
  if (err instanceof EmailError) return new EmailError(err.code, redact(err.message));

  const e = (typeof err === 'object' && err !== null ? err : { message: String(err) }) as AnyErr;
  const code = typeof e.code === 'string' ? e.code : '';
  const rawMsg = typeof e.message === 'string' ? e.message : String(err);
  const msg = redact(rawMsg);
  const cause = e.cause as AnyErr | undefined;
  const causeCode = cause && typeof cause.code === 'string' ? cause.code : '';

  // --- authentication ---
  if (
    e.authenticationFailed === true ||
    code === 'EAUTH' ||
    code === 'ENOAUTH' ||
    code === 'AUTHENTICATIONFAILED' ||
    e.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    (stage === 'pop3' &&
      e.eventName === 'error' &&
      typeof e.command === 'string' &&
      /^(USER|PASS)\b/.test(e.command))
  ) {
    return new EmailError(
      'AUTH_FAILED',
      `${stage.toUpperCase()} login was rejected for EMAIL_USER. Check EMAIL_USER and EMAIL_PASSWORD. ${providerAuthHint(ctx?.host)} Server said: ${msg}`,
    );
  }

  // --- timeouts ---
  if (TIMEOUT_CODES.has(code) || TIMEOUT_CODES.has(causeCode) || (stage === 'pop3' && e.eventName === 'timeout')) {
    return new EmailError(
      'TIMEOUT',
      `${stage.toUpperCase()} server did not respond in time: ${msg}.${ctx ? ` Check ${stage.toUpperCase()}_HOST/${stage.toUpperCase()}_PORT (${ctx.host}:${ctx.port}) and ${stage.toUpperCase()}_SECURE=${ctx.security}; a wrong ssl/starttls choice often looks like a hang.` : ''}`,
    );
  }

  // --- SMTP rejection ---
  if (stage === 'smtp') {
    const rc = typeof e.responseCode === 'number' ? e.responseCode : 0;
    if (code === 'EENVELOPE' || code === 'EMESSAGE' || code === 'EREJECTED' || (rc >= 400 && rc < 600)) {
      return new EmailError('SEND_REJECTED', `SMTP server rejected the message: ${msg}`);
    }
  }

  // --- network / TLS ---
  if (NET_UNREACHABLE.has(code) || NET_UNREACHABLE.has(causeCode) || isTlsProblem(code || causeCode, rawMsg)) {
    const tls = isTlsProblem(code || causeCode, rawMsg);
    return new EmailError(
      'UNREACHABLE',
      `Cannot connect to the ${stage.toUpperCase()} server${ctx ? ` ${ctx.host}:${ctx.port}` : ''}: ${code ? code + ' ' : ''}${msg}.${unreachableHint(stage, ctx, tls)}`,
    );
  }
  if (stage === 'pop3' && (e.eventName === 'close' || e.eventName === 'end' || e.eventName === 'bad-server-response' || rawMsg === 'no-socket')) {
    return new EmailError('UNREACHABLE', `POP3 connection closed unexpectedly: ${msg}.${unreachableHint(stage, ctx, false)}`);
  }

  return new EmailError('UNKNOWN', `${stage === 'other' ? '' : stage.toUpperCase() + ' '}error: ${code ? code + ' ' : ''}${msg}`);
}

export class TimeoutError extends Error {
  code = 'ETIMEOUT';
  constructor(what: string, ms: number) {
    super(`${what} did not complete within ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Race a promise against a deadline. `onTimeout` should tear down the connection. */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // Avoid an unhandled rejection if the underlying op fails after we timed out.
  p.catch(() => {});
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* ignore */
      }
      reject(new TimeoutError(what, ms));
    }, ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

/** TLS SNI must not be an IP address (RFC 6066); only set servername for DNS names. */
export function sniFor(host: string): { servername?: string } {
  return isIP(host) ? {} : { servername: host };
}
