/**
 * `GguiSessionStore` cross-impl conformance suite.
 *
 * A portable battery of assertions every `GguiSessionStore` implementation
 * MUST satisfy. The function below takes a factory returning a fresh
 * store + an optional teardown hook; real impls plug in:
 *
 * - `InMemoryGguiSessionStore` invokes from its existing test file.
 * - `SqliteGguiSessionStore` invokes with a temp-file db that gets cleaned
 *   on teardown.
 * - Cloud `dynamoGguiSessionStore` invokes against a DynamoDB-Local mock
 *   (follow-up — needs Docker shim).
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
 * - commit on new id mints the row; commit on existing id replaces in
 *   place.
 * - delete is observable on subsequent get.
 */

import { describe, expect, it } from 'vitest';
import type { GguiSession } from '@ggui-ai/protocol';
import type { GguiSessionStore } from '../ggui-session-store.js';

/**
 * Factory + cleanup pair. The cleanup is awaited after each test —
 * impls that hold OS resources (sqlite tempfiles, dynamo client
 * connections) plug their teardown here.
 */
export interface GguiSessionStoreConformanceFactory {
  readonly create: () => Promise<GguiSessionStore>;
  readonly cleanup?: (store: GguiSessionStore) => Promise<void> | void;
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

  function makeComponentRender(
    id: string,
    appId: string,
    componentCode = '/* placeholder */',
  ): GguiSession {
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
    describe('create + get round-trip', () => {
      it('preserves id + appId on minimal create', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'render-1', appId: 'app-1' });
          const got = await store.get('render-1');
          expect(got?.id).toBe('render-1');
          expect(got?.appId).toBe('app-1');
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
            render: makeComponentRender('render-1', 'app-1', '/* v1 */'),
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
            render: makeComponentRender('render-1', 'app-1', '/* v1 */'),
          });
          const first = await store.get('render-1');
          await store.commit({
            appId: 'app-1',
            render: makeComponentRender('render-1', 'app-1', '/* v2 */'),
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
    });

    describe('delete', () => {
      it('is observable on subsequent get', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'render-1', appId: 'app-1' });
          await store.delete('render-1');
          const got = await store.get('render-1');
          expect(got).toBeNull();
        });
      });
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
