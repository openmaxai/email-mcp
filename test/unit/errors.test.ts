import { describe, expect, it } from 'vitest';
import { EmailError, TimeoutError, classifyError, redact, registerSecret, withTimeout } from '../../src/errors.js';

const err = (props: Record<string, unknown>, message = 'boom') => Object.assign(new Error(message), props);

describe('classifyError', () => {
  it.each([
    [err({ authenticationFailed: true }), 'imap', 'AUTH_FAILED'],
    [err({ code: 'EAUTH', responseCode: 535 }), 'smtp', 'AUTH_FAILED'],
    [err({ eventName: 'error', command: 'PASS ***' }), 'pop3', 'AUTH_FAILED'],
    [err({ code: 'ENOTFOUND' }), 'imap', 'UNREACHABLE'],
    [err({ code: 'ECONNREFUSED' }), 'pop3', 'UNREACHABLE'],
    [err({ code: 'ESOCKET' }), 'smtp', 'UNREACHABLE'],
    [err({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'self-signed certificate'), 'imap', 'UNREACHABLE'],
    [err({ eventName: 'close' }), 'pop3', 'UNREACHABLE'],
    [err({ code: 'ETIMEDOUT' }), 'smtp', 'TIMEOUT'],
    [err({ code: 'CONNECT_TIMEOUT' }), 'imap', 'TIMEOUT'],
    [err({ eventName: 'timeout' }), 'pop3', 'TIMEOUT'],
    [new TimeoutError('x', 10), 'imap', 'TIMEOUT'],
    [err({ code: 'EENVELOPE', responseCode: 550 }), 'smtp', 'SEND_REJECTED'],
    [err({ code: 'EMESSAGE', responseCode: 552 }), 'smtp', 'SEND_REJECTED'],
    [err({}), 'imap', 'UNKNOWN'],
  ] as const)('%# → %s', (e, stage, code) => {
    expect(classifyError(e, stage).code).toBe(code);
  });

  it('passes EmailError through', () => {
    expect(classifyError(new EmailError('NOT_FOUND', 'x')).code).toBe('NOT_FOUND');
  });

  it('redacts registered secrets from messages', () => {
    registerSecret('s3cr3t-value');
    expect(redact('login s3cr3t-value failed')).toBe('login *** failed');
    expect(classifyError(new Error('PASS s3cr3t-value rejected'), 'pop3').message).not.toContain('s3cr3t-value');
    expect(classifyError(new EmailError('INVALID_INPUT', 'bad s3cr3t-value')).message).not.toContain('s3cr3t-value');
  });
});

describe('withTimeout', () => {
  it('resolves when fast', async () => {
    await expect(withTimeout(Promise.resolve(1), 100, 'x')).resolves.toBe(1);
  });
  it('rejects with TimeoutError and calls the teardown', async () => {
    let torn = false;
    const never = new Promise(() => {});
    await expect(withTimeout(never, 20, 'op', () => (torn = true))).rejects.toBeInstanceOf(TimeoutError);
    expect(torn).toBe(true);
  });
  it('does not leak unhandled rejections after timing out', async () => {
    const late = new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 40));
    await expect(withTimeout(late, 10, 'op')).rejects.toBeInstanceOf(TimeoutError);
    await new Promise((r) => setTimeout(r, 60));
  });
});
