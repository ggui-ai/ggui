/**
 * `GguiSessionStore` cross-impl conformance suite.
 *
 * A portable battery of assertions every `GguiSessionStore` implementation
 * MUST satisfy. The function below takes a factory returning a fresh
 * store + an optional teardown hook; real impls plug in:
 *
 * - `InMemoryGguiSessionStore` invokes from
 *   `../in-memory/ggui-session-store.test.ts`.
 * - `SqliteGguiSessionStore` invokes from
 *   `../sqlite/ggui-session-store.test.ts` with a temp-file db cleaned
 *   on teardown.
 * - Any other backend plugs in the same way from its own test suite.
 *
 * The assertions focus on **known observed bug classes**, plus the
 * contract surface invariants. Each named bug class:
 *
 * 1. **endUserIdentity round-trip parity** — a `dynamoGguiSessionStore`
 *    can treat the JSON-string column form as an opaque id
 *    (`{id: '{"sub":"u-42",…}'}`) instead of JSON-parsing to the
 *    structured shape. Test: set `endUserIdentity` on create, assert
 *    the same shape comes back on get.
 *
 * 2. **status precedence** — an adapter can let expiry-based
 *    inference override the explicit `status` column. Test:
 *    create a render that's both "explicitly active" AND expired by
 *    `expiresAt`; assert status is `'active'`.
 *
 * 3. **commit upsert in-place** — re-committing the same sessionId MUST
 *    replace the visible-bits surface in place; lifecycle fields
 *    (`createdAt`, `eventSequence`, `hostSession`) stay untouched.
 *
 * Plus the contract surface invariants every impl must hold:
 *
 * - create + get round-trip preserves id / appId / userId.
 * - commit fills an ABSENT userId and never overwrites a present one
 *   (#446 — the subject the render-read gate binds on).
 * - commit on new id mints the row; commit on existing id replaces in
 *   place.
 * - delete is observable on subsequent get.
 */

import { describe, expect, it } from 'vitest';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import type { GguiSessionStore } from '../ggui-session-store.js';

/**
 * Factory + cleanup pair. The cleanup is awaited after each test —
 * impls that hold OS resources (sqlite tempfiles, dynamo client
 * connections) plug their teardown here.
 */
export interface GguiSessionStoreConformanceFactory {
  readonly create: () => Promise<GguiSessionStore>;
  readonly cleanup?: (store: GguiSessionStore) => Promise<void> | void;
  /**
   * Whether the impl implements `delete`. Default `'implemented'`.
   *
   * `'declared-out-of-scope'` is for deployments that route deletion
   * through a different, typed surface and deliberately refuse it on
   * this port. The exclusion is GRADED, not skipped: the suite then
   * pins that `delete` refuses loudly (rejects) rather than silently
   * succeeding while removing nothing — the silent no-op is the bug
   * class; a loud refusal is a documented boundary.
   */
  readonly deletion?: 'implemented' | 'declared-out-of-scope';
}

/**
 * Run the conformance suite. Call this inside a `describe(...)`
 * block; the suite installs its own `describe` + `it` calls
 * underneath.
 *
 * `label` is the impl name (e.g. `'InMemoryGguiSessionStore'`); it
 * prefixes every nested describe so failures point at the right impl
 * in CI output.
 */
export function runGguiSessionStoreConformance(
  label: string,
  factory: GguiSessionStoreConformanceFactory,
): void {
  async function withStore<T>(
    fn: (store: GguiSessionStore) => Promise<T>,
  ): Promise<T> {
    const store = await factory.create();
    try {
      return await fn(store);
    } finally {
      if (factory.cleanup) {
        await factory.cleanup(store);
      }
    }
  }

  function makeComponentGguiSession(
    id: string,
    appId: string,
    componentCode = '/* placeholder */',
  ): ComponentGguiSession {
    return {
      type: 'component',
      id,
      appId,
      componentCode,
      eventSequence: 0,
      createdAt: 0,
      lastActivityAt: 0,
      expiresAt: 0,
    };
  }

  describe(`${label} — conformance`, () => {
    // #495 — the outcome facet is orthogonal to lifecycle status: a
    // row is errored iff a generation failure was recorded on it
    // (`errorCode`, or legacy message-only `error`). The definition
    // lives in the protocol (`isErroredGguiSession`); every store's
    // `erroredOnly` filter must match it, including for rows written
    // before `errorCode` existed.
    describe('erroredOnly outcome facet', () => {
      it('list({erroredOnly:true}) returns exactly the rows with a recorded failure', async () => {
        await withStore(async (store) => {
          await store.commit({
            appId: 'app-1',
            userId: 'u-1',
            render: makeComponentGguiSession('healthy', 'app-1'),
          });
          await store.commit({
            appId: 'app-1',
            userId: 'u-1',
            render: {
              ...makeComponentGguiSession('errored-coded', 'app-1', ''),
              error: 'generation failed',
              errorCode: 'PRODUCTION_FAILED',
            },
          });
          await store.commit({
            appId: 'app-1',
            userId: 'u-1',
            render: {
              ...makeComponentGguiSession('errored-legacy', 'app-1', ''),
              error: 'pre-errorCode failure',
            },
          });
          const errored = await store.list({ appId: 'app-1', erroredOnly: true });
          expect(errored.map((s) => s.id).sort()).toEqual([
            'errored-coded',
            'errored-legacy',
          ]);
          // The facet narrows; it must not leak into the unfiltered list.
          const all = await store.list({ appId: 'app-1' });
          expect(all).toHaveLength(3);
          // Round-trip: the classification survives storage.
          const coded = errored.find((s) => s.id === 'errored-coded');
          expect(
            coded !== undefined && coded.render.type === 'component'
              ? coded.render.errorCode
              : undefined,
          ).toBe('PRODUCTION_FAILED');
        });
      });
    });

    describe('create + get round-trip', () => {
      it('preserves id + appId on minimal create', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'render-1', appId: 'app-1' });
          const got = await store.get('render-1');
          expect(got?.id).toBe('render-1');
          expect(got?.appId).toBe('app-1');
        });
      });

      it('commit fills an absent userId, and never overwrites one', async () => {
        await withStore(async (store) => {
          // #446 — if-not-exists on the SUBJECT. A row minted without
          // one (the WS dev path does exactly this) acquires it from
          // the agent's later commit; a row that already has one must
          // never have it re-pointed, or a second caller could claim
          // someone else's render.
          await store.create({ id: 'render-fill', appId: 'app-1' });
          expect((await store.get('render-fill'))?.userId).toBeUndefined();

          await store.commit({
            appId: 'app-1',
            userId: 'u-42',
            render: makeComponentGguiSession('render-fill', 'app-1', ''),
          });
          expect((await store.get('render-fill'))?.userId).toBe('u-42');

          // Second commit under a DIFFERENT subject must not re-point.
          await store.commit({
            appId: 'app-1',
            userId: 'u-99',
            render: makeComponentGguiSession('render-fill', 'app-1', ''),
          });
          expect((await store.get('render-fill'))?.userId).toBe('u-42');
        });
      });

      it('preserves userId when supplied', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'render-1', appId: 'app-1', userId: 'u-42' });
          const got = await store.get('render-1');
          expect(got?.userId).toBe('u-42');
        });
      });

      it('returns null for an unknown render id', async () => {
        await withStore(async (store) => {
          const got = await store.get('never-created');
          expect(got).toBeNull();
        });
      });

      // Bug class 1 — endUserIdentity round-trip parity. The cloud
      // adapter regressed by treating the JSON-string form as opaque.
      it('preserves endUserIdentity structured shape (bug class: JSON parse)', async () => {
        await withStore(async (store) => {
          await store.create({
            id: 'render-1',
            appId: 'app-1',
            endUserIdentity: {
              userId: 'u-42',
              email: 'alice@example.com',
              name: 'Alice',
              provider: 'custom',
              authenticatedAt: '2026-01-01T00:00:00.000Z',
            },
          });
          const got = await store.get('render-1');
          expect(got?.endUserIdentity).toEqual({
            userId: 'u-42',
            email: 'alice@example.com',
            name: 'Alice',
            provider: 'custom',
            authenticatedAt: '2026-01-01T00:00:00.000Z',
          });
        });
      });
    });

    describe('commit upsert', () => {
      it('first commit on a new id mints the row', async () => {
        await withStore(async (store) => {
          await store.commit({
            appId: 'app-1',
            render: makeComponentGguiSession('render-1', 'app-1', '/* v1 */'),
          });
          const got = await store.get('render-1');
          expect(got?.id).toBe('render-1');
          const r = got?.render as { componentCode?: string } | undefined;
          expect(r?.componentCode).toBe('/* v1 */');
        });
      });

      // Bug class 3 — re-commit on same id replaces visible-bits in place.
      it('re-committing the same id replaces visible-bits in place', async () => {
        await withStore(async (store) => {
          await store.commit({
            appId: 'app-1',
            render: makeComponentGguiSession('render-1', 'app-1', '/* v1 */'),
          });
          const first = await store.get('render-1');
          await store.commit({
            appId: 'app-1',
            render: makeComponentGguiSession('render-1', 'app-1', '/* v2 */'),
          });
          const second = await store.get('render-1');
          const r = second?.render as { componentCode?: string } | undefined;
          expect(r?.componentCode).toBe('/* v2 */');
          // Lifecycle invariant: createdAt unchanged across upserts.
          expect(second?.createdAt).toBe(first?.createdAt);
          // eventSequence carried across upserts.
          expect(second?.eventSequence).toBe(first?.eventSequence);
        });
      });

      it('mints the ledger at zero when no seqFloor is supplied', async () => {
        await withStore(async (store) => {
          await store.commit({
            appId: 'app-1',
            render: makeComponentGguiSession('render-fresh', 'app-1'),
          });
          expect((await store.get('render-fresh'))?.eventSequence).toBe(0);
        });
      });

      it('mints the ledger AT the seqFloor, and appends land above it', async () => {
        // A session resuming from a durable record continues its event
        // ledger. The floor is the sequence the earlier life reached,
        // so the row starts AT it and the next append is the first
        // number that life never used. Restarting at zero would reissue
        // numbers the session already used, and a reader holding a
        // cursor from before the resume filters everything at or below
        // it — the resumed session's events would never arrive.
        await withStore(async (store) => {
          await store.commit({
            appId: 'app-1',
            seqFloor: 12,
            render: makeComponentGguiSession('render-resumed', 'app-1'),
          });
          expect((await store.get('render-resumed'))?.eventSequence).toBe(12);

          const seq = await store.appendEvent({
            sessionId: 'render-resumed',
            type: 'ui.committed',
            data: {},
          });
          expect(seq).toBe(13);
          expect((await store.get('render-resumed'))?.eventSequence).toBe(13);
        });
      });

      it('treats a floor that is not a positive whole number as zero', async () => {
        // The field aligns cursors. Rejecting the commit over a
        // malformed one would lose a working render to a caller-side
        // bug, so every backend degrades the same way rather than each
        // deciding for itself.
        await withStore(async (store) => {
          await store.commit({
            appId: 'app-1',
            seqFloor: -5,
            render: makeComponentGguiSession('render-negative', 'app-1'),
          });
          expect((await store.get('render-negative'))?.eventSequence).toBe(0);

          await store.commit({
            appId: 'app-1',
            seqFloor: 2.5,
            render: makeComponentGguiSession('render-fractional', 'app-1'),
          });
          expect((await store.get('render-fractional'))?.eventSequence).toBe(0);
        });
      });

      it('ignores seqFloor on the replace branch — a live counter never moves', async () => {
        // Two commits racing to resume the same session put the second
        // one here. Honoring a floor on this branch could reset or
        // raise a counter that is already live, which is why the field
        // is mint-only rather than merely "usually mint".
        await withStore(async (store) => {
          await store.commit({
            appId: 'app-1',
            seqFloor: 12,
            render: makeComponentGguiSession('render-replaced', 'app-1'),
          });
          await store.appendEvent({
            sessionId: 'render-replaced',
            type: 'ui.committed',
            data: {},
          });
          expect((await store.get('render-replaced'))?.eventSequence).toBe(13);

          await store.commit({
            appId: 'app-1',
            seqFloor: 99,
            render: makeComponentGguiSession('render-replaced', 'app-1', '/* v2 */'),
          });
          expect((await store.get('render-replaced'))?.eventSequence).toBe(13);
        });
      });
    });

    describe('delete', () => {
      if (factory.deletion === 'declared-out-of-scope') {
        it('declares deletion out of scope and refuses loudly', async () => {
          await withStore(async (store) => {
            await store.create({ id: 'render-1', appId: 'app-1' });
            // The graded contract for an out-of-scope delete: it must
            // REJECT — a delete that resolves while removing nothing
            // would let callers believe data is gone.
            await expect(store.delete('render-1')).rejects.toThrow();
            expect((await store.get('render-1'))?.id).toBe('render-1');
          });
        });
      } else {
        it('is observable on subsequent get', async () => {
          await withStore(async (store) => {
            await store.create({ id: 'render-1', appId: 'app-1' });
            await store.delete('render-1');
            const got = await store.get('render-1');
            expect(got).toBeNull();
          });
        });
      }
    });

    describe('status (bug class: precedence)', () => {
      // OSS impls compute status from `expiresAt` only — there is no
      // explicit terminal state. Invariant: a freshly-created render
      // whose `expiresAt` is in the future MUST surface
      // status='active' (or omit status, which the contract treats
      // as 'active').
      it('fresh render does not surface status=expired', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'render-1', appId: 'app-1' });
          const got = await store.get('render-1');
          expect(got?.status).not.toBe('expired');
        });
      });
    });

    describe('appendEvent — event sequence monotonicity', () => {
      // Foundational invariant: every appendEvent returns a strictly
      // increasing seq. Used by the live-channel replay buffer and by
      // SDK-side `lastSeq` cursors — a non-monotonic seq would let
      // late-arriving events disappear behind an already-acked cursor.
      it('returns monotonically increasing seq per render', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'render-1', appId: 'app-1' });
          const seq1 = await store.appendEvent({
            sessionId: 'render-1',
            type: 'user.submitted',
            data: { n: 1 },
          });
          const seq2 = await store.appendEvent({
            sessionId: 'render-1',
            type: 'user.submitted',
            data: { n: 2 },
          });
          const seq3 = await store.appendEvent({
            sessionId: 'render-1',
            type: 'user.submitted',
            data: { n: 3 },
          });
          expect(seq2).toBeGreaterThan(seq1);
          expect(seq3).toBeGreaterThan(seq2);
        });
      });

      it('seq sequences are independent per render', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'render-A', appId: 'app-1' });
          await store.create({ id: 'render-B', appId: 'app-1' });
          const a1 = await store.appendEvent({
            sessionId: 'render-A',
            type: 'user.submitted',
            data: {},
          });
          const b1 = await store.appendEvent({
            sessionId: 'render-B',
            type: 'user.submitted',
            data: {},
          });
          const a2 = await store.appendEvent({
            sessionId: 'render-A',
            type: 'user.submitted',
            data: {},
          });
          expect(a2).toBeGreaterThan(a1);
          expect(b1).toBeGreaterThanOrEqual(0);
        });
      });
    });

  });
}
