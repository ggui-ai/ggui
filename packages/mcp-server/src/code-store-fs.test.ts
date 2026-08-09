import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@ggui-ai/mcp-server-core';
import { FileSystemCodeStore } from './code-store-fs.js';

describe('FileSystemCodeStore', () => {
  let root: string;
  const SAMPLE = 'export default function Card(){return null;}';
  const SAMPLE_HASH = sha256Hex(SAMPLE);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ggui-code-cache-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('get returns null for unknown hash', async () => {
    const store = new FileSystemCodeStore({ root });
    expect(await store.get(SAMPLE_HASH)).toBeNull();
  });

  it('put + get round-trip preserves bytes exactly', async () => {
    const store = new FileSystemCodeStore({ root });
    await store.put(SAMPLE_HASH, SAMPLE);
    expect(await store.get(SAMPLE_HASH)).toBe(SAMPLE);
  });

  it('put is idempotent — second put of same (hash, code) is a no-op', async () => {
    const store = new FileSystemCodeStore({ root });
    await store.put(SAMPLE_HASH, SAMPLE);
    await store.put(SAMPLE_HASH, SAMPLE);
    expect(await store.get(SAMPLE_HASH)).toBe(SAMPLE);
  });

  it('survives a fresh store instance — persistence across "restart"', async () => {
    const writer = new FileSystemCodeStore({ root });
    await writer.put(SAMPLE_HASH, SAMPLE);
    // Simulate process restart by constructing a new instance
    // pointing at the same root.
    const reader = new FileSystemCodeStore({ root });
    expect(await reader.get(SAMPLE_HASH)).toBe(SAMPLE);
  });

  it('preserves UTF-8 across put/get', async () => {
    const store = new FileSystemCodeStore({ root });
    const code = 'const greeting = "Привет 你好 🚀";';
    const hash = sha256Hex(code);
    await store.put(hash, code);
    expect(await store.get(hash)).toBe(code);
  });

  it('hashOf is deterministic and matches sha256(code)', () => {
    const store = new FileSystemCodeStore({ root });
    expect(store.hashOf(SAMPLE)).toBe(SAMPLE_HASH);
    expect(store.hashOf(SAMPLE)).toBe(store.hashOf(SAMPLE));
  });

  it('rejects malformed hashes on put (path-traversal defense)', async () => {
    const store = new FileSystemCodeStore({ root });
    await expect(store.put('not-a-hash', SAMPLE)).rejects.toThrow(/hash/i);
    await expect(store.put('../etc/passwd', SAMPLE)).rejects.toThrow(/hash/i);
    await expect(store.put('/abs/path/escape', SAMPLE)).rejects.toThrow(/hash/i);
    // Uppercase hex is not allowed — strict lowercase contract.
    await expect(store.put(SAMPLE_HASH.toUpperCase(), SAMPLE)).rejects.toThrow(
      /hash/i,
    );
  });

  it('returns null on get for malformed hash (no error, no fs touch)', async () => {
    const store = new FileSystemCodeStore({ root });
    expect(await store.get('../etc/passwd')).toBeNull();
    expect(await store.get('not-a-hash')).toBeNull();
  });

  it('two distinct codes produce two distinct files', async () => {
    const store = new FileSystemCodeStore({ root });
    const codeA = 'const A = 1;';
    const codeB = 'const B = 2;';
    await store.put(sha256Hex(codeA), codeA);
    await store.put(sha256Hex(codeB), codeB);
    expect(await store.get(sha256Hex(codeA))).toBe(codeA);
    expect(await store.get(sha256Hex(codeB))).toBe(codeB);
  });

  describe('delete', () => {
    it('removes the bundle — get returns null afterwards', async () => {
      const store = new FileSystemCodeStore({ root });
      await store.put(SAMPLE_HASH, SAMPLE);
      await store.delete(SAMPLE_HASH);
      expect(await store.get(SAMPLE_HASH)).toBeNull();
    });

    it('removes the on-disk file, not just the read path', async () => {
      const store = new FileSystemCodeStore({ root });
      await store.put(SAMPLE_HASH, SAMPLE);
      await store.delete(SAMPLE_HASH);
      const fs = await import('node:fs/promises');
      const absPath = join(
        root,
        SAMPLE_HASH.slice(0, 2),
        `${SAMPLE_HASH.slice(2)}.js`,
      );
      await expect(fs.stat(absPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('is idempotent — a second delete of the same hash resolves', async () => {
      const store = new FileSystemCodeStore({ root });
      await store.put(SAMPLE_HASH, SAMPLE);
      await store.delete(SAMPLE_HASH);
      await expect(store.delete(SAMPLE_HASH)).resolves.toBeUndefined();
    });

    it('resolves for a hash that was never put', async () => {
      const store = new FileSystemCodeStore({ root });
      await expect(store.delete(SAMPLE_HASH)).resolves.toBeUndefined();
    });

    it('leaves other bundles intact', async () => {
      const store = new FileSystemCodeStore({ root });
      const other = 'const B = 2;';
      const otherHash = sha256Hex(other);
      await store.put(SAMPLE_HASH, SAMPLE);
      await store.put(otherHash, other);
      await store.delete(SAMPLE_HASH);
      expect(await store.get(otherHash)).toBe(other);
    });

    it('re-put after delete restores the bundle', async () => {
      const store = new FileSystemCodeStore({ root });
      await store.put(SAMPLE_HASH, SAMPLE);
      await store.delete(SAMPLE_HASH);
      await store.put(SAMPLE_HASH, SAMPLE);
      expect(await store.get(SAMPLE_HASH)).toBe(SAMPLE);
    });

    it('never unlinks a path derived from a malformed hash (traversal defense)', async () => {
      const fs = await import('node:fs/promises');
      // Cache root one level down, with a file the sharded layout can
      // never own sitting outside it. `'../bystander'` is exactly the
      // hash an unvalidated `absPath` would resolve onto that file.
      const cacheRoot = join(root, 'cache');
      await fs.mkdir(cacheRoot, { recursive: true });
      const bystander = join(root, 'bystander.js');
      await fs.writeFile(bystander, 'keep me', { encoding: 'utf-8' });

      const store = new FileSystemCodeStore({ root: cacheRoot });
      await expect(store.delete('../bystander')).resolves.toBeUndefined();
      await expect(store.delete('not-a-hash')).resolves.toBeUndefined();
      await expect(
        store.delete(SAMPLE_HASH.toUpperCase()),
      ).resolves.toBeUndefined();
      expect(await fs.readFile(bystander, { encoding: 'utf-8' })).toBe(
        'keep me',
      );
    });
  });

  it('writes via temp-file + rename (no partial reads)', async () => {
    // We can't easily race here without instrumenting fs, but we can
    // assert the final committed file path matches the expected
    // sharded layout (proves the rename target).
    const store = new FileSystemCodeStore({ root });
    await store.put(SAMPLE_HASH, SAMPLE);
    const fs = await import('node:fs/promises');
    const expected = join(
      root,
      SAMPLE_HASH.slice(0, 2),
      `${SAMPLE_HASH.slice(2)}.js`,
    );
    const stat = await fs.stat(expected);
    expect(stat.isFile()).toBe(true);
  });
});
