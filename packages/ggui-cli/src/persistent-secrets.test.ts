import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrMintHexSecret } from './persistent-secrets.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'ggui-persistent-secrets-'));
}

describe('readOrMintHexSecret', () => {
  it('mints a fresh 64-char hex secret when the file is absent', () => {
    const dir = freshDir();
    const filename = join(dir, 'bootstrap.hex');
    const secret = readOrMintHexSecret(filename);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // Same length on disk (no trailing newline; pure hex)
    const onDisk = readFileSync(filename, 'utf8');
    expect(onDisk).toBe(secret);
  });

  it('returns the same secret across two calls (read-after-write)', () => {
    const dir = freshDir();
    const filename = join(dir, 'bootstrap.hex');
    const a = readOrMintHexSecret(filename);
    const b = readOrMintHexSecret(filename);
    expect(a).toBe(b);
  });

  it('writes the file with mode 0600', () => {
    const dir = freshDir();
    const filename = join(dir, 'bootstrap.hex');
    readOrMintHexSecret(filename);
    // Mask to permission bits only — bits above 0o777 carry file-type
    // info that varies by FS.
    const mode = statSync(filename).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates missing parent directories', () => {
    const dir = freshDir();
    const filename = join(dir, 'nested', 'deeper', 'bootstrap.hex');
    const secret = readOrMintHexSecret(filename);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(filename, 'utf8')).toBe(secret);
  });

  it('throws on corrupt content (length mismatch) instead of silently re-minting', () => {
    const dir = freshDir();
    const filename = join(dir, 'bootstrap.hex');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filename, 'not-a-valid-hex-secret', 'utf8');
    expect(() => readOrMintHexSecret(filename)).toThrow(/corrupt/);
  });

  it('throws on corrupt content (non-hex chars) instead of silently re-minting', () => {
    const dir = freshDir();
    const filename = join(dir, 'bootstrap.hex');
    writeFileSync(filename, 'Z'.repeat(64), 'utf8');
    expect(() => readOrMintHexSecret(filename)).toThrow(/corrupt/);
  });

  it('mints distinct secrets across separate files (no global state leak)', () => {
    const dir = freshDir();
    const a = readOrMintHexSecret(join(dir, 'a.hex'));
    const b = readOrMintHexSecret(join(dir, 'b.hex'));
    expect(a).not.toBe(b);
  });

  it('leaves no temp files behind after a successful mint', () => {
    // The atomic write path stages to `<filename>.tmp-<pid>` then
    // renames into place. A successful mint must leave ONLY the
    // canonical filename in the dir — any leftover .tmp-* file is a
    // bug in the rename step.
    const dir = freshDir();
    const filename = join(dir, 'bootstrap.hex');
    readOrMintHexSecret(filename);
    const entries = readdirSync(dir);
    expect(entries).toEqual(['bootstrap.hex']);
  });
});
