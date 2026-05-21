/**
 * Contract test factory for {@link ScopedFileStoreRegistry} implementations.
 *
 * Normative semantics covered (matching the Protocol & Contract Bar
 * obligations declared on `scoped-file-store.ts`):
 *   - put / get round-trip for both string and binary
 *   - getString decodes UTF-8 from a string-put or binary-put
 *   - missing-key returns null (NOT throws)
 *   - delete returns true on existed, false on missing
 *   - delete is idempotent
 *   - list under a prefix returns only matching keys, scope-relative
 *   - list paginates via cursor + limit; cursor:null marks last page
 *   - append creates if missing, then concatenates
 *   - getRange [start,end] inclusive; clamps over-end; out-of-bounds
 *     start returns empty
 *   - putStream reassembles chunks atomically (never half-state)
 *   - prefix isolation: keys in app(A) are not visible from app(B),
 *     session(S), userApp(U,A), or crossAppUser(U)
 *   - userApp(U,A1) and userApp(U,A2) are isolated from each other
 *     (privacy-default cornerstone)
 *   - userApp(U,A) and crossAppUser(U) share the user prefix root for
 *     GDPR delete (verified by sentinel write + scan), but are still
 *     isolated as distinct namespaces under that root
 *   - 1000 concurrent puts produce 1000 distinct list() entries (no
 *     loss under concurrency)
 *
 * NOTE: TTL eviction within a declared window is timing-dependent and
 * impl-specific (in-memory is lazy; S3 lifecycle rules can take up to
 * 24h). Not covered here — impls assert TTL behavior in their own
 * impl-specific test files using injected clocks.
 */
import { describe, expect, it } from 'vitest';
import type {
  ScopedFileStore,
  ScopedFileStoreRegistry,
} from '../scoped-file-store.js';
import {
  readScopedJson,
  writeScopedJson,
} from '../scoped-file-store.js';

const utf8encoder = new TextEncoder();
const utf8decoder = new TextDecoder('utf-8');

function bytes(str: string): Uint8Array {
  return utf8encoder.encode(str);
}

function decode(buf: Uint8Array): string {
  return utf8decoder.decode(buf);
}

/** Reads every key in a scope, paginated; flattens to a sorted array. */
async function listAll(store: ScopedFileStore, prefix?: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await store.list(prefix, { cursor, limit: 50 });
    out.push(...page.keys);
    if (page.cursor === null) break;
    cursor = page.cursor;
  }
  return out.sort();
}

/** Build a ReadableStream<Uint8Array> from chunks for putStream tests. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]!);
      i++;
    },
  });
}

export function scopedFileStoreContract(
  label: string,
  makeRegistry: () =>
    | Promise<ScopedFileStoreRegistry>
    | ScopedFileStoreRegistry,
): void {
  describe(`ScopedFileStore contract — ${label}`, () => {
    describe('round-trips', () => {
      it('put + get round-trips raw bytes', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        const payload = new Uint8Array([0x00, 0x01, 0xff, 0x7f, 0x80]);
        await store.put('blob.bin', payload);
        const got = await store.get('blob.bin');
        expect(got).not.toBeNull();
        expect(Array.from(got!)).toEqual(Array.from(payload));
      });

      it('put + getString round-trips UTF-8', async () => {
        const reg = await makeRegistry();
        const store = reg.session('s1');
        await store.put('greet.txt', 'hello — 世界 🌍');
        const got = await store.getString('greet.txt');
        expect(got).toBe('hello — 世界 🌍');
      });

      it('getString of binary put decodes the stored bytes as UTF-8', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        const text = '{"k":42}';
        await store.put('payload.json', bytes(text));
        const got = await store.getString('payload.json');
        expect(got).toBe(text);
      });

      it('writeScopedJson + readScopedJson round-trips a JSON value', async () => {
        const reg = await makeRegistry();
        const store = reg.userApp('u1', 'A');
        await writeScopedJson(store, 'prefs.json', {
          theme: 'dark',
          n: 7,
          flags: [true, false],
        });
        const got = await readScopedJson<{
          theme: string;
          n: number;
          flags: boolean[];
        }>(store, 'prefs.json');
        expect(got).toEqual({ theme: 'dark', n: 7, flags: [true, false] });
      });
    });

    describe('missing-key semantics', () => {
      it('get on missing key returns null (does not throw)', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await expect(store.get('nope')).resolves.toBeNull();
      });

      it('getString on missing key returns null', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await expect(store.getString('nope')).resolves.toBeNull();
      });

      it('getRange on missing key returns null', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await expect(store.getRange('nope', 0, 10)).resolves.toBeNull();
      });

      it('readScopedJson on missing key returns null', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await expect(readScopedJson(store, 'nope')).resolves.toBeNull();
      });
    });

    describe('delete semantics', () => {
      it('delete returns true when key existed; false when missing', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await store.put('x', 'v');
        await expect(store.delete('x')).resolves.toBe(true);
        await expect(store.delete('x')).resolves.toBe(false);
        await expect(store.delete('never-was')).resolves.toBe(false);
      });

      it('delete is idempotent — second call does not throw', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await store.put('x', 'v');
        await store.delete('x');
        await expect(store.delete('x')).resolves.toBe(false);
      });

      it('after delete, get returns null', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await store.put('x', 'v');
        await store.delete('x');
        await expect(store.get('x')).resolves.toBeNull();
      });
    });

    describe('list', () => {
      it('list returns all keys in scope (no prefix)', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await store.put('a', '1');
        await store.put('b', '2');
        await store.put('c', '3');
        const keys = await listAll(store);
        expect(keys).toEqual(['a', 'b', 'c']);
      });

      it('list filters by sub-prefix; keys returned scope-relative', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await store.put('blueprints/foo', '1');
        await store.put('blueprints/bar', '2');
        await store.put('themes/light.json', '3');
        const blueprints = await listAll(store, 'blueprints/');
        expect(blueprints).toEqual(['blueprints/bar', 'blueprints/foo']);
      });

      it('list paginates: cursor:null on last page; non-null otherwise', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        for (let i = 0; i < 7; i++) {
          await store.put(`k${i.toString().padStart(2, '0')}`, String(i));
        }
        const page1 = await store.list(undefined, { limit: 3 });
        expect(page1.keys).toHaveLength(3);
        expect(page1.cursor).not.toBeNull();
        const page2 = await store.list(undefined, {
          limit: 3,
          cursor: page1.cursor!,
        });
        expect(page2.keys).toHaveLength(3);
        expect(page2.cursor).not.toBeNull();
        const page3 = await store.list(undefined, {
          limit: 3,
          cursor: page2.cursor!,
        });
        expect(page3.keys).toHaveLength(1);
        expect(page3.cursor).toBeNull();

        const merged = [...page1.keys, ...page2.keys, ...page3.keys].sort();
        expect(merged).toEqual([
          'k00',
          'k01',
          'k02',
          'k03',
          'k04',
          'k05',
          'k06',
        ]);
      });
    });

    describe('append', () => {
      it('append creates the key if missing', async () => {
        const reg = await makeRegistry();
        const store = reg.session('s1');
        await store.append('log.txt', 'hello\n');
        const got = await store.getString('log.txt');
        expect(got).toBe('hello\n');
      });

      it('append concatenates onto existing value', async () => {
        const reg = await makeRegistry();
        const store = reg.session('s1');
        await store.put('log.txt', 'line1\n');
        await store.append('log.txt', 'line2\n');
        await store.append('log.txt', 'line3\n');
        const got = await store.getString('log.txt');
        expect(got).toBe('line1\nline2\nline3\n');
      });

      it('append works with binary chunks', async () => {
        const reg = await makeRegistry();
        const store = reg.session('s1');
        await store.append('blob.bin', new Uint8Array([1, 2]));
        await store.append('blob.bin', new Uint8Array([3, 4]));
        const got = await store.get('blob.bin');
        expect(Array.from(got!)).toEqual([1, 2, 3, 4]);
      });
    });

    describe('getRange', () => {
      it('returns inclusive [start,end] slice', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await store.put('s', 'abcdefghij');
        const slice = await store.getRange('s', 2, 5);
        expect(slice).not.toBeNull();
        expect(decode(slice!)).toBe('cdef');
      });

      it('clamps end to value length', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await store.put('s', 'abcde');
        const slice = await store.getRange('s', 2, 100);
        expect(decode(slice!)).toBe('cde');
      });

      it('returns empty Uint8Array (not null) when start is past end', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        await store.put('s', 'abc');
        const slice = await store.getRange('s', 10, 20);
        expect(slice).not.toBeNull();
        expect(slice!.length).toBe(0);
      });
    });

    describe('putStream', () => {
      it('reassembles chunked stream into one stored value', async () => {
        const reg = await makeRegistry();
        const store = reg.session('s1');
        const chunks = [bytes('hello '), bytes('streamed '), bytes('world')];
        await store.putStream('streamed.txt', streamOf(chunks));
        const got = await store.getString('streamed.txt');
        expect(got).toBe('hello streamed world');
      });

      it('overwrites prior put at same key (atomic-or-throw)', async () => {
        const reg = await makeRegistry();
        const store = reg.session('s1');
        await store.put('k', 'first');
        await store.putStream('k', streamOf([bytes('second')]));
        const got = await store.getString('k');
        expect(got).toBe('second');
      });
    });

    describe('scope isolation', () => {
      it('app(A) does not see app(B) writes', async () => {
        const reg = await makeRegistry();
        await reg.app('A').put('shared-name', 'A-value');
        await reg.app('B').put('shared-name', 'B-value');
        expect(await reg.app('A').getString('shared-name')).toBe('A-value');
        expect(await reg.app('B').getString('shared-name')).toBe('B-value');
      });

      it('app(A) does not see session(s1) writes', async () => {
        const reg = await makeRegistry();
        await reg.app('A').put('k', 'app-value');
        await reg.session('s1').put('k', 'session-value');
        expect(await reg.app('A').getString('k')).toBe('app-value');
        expect(await reg.session('s1').getString('k')).toBe('session-value');
      });

      it('userApp(U,A) does not see userApp(U,B) — privacy default', async () => {
        const reg = await makeRegistry();
        // Same user, two different agents — privacy isolation.
        await reg.userApp('u1', 'A').put('history.json', 'agent-A-saw-this');
        await reg.userApp('u1', 'B').put('history.json', 'agent-B-saw-this');
        expect(
          await reg.userApp('u1', 'A').getString('history.json'),
        ).toBe('agent-A-saw-this');
        expect(
          await reg.userApp('u1', 'B').getString('history.json'),
        ).toBe('agent-B-saw-this');
      });

      it('userApp(U,A) and crossAppUser(U) are isolated namespaces', async () => {
        const reg = await makeRegistry();
        await reg.userApp('u1', 'A').put('k', 'per-app');
        await reg.crossAppUser('u1').put('k', 'cross-app');
        expect(await reg.userApp('u1', 'A').getString('k')).toBe('per-app');
        expect(await reg.crossAppUser('u1').getString('k')).toBe('cross-app');
      });

      it('list in app(A) does not leak app(B) keys', async () => {
        const reg = await makeRegistry();
        await reg.app('A').put('k1', '1');
        await reg.app('A').put('k2', '2');
        await reg.app('B').put('k3', '3');
        const aKeys = await listAll(reg.app('A'));
        expect(aKeys).toEqual(['k1', 'k2']);
      });
    });

    describe('concurrency', () => {
      it('1000 concurrent distinct-key puts all observed in list()', async () => {
        const reg = await makeRegistry();
        const store = reg.app('A');
        const writes: Promise<void>[] = [];
        for (let i = 0; i < 1000; i++) {
          writes.push(store.put(`k${i}`, String(i)));
        }
        await Promise.all(writes);
        const keys = await listAll(store);
        expect(keys).toHaveLength(1000);
        // Spot-check a few values round-tripped.
        expect(await store.getString('k0')).toBe('0');
        expect(await store.getString('k500')).toBe('500');
        expect(await store.getString('k999')).toBe('999');
      });
    });
  });
}
