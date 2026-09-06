/**
 * `PendingEventConsumer` cross-impl conformance suite.
 *
 * Locks in the contract every consumer implementation must satisfy:
 *
 *   - `consumeAndClear` atomicity — events appear once, get cleared,
 *     return on the first call only.
 *   - `append` ordering — multiple events appended in order surface
 *     in FIFO order on the next `consumeAndClear`.
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
