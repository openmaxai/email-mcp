#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { log } from './logger.js';
import { VERSION, createServer } from './server.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[email-mcp] ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  for (const [name, ep] of [['IMAP', cfg.imap], ['POP3', cfg.pop3], ['SMTP', cfg.smtp]] as const) {
    if (ep?.security === 'none') log.warn(`${name}_SECURE=none: credentials and mail are sent in plaintext`);
  }
  if (!cfg.tlsVerify) log.warn('EMAIL_TLS_VERIFY=false: TLS certificates are not verified');

  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
  log.info(`email-mcp ${VERSION} ready (${describeConfig(cfg)})`);

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
