/**
 * Configuration is read exclusively from environment variables.
 *
 * Platform constraint: EMAIL_PASSWORD is the only env key whose name contains
 * any of TOKEN / KEY / SECRET / PASSWORD / PAT / AUTHORIZATION
 * (case-insensitive). Do not add keys that break this rule; a unit test
 * enforces it against SUPPORTED_ENV_KEYS.
 */

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
  tlsRejectUnauthorized: boolean;
  timeoutMs: number;
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
  'EMAIL_TLS_REJECT_UNAUTHORIZED',
  'EMAIL_TIMEOUT_MS',
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

function parseSecurity(env: Env, key: string, problems: string[]): Security {
  const raw = str(env, key);
  if (raw === undefined) return 'ssl';
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
  const security = parseSecurity(env, `${prefix}_SECURE`, problems);
  const host = str(env, `${prefix}_HOST`);
  if (!host) problems.push(`${prefix}_HOST is required`);
  const port = parsePort(env, `${prefix}_PORT`, DEFAULT_PORTS[kind][security], problems);
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

  const tlsRejectUnauthorized = parseBool(env, 'EMAIL_TLS_REJECT_UNAUTHORIZED', true, problems);

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
    tlsRejectUnauthorized,
    timeoutMs,
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
    `tlsVerify=${c.tlsRejectUnauthorized}`,
    `timeoutMs=${c.timeoutMs}`,
  ].join(' ');
}
