import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../code-store.js';
import { InMemoryCodeStore } from './code-store.js';

describe('InMemoryCodeStore', () => {
  const SAMPLE = 'export default function Card(){return null;}';
  const SAMPLE_HASH = sha256Hex(SAMPLE);

  it('get returns null for an unknown hash', async () => {
    const store = new InMemoryCodeStore();
    expect(await store.get(SAMPLE_HASH)).toBeNull();
  });

  it('put + get round-trip preserves bytes exactly', async () => {
    const store = new InMemoryCodeStore();
    await store.put(SAMPLE_HASH, SAMPLE);
    expect(await store.get(SAMPLE_HASH)).toBe(SAMPLE);
  });

  it('put is idempotent — second put with same (hash, code) is a no-op', async () => {
    const store = new InMemoryCodeStore();
    await store.put(SAMPLE_HASH, SAMPLE);
    await store.put(SAMPLE_HASH, SAMPLE);
    expect(store.size).toBe(1);
    expect(await store.get(SAMPLE_HASH)).toBe(SAMPLE);
  });

  it('hashOf is deterministic and matches sha256(code)', () => {
    const store = new InMemoryCodeStore();
    expect(store.hashOf(SAMPLE)).toBe(SAMPLE_HASH);
    expect(store.hashOf(SAMPLE)).toBe(store.hashOf(SAMPLE));
  });

  it('hashOf produces 64-char lowercase hex', () => {
    const store = new InMemoryCodeStore();
    const h = store.hashOf('anything');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashOf changes when code changes', () => {
    const store = new InMemoryCodeStore();
    expect(store.hashOf('a')).not.toBe(store.hashOf('b'));
  });

  it('rejects malformed hashes on put (path-traversal defense at construction time)', async () => {
    const store = new InMemoryCodeStore();
    await expect(store.put('not-a-hash', SAMPLE)).rejects.toThrow(/hash/i);
    await expect(store.put('../etc/passwd', SAMPLE)).rejects.toThrow(/hash/i);
    await expect(store.put('SAMPLE_HASH'.toUpperCase(), SAMPLE)).rejects.toThrow(
      /hash/i,
    );
  });

  it('two distinct codes produce two distinct entries', async () => {
    const store = new InMemoryCodeStore();
    const codeA = 'const A = 1;';
    const codeB = 'const B = 2;';
    await store.put(store.hashOf(codeA), codeA);
    await store.put(store.hashOf(codeB), codeB);
    expect(store.size).toBe(2);
    expect(await store.get(store.hashOf(codeA))).toBe(codeA);
    expect(await store.get(store.hashOf(codeB))).toBe(codeB);
  });

  it('preserves UTF-8 bytes exactly across put/get', async () => {
    const store = new InMemoryCodeStore();
    const code = 'const greeting = "Привет 你好 🚀";';
    const hash = store.hashOf(code);
    await store.put(hash, code);
    expect(await store.get(hash)).toBe(code);
  });
});
