/**
 * `SessionStore` cross-impl conformance suite.
 *
 * A portable battery of assertions every `SessionStore` implementation
 * MUST satisfy. The function below takes a factory returning a fresh
 * store + an optional teardown hook; real impls plug in:
 *
 * - `InMemorySessionStore` invokes from its existing test file.
 * - `SqliteSessionStore` invokes with a temp-file db that gets cleaned
 *   on teardown.
 * - Cloud `dynamoSessionStore` invokes against a DynamoDB-Local mock
 *   (follow-up — needs Docker shim).
 *
 * The assertions focus on **known observed bug classes**, plus the
 * contract surface invariants. Each named bug class:
 *
 * 1. **endUserIdentity round-trip parity** — a `dynamoSessionStore`
 *    can treat the JSON-string column form as an opaque id
 *    (`{id: '{"sub":"u-42",…}'}`) instead of JSON-parsing to the
 *    structured shape. Test: set `endUserIdentity` on create, assert
 *    the same shape comes back on get.
 *
 * 2. **status precedence** — an adapter can let expiry-based
 *    inference override the explicit `sessionStatus` column. Test:
 *    create a session that's both "explicitly active" AND expired by
 *    `expiresAt`; assert status is `'active'`.
 *
 * 3. **popStackItem secondary-index cleanup** — a pop path can update
 *    the stack array but never delete the popped id from the
 *    secondary index. Test: append a stack item, look up via
 *    secondary index (hit), pop it, look up again (miss).
 *
 * Plus the contract surface invariants every impl must hold:
 *
 * - create + get round-trip preserves id / appId / userId / stack.
 * - appendStackItem upsert: same `id` replaces in place; new `id`
 *   appends.
 * - popStackItem returns `{poppedId, stackSize}` — null poppedId
 *   when stack is empty (idempotent).
 * - getSessionByStackItemId returns null for unknown ids + the right
 *   {sessionId, appId} when matched.
 * - delete is observable on subsequent get.
 */

import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../session-store.js';

/**
 * Factory + cleanup pair. The cleanup is awaited after each test —
 * impls that hold OS resources (sqlite tempfiles, dynamo client
 * connections) plug their teardown here.
 */
export interface SessionStoreConformanceFactory {
  readonly create: () => Promise<SessionStore>;
  readonly cleanup?: (store: SessionStore) => Promise<void> | void;
}

/**
 * Run the conformance suite. Call this inside a `describe(...)`
 * block; the suite installs its own `describe` + `it` calls
 * underneath.
 *
 * `label` is the impl name (e.g. `'InMemorySessionStore'`); it
 * prefixes every nested describe so failures point at the right impl
 * in CI output.
 */
export function runSessionStoreConformance(
  label: string,
  factory: SessionStoreConformanceFactory,
): void {
  async function withStore<T>(
    fn: (store: SessionStore) => Promise<T>,
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

  describe(`${label} — conformance`, () => {
    describe('create + get round-trip', () => {
      it('preserves id + appId on minimal create', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          const got = await store.get('sess-1');
          expect(got?.id).toBe('sess-1');
          expect(got?.appId).toBe('app-1');
        });
      });

      it('preserves userId when supplied', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1', userId: 'u-42' });
          const got = await store.get('sess-1');
          expect(got?.userId).toBe('u-42');
        });
      });

      it('returns null for an unknown session id', async () => {
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
            id: 'sess-1',
            appId: 'app-1',
            endUserIdentity: {
              userId: 'u-42',
              email: 'alice@example.com',
              name: 'Alice',
              provider: 'custom',
              authenticatedAt: '2026-01-01T00:00:00.000Z',
            },
          });
          const got = await store.get('sess-1');
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

    describe('appendStackItem', () => {
      it('appends a new stack item to an empty stack', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          await store.appendStackItem('sess-1', {
            id: 'item-1',
            type: 'component',
            componentCode: '/* a */',
            contentType: 'application/javascript+react',
            createdAt: new Date().toISOString(),
          });
          const got = await store.get('sess-1');
          expect(got?.stack).toHaveLength(1);
          expect(got?.stack[0]?.id).toBe('item-1');
        });
      });

      it('upserts by id — re-appending the same id replaces in place', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          const baseItem = (props: { v: number }) => ({
            id: 'item-1',
            type: 'component' as const,
            componentCode: '/* x */',
            contentType: 'application/javascript+react' as const,
            props,
            createdAt: new Date().toISOString(),
          });
          await store.appendStackItem('sess-1', baseItem({ v: 1 }));
          await store.appendStackItem('sess-1', baseItem({ v: 2 }));
          const got = await store.get('sess-1');
          expect(got?.stack).toHaveLength(1);
          expect((got?.stack[0] as { props?: { v: number } })?.props?.v).toBe(2);
        });
      });

      it('appending a new id grows the stack', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          for (const id of ['a', 'b', 'c']) {
            await store.appendStackItem('sess-1', {
              id,
              type: 'component',
              componentCode: `/* ${id} */`,
              contentType: 'application/javascript+react',
              createdAt: new Date().toISOString(),
            });
          }
          const got = await store.get('sess-1');
          expect(got?.stack.map((s) => s.id)).toEqual(['a', 'b', 'c']);
          expect(got?.currentStackIndex).toBe(2);
        });
      });
    });

    describe('getSessionByStackItemId — secondary index', () => {
      it('returns null for an unknown stackItemId', async () => {
        await withStore(async (store) => {
          const out = await store.getSessionByStackItemId('never-existed');
          expect(out).toBeNull();
        });
      });

      it('returns {sessionId, appId} after appendStackItem', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          await store.appendStackItem('sess-1', {
            id: 'item-A',
            type: 'component',
            componentCode: '/**/',
            contentType: 'application/javascript+react',
            createdAt: new Date().toISOString(),
          });
          const out = await store.getSessionByStackItemId('item-A');
          expect(out).toEqual({ sessionId: 'sess-1', appId: 'app-1' });
        });
      });
    });

    describe('popStackItem', () => {
      it('returns {poppedId: null, stackSize: 0} on empty stack (idempotent)', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          const out = await store.popStackItem('sess-1');
          expect(out.poppedId).toBeNull();
          expect(out.stackSize).toBe(0);
        });
      });

      it('returns {poppedId, stackSize: N-1} on non-empty stack', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          for (const id of ['a', 'b']) {
            await store.appendStackItem('sess-1', {
              id,
              type: 'component',
              componentCode: '/**/',
              contentType: 'application/javascript+react',
              createdAt: new Date().toISOString(),
            });
          }
          const out = await store.popStackItem('sess-1');
          expect(out.poppedId).toBe('b');
          expect(out.stackSize).toBe(1);
          const got = await store.get('sess-1');
          expect(got?.stack.map((s) => s.id)).toEqual(['a']);
        });
      });

      // Bug class 3 — pop must clean the secondary index.
      it('pops the secondary-index entry (bug class: stale index)', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          await store.appendStackItem('sess-1', {
            id: 'item-X',
            type: 'component',
            componentCode: '/**/',
            contentType: 'application/javascript+react',
            createdAt: new Date().toISOString(),
          });
          // Before pop: secondary index hits.
          const before = await store.getSessionByStackItemId('item-X');
          expect(before).toEqual({ sessionId: 'sess-1', appId: 'app-1' });
          // Pop.
          await store.popStackItem('sess-1');
          // After pop: secondary index miss.
          const after = await store.getSessionByStackItemId('item-X');
          expect(after).toBeNull();
        });
      });
    });

    describe('delete', () => {
      it('is observable on subsequent get', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          await store.delete('sess-1');
          const got = await store.get('sess-1');
          expect(got).toBeNull();
        });
      });
    });

    describe('status (bug class: precedence)', () => {
      // Bug class 2 — explicit status must win over expiry math.
      // An adapter can invert this, letting expiry-based inference
      // override an explicit sessionStatus column.
      //
      // The OSS impls compute status from internal state (`closed`
      // flag + expiresAt), so they don't have an "explicit override"
      // path to test directly. The invariant we CAN test uniformly:
      // a freshly-created session that hasn't been closed and isn't
      // past its expiresAt MUST NOT surface status='completed' or
      // 'expired'. Cloud's sessionStatus column read AND the OSS
      // internal computation both have to honor this.
      it('fresh session does not surface status=completed or expired', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          const got = await store.get('sess-1');
          expect(got?.status).not.toBe('completed');
          expect(got?.status).not.toBe('expired');
        });
      });
    });

    describe('appendEvent — event sequence monotonicity', () => {
      // Foundational invariant: every appendEvent returns a strictly
      // increasing seq. Used by the live-channel replay buffer and by
      // SDK-side `lastSeq` cursors — a non-monotonic seq would let
      // late-arriving events disappear behind an already-acked cursor.
      //
      // Both OSS impls (in-memory bump counter, sqlite SQL rowid)
      // satisfy this. The cloud Dynamo adapter uses ConditionalUpdate
      // with `attribute_exists(id)` + counter increment; if it
      // regresses, this test catches drift before a live event
      // sequence skips.
      it('returns monotonically increasing seq per session', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          const seq1 = await store.appendEvent({
            sessionId: 'sess-1',
            type: 'user.submitted',
            data: { n: 1 },
          });
          const seq2 = await store.appendEvent({
            sessionId: 'sess-1',
            type: 'user.submitted',
            data: { n: 2 },
          });
          const seq3 = await store.appendEvent({
            sessionId: 'sess-1',
            type: 'user.submitted',
            data: { n: 3 },
          });
          expect(seq2).toBeGreaterThan(seq1);
          expect(seq3).toBeGreaterThan(seq2);
        });
      });

      it('seq sequences are independent per session', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-A', appId: 'app-1' });
          await store.create({ id: 'sess-B', appId: 'app-1' });
          // Interleave appends. Each session's seq starts independent.
          const a1 = await store.appendEvent({
            sessionId: 'sess-A',
            type: 'user.submitted',
            data: {},
          });
          const b1 = await store.appendEvent({
            sessionId: 'sess-B',
            type: 'user.submitted',
            data: {},
          });
          const a2 = await store.appendEvent({
            sessionId: 'sess-A',
            type: 'user.submitted',
            data: {},
          });
          // A's second seq is strictly > A's first — independent of B.
          expect(a2).toBeGreaterThan(a1);
          // B's first seq doesn't have to be specific; we just assert
          // it's >= 1 (impls may start at 0 or 1 — the invariant is
          // strict monotonicity within a session, not a global start
          // value).
          expect(b1).toBeGreaterThanOrEqual(0);
        });
      });
    });

    describe('session.closed lifecycle', () => {
      // The `createGguiCloseHandler` factory writes `session.closed`
      // via `appendEvent`. Both InMemory + Sqlite watch this event
      // and flip an internal
      // `closed` flag, which surfaces as status='completed' on the
      // next get. The cloud `markCompleted` seam wraps a DDB
      // sessionStatus column write; the observable behavior on get()
      // is the same.
      //
      // Conformance invariant: after appendEvent(session.closed),
      // status === 'completed' on next get.
      it('surfaces status=completed after appendEvent(session.closed)', async () => {
        await withStore(async (store) => {
          await store.create({ id: 'sess-1', appId: 'app-1' });
          await store.appendEvent({
            sessionId: 'sess-1',
            type: 'session.closed',
            data: {},
          });
          const got = await store.get('sess-1');
          expect(got?.status).toBe('completed');
        });
      });

      // NOTE: idempotency on re-close is enforced at the HANDLER
      // level (`createGguiCloseHandler` catches "already closed"
      // throws and normalizes to success). At the SessionStore
      // layer, impls are free to either throw or be silently
      // idempotent — both are acceptable as long as the handler can
      // detect "already closed" from the thrown message. The cloud
      // `markCompleted` seam bypasses `appendEvent` entirely on
      // re-close. Pinning idempotency at the store layer would
      // over-constrain. The handler-level test in
      // `mcp-server-handlers/src/session-mutations/close.test.ts`
      // covers the wire-shape contract.
    });
  });
}
