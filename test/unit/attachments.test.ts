import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { pickSentFolder } from '../../src/imap.js';
import { loadAttachments } from '../../src/smtp.js';

describe('loadAttachments path policy', () => {
  let base: string;
  let root: string;
  const opts = () => ({ roots: [root], maxBytes: 1000 });

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'email-mcp-unit-'));
    root = path.join(base, 'root');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, 'a.txt'), 'A');
    await writeFile(path.join(root, 'sub', 'b.txt'), 'BB');
    await writeFile(path.join(base, 'outside.txt'), 'X');
    await writeFile(path.join(root, 'big.bin'), Buffer.alloc(900));
    await writeFile(path.join(root, 'big2.bin'), Buffer.alloc(900));
    await writeFile(path.join(root, 'huge.bin'), Buffer.alloc(1001));
    await symlink(path.join(base, 'outside.txt'), path.join(root, 'escape.txt'));
    await symlink(path.join(root, 'sub', 'b.txt'), path.join(root, 'inner-link.txt'));
    await symlink(base, path.join(root, 'dirlink'));
  });

  it('reads allowed files (including symlinks that stay inside the root)', async () => {
    const r = await loadAttachments([path.join(root, 'a.txt'), path.join(root, 'sub/b.txt'), path.join(root, 'inner-link.txt')], opts());
    expect(r.map((a) => [a.filename, a.content.toString()])).toEqual([
      ['a.txt', 'A'],
      ['b.txt', 'BB'],
      ['b.txt', 'BB'],
    ]);
  });

  it.each([
    ['../ traversal', () => path.join(root, '..', 'outside.txt')],
    ['../ traversal hidden in a subpath', () => path.join(root, 'sub', '..', '..', 'outside.txt')],
    ['symlink escape', () => path.join(root, 'escape.txt')],
    ['symlinked directory escape', () => path.join(root, 'dirlink', 'outside.txt')],
    ['absolute system path', () => '/etc/passwd'],
    ['sibling with the root as a name prefix', () => `${root}-evil/x.txt`],
  ])('rejects %s', async (_name, p) => {
    const target = p();
    if (target.includes('-evil')) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'e');
    }
    await expect(loadAttachments([target], opts())).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/outside the allowed/) });
  });

  it('rejects missing files and directories', async () => {
    await expect(loadAttachments([path.join(root, 'nope.txt')], opts())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(loadAttachments([path.join(root, 'sub')], opts())).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/not a regular file/) });
  });

  it('enforces per-file and total size limits', async () => {
    await expect(loadAttachments([path.join(root, 'huge.bin')], opts())).rejects.toMatchObject({ message: expect.stringMatching(/above the 1000 byte limit/) });
    await expect(loadAttachments([path.join(root, 'big.bin'), path.join(root, 'big2.bin')], opts())).rejects.toMatchObject({
      message: expect.stringMatching(/total more than/),
    });
  });

  it('a nonexistent root allows nothing', async () => {
    await expect(loadAttachments([path.join(root, 'a.txt')], { roots: ['/does/not/exist'], maxBytes: 1000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('pickSentFolder', () => {
  it('prefers SPECIAL-USE \\Sent, then common names', () => {
    expect(pickSentFolder([{ path: 'INBOX', name: 'INBOX' }, { path: 'Sent', name: 'Sent' }, { path: 'Gesendet', name: 'Gesendet', specialUse: '\\Sent' }])).toBe('Gesendet');
    expect(pickSentFolder([{ path: 'INBOX', name: 'INBOX' }, { path: 'INBOX.Sent Messages', name: 'Sent Messages' }])).toBe('INBOX.Sent Messages');
    expect(pickSentFolder([{ path: '已发送', name: '已发送' }])).toBe('已发送');
    expect(pickSentFolder([{ path: 'sent', name: 'sent' }])).toBe('sent');
    expect(pickSentFolder([{ path: 'INBOX', name: 'INBOX' }])).toBeUndefined();
  });
});
