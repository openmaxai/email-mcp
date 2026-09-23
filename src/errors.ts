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
export function classifyError(err: unknown, stage: 'smtp' | 'imap' | 'pop3' | 'other' = 'other'): EmailError {
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
      `Authentication failed (${stage.toUpperCase()}). Check EMAIL_USER and EMAIL_PASSWORD; most providers require IMAP/POP3/SMTP to be enabled and an app password / authorization code instead of the login password. Server said: ${msg}`,
    );
  }

  // --- timeouts ---
  if (TIMEOUT_CODES.has(code) || TIMEOUT_CODES.has(causeCode) || (stage === 'pop3' && e.eventName === 'timeout')) {
    return new EmailError('TIMEOUT', `${stage.toUpperCase()} operation timed out: ${msg}`);
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
    const tlsHint = isTlsProblem(code || causeCode, rawMsg)
      ? ' (TLS problem: check *_SECURE / *_PORT, or EMAIL_TLS_REJECT_UNAUTHORIZED for self-signed servers)'
      : '';
    return new EmailError('UNREACHABLE', `Cannot reach ${stage.toUpperCase()} server${tlsHint}: ${code ? code + ' ' : ''}${msg}`);
  }
  if (stage === 'pop3' && (e.eventName === 'close' || e.eventName === 'end' || e.eventName === 'bad-server-response' || rawMsg === 'no-socket')) {
    return new EmailError('UNREACHABLE', `POP3 connection closed unexpectedly: ${msg}`);
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
