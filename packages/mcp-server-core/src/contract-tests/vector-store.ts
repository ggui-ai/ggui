/**
 * Contract test factory for {@link VectorStore} implementations.
 *
 * Pass a factory that produces a fresh store per test. The suite
 * registers a `describe` block covering the normative semantics
 * declared on the interface:
 *
 *   - Upsert by (scope, key) is idempotent.
 *   - `query` sorts by score descending.
 *   - Empty scope returns `[]`, never throws.
 *   - No cross-scope leakage.
 *   - `deleteVector` on a missing key is a no-op.
 *   - Metadata roundtrips without mutation.
 *
 * Usage (vitest):
 * ```ts
 * import { vectorStoreContract } from '@ggui-ai/mcp-server-core/contract-tests';
 * import { MyVectorStore } from './my-vector-store';
 * vectorStoreContract('MyVectorStore', () => new MyVectorStore());
 * ```
 *
 * The factory runs its own `describe`; callers don't need to wrap.
 * Adapter authors: add this one line to your test suite and you have
 * conformance coverage. Any breakage is a real regression, not a
 * contract-surprise.
 */
import { describe, expect, it } from 'vitest';
import type {
  EnumerableVectorStore,
  VectorStore,
} from '../vector-store.js';
import { isEnumerableVectorStore } from '../vector-store.js';

export function vectorStoreContract(
  label: string,
  makeStore: () => Promise<VectorStore> | VectorStore,
): void {
  describe(`VectorStore contract — ${label}`, () => {
    // A non-zero unit vector so cosine similarity is well-defined.
    const v1 = [1, 0, 0, 0];
    const v2 = [0, 1, 0, 0];
    const v3 = [1, 1, 0, 0];

    it('putVector followed by query returns the entry', async () => {
      const s = await makeStore();
      await s.putVector('app-a', { key: 'k1', vector: v1, metadata: { tag: 'x' } });
      const results = await s.query('app-a', v1, 10);
      expect(results).toHaveLength(1);
      expect(results[0]!.key).toBe('k1');
      expect(results[0]!.score).toBeGreaterThan(0.99);
      expect(results[0]!.metadata).toEqual({ tag: 'x' });
    });

    it('query returns [] for unknown scope — never throws', async () => {
      const s = await makeStore();
      await expect(s.query('missing-scope', v1, 10)).resolves.toEqual([]);
    });

    it('query results are sorted by score descending', async () => {
      const s = await makeStore();
      await s.putVector('app-a', { key: 'exact', vector: v1, metadata: {} });
      await s.putVector('app-a', { key: 'partial', vector: v3, metadata: {} });
      await s.putVector('app-a', { key: 'orthogonal', vector: v2, metadata: {} });
      const results = await s.query('app-a', v1, 10);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
      }
    });

    it('topK caps returned results', async () => {
      const s = await makeStore();
      for (let i = 0; i < 5; i++) {
        await s.putVector('app-a', {
          key: `k${i}`,
          vector: [Math.cos(i), Math.sin(i), 0, 0],
          metadata: {},
        });
      }
      const results = await s.query('app-a', v1, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('upsert is idempotent on (scope, key)', async () => {
      const s = await makeStore();
      await s.putVector('app-a', { key: 'k1', vector: v1, metadata: { n: '1' } });
      await s.putVector('app-a', { key: 'k1', vector: v1, metadata: { n: '2' } });
      const results = await s.query('app-a', v1, 10);
      expect(results.filter((r) => r.key === 'k1')).toHaveLength(1);
      expect(results[0]!.metadata).toEqual({ n: '2' });
    });

    it('scopes do not leak into each other', async () => {
      const s = await makeStore();
      await s.putVector('app-a', { key: 'shared', vector: v1, metadata: { src: 'a' } });
      await s.putVector('app-b', { key: 'shared', vector: v1, metadata: { src: 'b' } });
      const a = await s.query('app-a', v1, 10);
      const b = await s.query('app-b', v1, 10);
      expect(a).toHaveLength(1);
      expect(a[0]!.metadata.src).toBe('a');
      expect(b).toHaveLength(1);
      expect(b[0]!.metadata.src).toBe('b');
    });

    it('deleteVector removes only the specified (scope, key)', async () => {
      const s = await makeStore();
      await s.putVector('app-a', { key: 'k1', vector: v1, metadata: {} });
      await s.putVector('app-a', { key: 'k2', vector: v2, metadata: {} });
      await s.deleteVector('app-a', 'k1');
      const results = await s.query('app-a', v1, 10);
      expect(results.map((r) => r.key)).toEqual(['k2']);
    });

    it('deleteVector on a missing key is a no-op', async () => {
      const s = await makeStore();
      await expect(s.deleteVector('app-a', 'never-stored')).resolves.toBeUndefined();
    });

    it('metadata supports all four scalar types', async () => {
      const s = await makeStore();
      const metadata = {
        str: 'hello',
        num: 42,
        bool: true,
        nul: null,
      };
      await s.putVector('app-a', { key: 'k1', vector: v1, metadata });
      const [hit] = await s.query('app-a', v1, 10);
      expect(hit!.metadata).toEqual(metadata);
    });
  });
}

/**
 * Contract test factory for {@link EnumerableVectorStore} implementations.
 *
 * Invoke alongside `vectorStoreContract` when the concrete claims the
 * `listByScope` capability. The suite covers the normative semantics
 * declared on the interface:
 *
 *   - `listByScope` on an unknown scope returns `[]`, never throws.
 *   - Results cover every upserted entry in the scope (no silent drops).
 *   - Cross-scope leakage is forbidden.
 *   - Vector + metadata roundtrip without mutation (parity with `query`).
 *   - `isEnumerableVectorStore` type-guard returns `true` for the concrete.
 *   - Post-delete listings honor the deletion.
 */
export function enumerableVectorStoreContract(
  label: string,
  makeStore: () => Promise<EnumerableVectorStore> | EnumerableVectorStore,
): void {
  describe(`EnumerableVectorStore contract — ${label}`, () => {
    const v1 = [1, 0, 0, 0];
    const v2 = [0, 1, 0, 0];

    it('isEnumerableVectorStore returns true for the concrete', async () => {
      const s = await makeStore();
      expect(isEnumerableVectorStore(s)).toBe(true);
    });

    it('listByScope on an unknown scope returns [] — never throws', async () => {
      const s = await makeStore();
      await expect(s.listByScope('missing')).resolves.toEqual([]);
    });

    it('listByScope returns every upserted entry in the scope', async () => {
      const s = await makeStore();
      await s.putVector('app-a', { key: 'k1', vector: v1, metadata: { n: 1 } });
      await s.putVector('app-a', { key: 'k2', vector: v2, metadata: { n: 2 } });
      const entries = await s.listByScope('app-a');
      const keys = entries.map((e) => e.key).sort();
      expect(keys).toEqual(['k1', 'k2']);
    });

    it('listByScope does not leak entries from other scopes', async () => {
      const s = await makeStore();
      await s.putVector('app-a', { key: 'shared', vector: v1, metadata: { src: 'a' } });
      await s.putVector('app-b', { key: 'shared', vector: v1, metadata: { src: 'b' } });
      const a = await s.listByScope('app-a');
      const b = await s.listByScope('app-b');
      expect(a).toHaveLength(1);
      expect(a[0]!.metadata.src).toBe('a');
      expect(b).toHaveLength(1);
      expect(b[0]!.metadata.src).toBe('b');
    });

    it('listByScope roundtrips vector + metadata faithfully', async () => {
      const s = await makeStore();
      const vector = [0.1, 0.2, 0.3, 0.4];
      const metadata = { str: 'ok', num: 7, bool: false, nul: null };
      await s.putVector('app-a', { key: 'k1', vector, metadata });
      const [entry] = await s.listByScope('app-a');
      expect(entry!.key).toBe('k1');
      expect(entry!.vector).toEqual(vector);
      expect(entry!.metadata).toEqual(metadata);
    });

    it('listByScope reflects deletes', async () => {
      const s = await makeStore();
      await s.putVector('app-a', { key: 'k1', vector: v1, metadata: {} });
      await s.putVector('app-a', { key: 'k2', vector: v2, metadata: {} });
      await s.deleteVector('app-a', 'k1');
      const entries = await s.listByScope('app-a');
      expect(entries.map((e) => e.key)).toEqual(['k2']);
    });

    it('listByScope reflects upsert overwrites (one entry per key)', async () => {
      const s = await makeStore();
      await s.putVector('app-a', { key: 'k1', vector: v1, metadata: { rev: 1 } });
      await s.putVector('app-a', { key: 'k1', vector: v1, metadata: { rev: 2 } });
      const entries = await s.listByScope('app-a');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.metadata).toEqual({ rev: 2 });
    });
  });
}
