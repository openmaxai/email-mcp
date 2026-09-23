/**
 * Starts a throwaway GreenMail container (greenmail/standalone) with two users.
 * Set GREENMAIL_HOST (+ optional GREENMAIL_*_PORT) to use an already running instance.
 */
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import type { TestProject } from 'vitest/node';

export interface GreenMailInfo {
  host: string;
  smtp: number;
  smtps: number;
  imap: number;
  imaps: number;
  pop3: number;
  pop3s: number;
}

declare module 'vitest' {
  export interface ProvidedContext {
    greenmail: GreenMailInfo;
  }
}

const IMAGE = process.env.GREENMAIL_IMAGE ?? 'greenmail/standalone:2.1.14';
const PORTS = { smtp: 3025, smtps: 3465, imap: 3143, imaps: 3993, pop3: 3110, pop3s: 3995 } as const;
let containerName: string | undefined;

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function waitForGreeting(host: string, port: number, prefix: string, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect({ host, port });
      let buf = '';
      let done = false;
      const retry = () => {
        if (done) return;
        done = true;
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`GreenMail port ${port} not ready`));
        else setTimeout(attempt, 500);
      };
      s.setTimeout(2000, retry);
      s.on('error', retry);
      // docker-proxy accepts and then closes while the container is still starting
      s.on('close', retry);
      s.on('data', (d) => {
        buf += d.toString();
        if (!done && buf.startsWith(prefix)) {
          done = true;
          s.destroy();
          resolve();
        }
      });
    };
    attempt();
  });
}

export async function setup(project: TestProject): Promise<void> {
  let info: GreenMailInfo;
  if (process.env.GREENMAIL_HOST) {
    const env = (k: keyof typeof PORTS) => Number(process.env[`GREENMAIL_${k.toUpperCase()}_PORT`] ?? PORTS[k]);
    info = {
      host: process.env.GREENMAIL_HOST,
      smtp: env('smtp'),
      smtps: env('smtps'),
      imap: env('imap'),
      imaps: env('imaps'),
      pop3: env('pop3'),
      pop3s: env('pop3s'),
    };
  } else {
    try {
      docker(['info', '--format', '{{.ServerVersion}}']);
    } catch {
      throw new Error('Docker is not available: integration tests need Docker (or set GREENMAIL_HOST).');
    }
    containerName = `email-mcp-it-${process.pid}`;
    const opts = [
      '-Dgreenmail.setup.test.all',
      '-Dgreenmail.hostname=0.0.0.0',
      '-Dgreenmail.users=alice:alicepw@example.com,bob:bobpw@example.com,carol:carolpw@example.com',
      '-Dgreenmail.users.login=email',
    ].join(' ');
    const args = ['run', '-d', '--rm', '--name', containerName, '-e', `GREENMAIL_OPTS=${opts}`];
    for (const p of Object.values(PORTS)) args.push('-p', `127.0.0.1::${p}`);
    args.push(IMAGE);
    docker(args);
    const mapped = (p: number) => Number(docker(['port', containerName!, `${p}/tcp`]).split('\n')[0].split(':').pop());
    info = {
      host: '127.0.0.1',
      smtp: mapped(PORTS.smtp),
      smtps: mapped(PORTS.smtps),
      imap: mapped(PORTS.imap),
      imaps: mapped(PORTS.imaps),
      pop3: mapped(PORTS.pop3),
      pop3s: mapped(PORTS.pop3s),
    };
  }
  const deadline = Date.now() + 90_000;
  await waitForGreeting(info.host, info.smtp, '220', deadline);
  await waitForGreeting(info.host, info.imap, '* OK', deadline);
  await waitForGreeting(info.host, info.pop3, '+OK', deadline);
  project.provide('greenmail', info);
}

export async function teardown(): Promise<void> {
  if (containerName) {
    try {
      docker(['rm', '-f', containerName]);
    } catch {
      /* ignore */
    }
  }
}
