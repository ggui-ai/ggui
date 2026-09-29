/**
 * `PendingEventConsumer` cross-impl conformance suite.
 *
 * Locks in the contract every consumer implementation must satisfy:
 *
 *   - `consumeAndClear` atomicity — events appear once, get cleared,
 *     return on the first call only.
 *   - `append` ordering — multiple events appended in order surface
 *     in FIFO order on the next `consumeAndClear`.
 *   - `append`'s outcome — `'appended'` for the call that stored the row,
 *     `'duplicate'` for every repeat of its `(sessionId, id)`, drained or
 *     not (ggui#1517).
 *   - `PendingPipeNotFoundError` shape — thrown on consume/append against
 *     an unseeded render; class instanceof OR `name` field check both
 *     pass (cloud's adapter throws its own class).
 *
 * Same factory + cleanup pattern as `ggui-session-store.conformance.ts`.
 *
 * Seed semantics: PendingEventConsumer is a per-render buffer; every
 * test needs a render to be present in the consumer's bookkeeping
 * before consume/append can succeed. Real impls expose this via
 * `markCreated(sessionId, ttlMs?)` (in-memory + sqlite) or a parallel
 * DDB row write (cloud). The factory's `seed(sessionId)` callback
 * wraps whichever path the impl exposes.
 */

import { describe, expect, it } from 'vitest';
import type { PendingEvent } from '@ggui-ai/protocol';
import type { PendingEventConsumer } from '../pending-event-consumer.js';

/** A well-formed pipe row — `id` doubles as the intent so tests can tell rows apart. */
function row(id: string): PendingEvent {
  return {
    id,
    envelope: {
      type: 'action',
      sessionId: 'render-1',
      intent: id,
      actionData: null,
      uiContext: {},
      actionId: id,
      firedAt: '2026-09-05T00:00:00.000Z',
    },
    createdAt: '2026-09-05T00:00:00.000Z',
  };
}

export interface PendingEventConsumerConformanceFactory {
  readonly create: () => Promise<{
    readonly consumer: PendingEventConsumer;
    /** Register `sessionId` so subsequent consume/append succeeds. */
    readonly seed: (sessionId: string) => void | Promise<void>;
  }>;
  readonly cleanup?: (consumer: PendingEventConsumer) => Promise<void> | void;
  /**
   * Whether the store reports `'conflict'` for an id reused with a different
   * gesture digest (ggui#1519). A SHOULD this release, as SPEC §11.1's
   * promise is: a store written against the earlier port answers
   * `'duplicate'` there, which keeps the first gesture too. The three cases
   * that need a reported conflict run only when this is `true`; every other
   * case runs for every store. It becomes required with the MUST.
   */
  readonly reportsConflict?: boolean;
}

export function runPendingEventConsumerConformance(
  label: string,
  factory: PendingEventConsumerConformanceFactory,
): void {
  async function withConsumer<T>(
    fn: (helpers: {
      consumer: PendingEventConsumer;
      seed: (id: string) => Promise<void> | void;
    }) => Promise<T>,
  ): Promise<T> {
    const helpers = await factory.create();
    try {
      return await fn(helpers);
    } finally {
      if (factory.cleanup) {
        await factory.cleanup(helpers.consumer);
      }
    }
  }

  describe(`${label} — conformance`, () => {
    describe('consumeAndClear', () => {
      it('returns empty + active on a freshly-seeded render', async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          const out = await consumer.consumeAndClear('render-1', 1000);
          expect(out.events).toEqual([]);
          expect(out.status === 'active' || out.status === undefined).toBe(
            true,
          );
        });
      });

      it('throws PendingPipeNotFoundError on an unseeded render', async () => {
        await withConsumer(async ({ consumer }) => {
          try {
            await consumer.consumeAndClear('never-seeded', 1000);
            // If we got here, the impl is broken.
            expect.fail(
              'expected consumeAndClear to throw PendingPipeNotFoundError',
            );
          } catch (err) {
            // Cloud + OSS adapters either throw the canonical class
            // or a structurally-identical one; the docstring contract
            // pins detection by `name`.
            expect((err as Error).name).toBe('PendingPipeNotFoundError');
          }
        });
      });
    });

    describe('append validates the row (ggui#839)', () => {
      it('a row that fails pendingEventSchema is refused on append with PendingEventMalformedError — nothing is stored', async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          await expect(
            consumer.append('render-1', { ...row('x'), id: '' }),
          ).rejects.toMatchObject({ name: 'PendingEventMalformedError', sessionId: 'render-1' });
          const out = await consumer.consumeAndClear('render-1', 1000);
          expect(out.events).toEqual([]);
        });
      });
    });

    describe('append + consumeAndClear (FIFO)', () => {
      it('surfaces appended events in FIFO order on next consume', async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          await consumer.append('render-1', row('first'));
          await consumer.append('render-1', row('second'));
          await consumer.append('render-1', row('third'));
          const out = await consumer.consumeAndClear('render-1', 1000);
          expect(out.events.length).toBe(3);
          expect(out.events.map((e) => e.id)).toEqual([
            'first',
            'second',
            'third',
          ]);
        });
      });

      it('clears the buffer — second consume returns empty', async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          await consumer.append('render-1', row('a'));
          const first = await consumer.consumeAndClear('render-1', 1000);
          expect(first.events.length).toBe(1);
          const second = await consumer.consumeAndClear('render-1', 1000);
          expect(second.events).toEqual([]);
        });
      });

      it('throws PendingPipeNotFoundError on append to unseeded render', async () => {
        await withConsumer(async ({ consumer }) => {
          try {
            await consumer.append('never-seeded', row('lost'));
            expect.fail('expected append to throw PendingPipeNotFoundError');
          } catch (err) {
            expect((err as Error).name).toBe('PendingPipeNotFoundError');
          }
        });
      });
    });

    describe("append reports its outcome, once per (sessionId, id) for the pipe's lifetime (ggui#405, ggui#1517)", () => {
      it("the first append of an id reports 'appended'; a repeat reports 'duplicate' and stores nothing", async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          expect(await consumer.append('render-1', row('once'))).toBe('appended');
          expect(await consumer.append('render-1', row('once'))).toBe('duplicate');
          const out = await consumer.consumeAndClear('render-1', 1000);
          expect(out.events.map((e) => e.id)).toEqual(['once']);
        });
      });

      it("a repeat after the row was drained still reports 'duplicate' and is not delivered again", async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          expect(await consumer.append('render-1', row('drained'))).toBe('appended');
          expect((await consumer.consumeAndClear('render-1', 1000)).events.length).toBe(1);
          expect(await consumer.append('render-1', row('drained'))).toBe('duplicate');
          expect((await consumer.consumeAndClear('render-1', 1000)).events).toEqual([]);
        });
      });

      it("the same id on another session is that session's own row: 'appended'", async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-A');
          await seed('render-B');
          expect(await consumer.append('render-A', row('shared'))).toBe('appended');
          expect(await consumer.append('render-B', row('shared'))).toBe('appended');
        });
      });
    });

    describe("a reused id carrying a different gesture is a conflict, and two in-flight duplicates are one append (ggui#1519)", () => {
      // The conflict cases need a store that reports it (a SHOULD this
      // release). A store that does not opt in has its conflict behaviour
      // UNTESTED, not tested-and-absent, so each skipped case names the store
      // in its own title: a run shows which store is unverified, not a count.
      const conflictVerified = factory.reportsConflict === true;
      const itConflict = conflictVerified ? it : it.skip;
      const conflictTitle = (title: string): string =>
        conflictVerified ? title : `${title} — UNVERIFIED for ${label}: its factory does not set reportsConflict`;
      const A = 'AAAAAAAAAAAAAAAAAAAAAA';
      const B = 'BBBBBBBBBBBBBBBBBBBBBB';

      it("the same id with the same gesture digest reports 'duplicate'", async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          expect(await consumer.append('render-1', row('g'), { gestureDigest: A })).toBe('appended');
          expect(await consumer.append('render-1', row('g'), { gestureDigest: A })).toBe('duplicate');
        });
      });

      itConflict(conflictTitle("the same id with a different gesture digest reports 'conflict', stores nothing, and the first gesture stands"), async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          expect(await consumer.append('render-1', row('g'), { gestureDigest: A })).toBe('appended');
          expect(await consumer.append('render-1', row('g'), { gestureDigest: B })).toBe('conflict');
          expect((await consumer.consumeAndClear('render-1', 1000)).events.map((e) => e.id)).toEqual(['g']);
        });
      });

      itConflict(conflictTitle("the conflict outlives a drain, as the seen id does"), async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          await consumer.append('render-1', row('g'), { gestureDigest: A });
          await consumer.consumeAndClear('render-1', 1000);
          expect(await consumer.append('render-1', row('g'), { gestureDigest: B })).toBe('conflict');
          expect((await consumer.consumeAndClear('render-1', 1000)).events).toEqual([]);
        });
      });

      it("a difference is only a conflict when BOTH digests are known: a missing one on either side reads 'duplicate'", async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          // Seen with no digest (a row from before digests, or a caller that sends none).
          expect(await consumer.append('render-1', row('legacy'))).toBe('appended');
          expect(await consumer.append('render-1', row('legacy'), { gestureDigest: A })).toBe('duplicate');
          // Seen with a digest, repeated with none.
          expect(await consumer.append('render-1', row('known'), { gestureDigest: A })).toBe('appended');
          expect(await consumer.append('render-1', row('known'))).toBe('duplicate');
        });
      });

      it("two appends of one id in flight together: exactly one 'appended', and one event delivered", async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          const outcomes = await Promise.all([
            consumer.append('render-1', row('race'), { gestureDigest: A }),
            consumer.append('render-1', row('race'), { gestureDigest: A }),
          ]);
          expect(outcomes.filter((o) => o === 'appended')).toHaveLength(1);
          expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(1);
          expect((await consumer.consumeAndClear('render-1', 1000)).events.map((e) => e.id)).toEqual(['race']);
        });
      });

      itConflict(conflictTitle("two different gestures under one id in flight together: one 'appended', one 'conflict'"), async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          const outcomes = await Promise.all([
            consumer.append('render-1', row('race2'), { gestureDigest: A }),
            consumer.append('render-1', row('race2'), { gestureDigest: B }),
          ]);
          expect([...outcomes].sort()).toEqual(['appended', 'conflict']);
          expect((await consumer.consumeAndClear('render-1', 1000)).events).toHaveLength(1);
        });
      });
    });

    describe('per-render isolation', () => {
      it("render A's events don't leak into render B's consume", async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-A');
          await seed('render-B');
          await consumer.append('render-A', row('A-only'));
          const outB = await consumer.consumeAndClear('render-B', 1000);
          expect(outB.events).toEqual([]);
          const outA = await consumer.consumeAndClear('render-A', 1000);
          expect(outA.events.length).toBe(1);
          expect(outA.events.map((e) => e.id)).toEqual(['A-only']);
        });
      });
    });

  });
}

/**
 * Factory for {@link runPendingEventStoreBoundaryConformance}: a store that
 * reads rows back from a serialization exposes a raw write path so the
 * suite can plant a row `append` could never have written.
 */
export interface PendingEventStoreBoundaryFactory {
  readonly create: () => Promise<{
    readonly consumer: PendingEventConsumer;
    readonly seed: (sessionId: string) => void | Promise<void>;
    /** Store `row` as one entry of `sessionId`, bypassing `append` — serialized as the store would any row. */
    readonly writeRawRow: (sessionId: string, row: unknown) => void | Promise<void>;
    /** Remove the stored entry of `sessionId` whose `id` is `id`, bypassing the drain — how an operator clears a planted row. */
    readonly removeRawRow: (sessionId: string, id: string) => void | Promise<void>;
  }>;
  readonly cleanup?: (consumer: PendingEventConsumer) => Promise<void> | void;
}

/**
 * How an adapter meets the drain obligation ("never return a failing row,
 * never drop a well-formed sibling"): a TRANSACTIONAL drain refuses whole
 * and rolls back (`'refuse'`); a DESTRUCTIVE drain — read and clear are one
 * write — quarantines the failing row and delivers the rest (`'quarantine'`).
 */
export type PendingEventStoreBoundaryForm = 'refuse' | 'quarantine';

/**
 * The store-boundary half of the contract (ggui#839), for every adapter
 * that serializes rows (a JSON column, a marshalled item). The in-memory
 * adapter has no such boundary — it holds the typed rows it validated on
 * append — and does not run this suite.
 */
export function runPendingEventStoreBoundaryConformance(
  label: string,
  factory: PendingEventStoreBoundaryFactory,
  form: PendingEventStoreBoundaryForm,
): void {
  async function withStore<T>(
    fn: (helpers: Awaited<ReturnType<PendingEventStoreBoundaryFactory['create']>>) => Promise<T>,
  ): Promise<T> {
    const helpers = await factory.create();
    try {
      return await fn(helpers);
    } finally {
      if (factory.cleanup) await factory.cleanup(helpers.consumer);
    }
  }

  describe(`${label} — store boundary (ggui#839, form: ${form})`, () => {
    if (form === 'refuse') {
      it('a stored row that is not a PendingEvent refuses the drain — refuses it again because nothing was cleared — and once the row is removed, BOTH well-formed siblings are still there', async () => {
        await withStore(async ({ consumer, seed, writeRawRow, removeRawRow }) => {
          await seed('render-1');
          await consumer.append('render-1', row('good-1'));
          await writeRawRow('render-1', { id: 'bad', bogus: true });
          await consumer.append('render-1', row('good-2'));
          await expect(consumer.consumeAndClear('render-1', 1000)).rejects.toMatchObject({
            name: 'PendingEventMalformedError',
            sessionId: 'render-1',
            rowId: 'bad',
          });
          await expect(consumer.consumeAndClear('render-1', 1000)).rejects.toMatchObject({
            name: 'PendingEventMalformedError',
          });
          await removeRawRow('render-1', 'bad');
          const drained = await consumer.consumeAndClear('render-1', 1000);
          expect(drained.events.map((e) => e.id)).toEqual(['good-1', 'good-2']);
        });
      });
    } else {
      it('a stored row that is not a PendingEvent is quarantined — the well-formed siblings on BOTH sides of it are delivered, the failing row never is', async () => {
        await withStore(async ({ consumer, seed, writeRawRow }) => {
          await seed('render-1');
          await consumer.append('render-1', row('good-1'));
          await writeRawRow('render-1', { id: 'bad', bogus: true });
          await consumer.append('render-1', row('good-2'));
          const first = await consumer.consumeAndClear('render-1', 1000);
          expect(first.events.map((e) => e.id)).toEqual(['good-1', 'good-2']);
          const second = await consumer.consumeAndClear('render-1', 1000);
          expect(second.events).toEqual([]);
        });
      });
    }
  });
}
