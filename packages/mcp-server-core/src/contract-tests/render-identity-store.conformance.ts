/**
 * `RenderIdentityStore` cross-impl conformance suite (#457 — the port's
 * first; it had none, and a durability declaration with no harness to
 * grade it would be a promise nobody checks).
 *
 * Portable battery every {@link RenderIdentityStore} implementation
 * MUST satisfy. Mirrors the `code-store.conformance` pattern: a
 * factory supplies a fresh store + optional teardown; concrete impls
 * plug in their own runner test.
 *
 * Covered surface — exactly the port's stated obligations:
 *
 *   - put / get round-trip preserves every field verbatim, including a
 *     `blueprintId` of `null` (a terminal state since #460 — distinct
 *     from a miss).
 *   - a `blueprintIdentity` marker is persisted when given and reads
 *     back undefined when not (ggui#1405).
 *   - `requestedVariantKey` is persisted when given and reads back
 *     undefined when not (ggui#1568): absent means unknown.
 *   - put is a whole-record upsert — later writes win, no field merge.
 *   - put rejects an empty `sessionId` (the promise rejects; an
 *     unkeyed record can never be read back).
 *   - get on a session that was never written returns `null`, never
 *     throws.
 *   - get returns a defensive copy — mutating it does not corrupt
 *     stored state.
 *   - `durability` is declared and literal (`'durable'` or
 *     `'ephemeral'`), and matches what the factory promises: the
 *     substrate gate takes the declaration at its word, so a store
 *     declaring one thing while the deployment knows another is the
 *     exact dishonesty #457 exists to close.
 */

import { describe, expect, it } from 'vitest';
import type {
  RenderIdentityRecord,
  RenderIdentityStore,
} from '../render-identity-store.js';

/** Factory + optional cleanup + the declared-durability expectation. */
export interface RenderIdentityStoreConformanceFactory {
  readonly create: () => Promise<RenderIdentityStore>;
  readonly cleanup?: (store: RenderIdentityStore) => Promise<void> | void;
  /**
   * What the harness KNOWS this store to be. The suite grades the
   * store's own declaration against it — a mismatch is a conformance
   * failure, not a skip.
   */
  readonly expectedDurability: 'durable' | 'ephemeral';
}

function record(overrides: Partial<RenderIdentityRecord> = {}): RenderIdentityRecord {
  return {
    sessionId: 'render-1',
    appId: 'app-1',
    userId: 'user-1',
    blueprintId: 'bp_00000000-0000-4000-8000-000000000001',
    contractKey: '0123456789abcdef',
    variantKey: 'fedcba9876543210',
    requestedVariantKey: '44136fa355b3678a',
    props: { title: 'Hello' },
    seqAtLastCommit: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    ...overrides,
  };
}

/**
 * Run the conformance suite under a descriptive label.
 * Call inside a `describe(...)` block in the concrete impl's runner.
 */
export function runRenderIdentityStoreConformance(
  label: string,
  factory: RenderIdentityStoreConformanceFactory,
): void {
  async function withStore<T>(
    fn: (store: RenderIdentityStore) => Promise<T>,
  ): Promise<T> {
    const store = await factory.create();
    try {
      return await fn(store);
    } finally {
      if (factory.cleanup) await factory.cleanup(store);
    }
  }

  describe(`${label} — conformance`, () => {
    it('round-trips every field verbatim', async () => {
      await withStore(async (store) => {
        const r = record();
        await store.put(r);
        expect(await store.get(r.sessionId)).toEqual(r);
      });
    });

    it("preserves the blueprint-identity marker when given, and leaves it absent when not (ggui#1405)", async () => {
      await withStore(async (store) => {
        await store.put(record({ sessionId: 'render-eph', blueprintIdentity: 'ephemeral' }));
        await store.put(record({ sessionId: 'render-reg' }));
        expect((await store.get('render-eph'))?.blueprintIdentity).toBe('ephemeral');
        // Absent reads back undefined — the suite's convention for optionals
        // (a codec returning `key: undefined` serves every reader the same).
        expect((await store.get('render-reg'))?.blueprintIdentity).toBeUndefined();
      });
    });

    it('preserves requestedVariantKey when given, and leaves it absent when not (ggui#1568)', async () => {
      await withStore(async (store) => {
        await store.put(record({ sessionId: 'render-req', requestedVariantKey: 'aaaabbbbccccdddd' }));
        const { requestedVariantKey: _absent, ...without } = record({ sessionId: 'render-old' });
        await store.put(without);
        expect((await store.get('render-req'))?.requestedVariantKey).toBe('aaaabbbbccccdddd');
        // A record written before the member existed reads back without it:
        // absent means unknown, and a store must not fill it in.
        expect((await store.get('render-old'))?.requestedVariantKey).toBeUndefined();
      });
    });

    it('preserves a null blueprintId — terminal state, not a miss', async () => {
      await withStore(async (store) => {
        await store.put(record({ blueprintId: null }));
        const got = await store.get('render-1');
        expect(got).not.toBeNull();
        expect(got!.blueprintId).toBeNull();
      });
    });

    it('put is a whole-record upsert — later writes win, no field merge', async () => {
      await withStore(async (store) => {
        await store.put(record({ props: { title: 'First' }, userId: 'user-1' }));
        const replacement = record({ props: { title: 'Second' } });
        const { userId: _dropped, ...withoutUser } = replacement;
        await store.put(withoutUser as RenderIdentityRecord);
        const got = await store.get('render-1');
        expect(got!.props).toEqual({ title: 'Second' });
        // Whole-record: the first write's userId must NOT survive a
        // replacement that omitted it.
        expect(got!.userId).toBeUndefined();
      });
    });

    it('rejects an empty sessionId', async () => {
      await withStore(async (store) => {
        await expect(store.put(record({ sessionId: '' }))).rejects.toThrow();
      });
    });

    it('returns null for a session never written — never throws', async () => {
      await withStore(async (store) => {
        expect(await store.get('never-written')).toBeNull();
      });
    });

    it('get returns a defensive copy', async () => {
      await withStore(async (store) => {
        await store.put(record());
        const first = await store.get('render-1');
        (first!.props as Record<string, unknown>)['title'] = 'MUTATED';
        const second = await store.get('render-1');
        expect(second!.props).toEqual({ title: 'Hello' });
      });
    });

    it(`declares durability: '${factory.expectedDurability}' — and the declaration is graded, not trusted`, async () => {
      await withStore(async (store) => {
        expect(store.durability).toBe(factory.expectedDurability);
      });
    });
  });
}
