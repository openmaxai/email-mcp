import { redact } from './errors.js';

/**
 * Logs go to stderr only: stdout is the MCP JSON-RPC channel.
 * Never pass message bodies, subjects or credentials to the logger.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const envLevel = (process.env.EMAIL_LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function write(level: Level, msg: string): void {
  if (LEVELS[level] < threshold) return;
  process.stderr.write(`[email-mcp] ${new Date().toISOString()} ${level.toUpperCase()} ${redact(msg)}\n`);
}

export const log = {
  debug: (m: string) => write('debug', m),
  info: (m: string) => write('info', m),
  warn: (m: string) => write('warn', m),
  error: (m: string) => write('error', m),
};
