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
 * Same factory + cleanup pattern as `render-store.conformance.ts`.
 *
 * Seed semantics: PendingEventConsumer is a per-render buffer; every
 * test needs a render to be present in the consumer's bookkeeping
 * before consume/append can succeed. Real impls expose this via
 * `markCreated(renderId, ttlMs?)` (in-memory + sqlite) or a parallel
 * DDB row write (cloud). The factory's `seed(renderId)` callback
 * wraps whichever path the impl exposes.
 */

import { describe, expect, it } from 'vitest';
import type { PendingEventConsumer } from '../pending-event-consumer.js';

export interface PendingEventConsumerConformanceFactory {
  readonly create: () => Promise<{
    readonly consumer: PendingEventConsumer;
    /** Register `renderId` so subsequent consume/append succeeds. */
    readonly seed: (renderId: string) => void | Promise<void>;
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

    describe('append + consumeAndClear (FIFO)', () => {
      it('surfaces appended events in FIFO order on next consume', async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          await consumer.append('render-1', { kind: 'first', n: 1 });
          await consumer.append('render-1', { kind: 'second', n: 2 });
          await consumer.append('render-1', { kind: 'third', n: 3 });
          const out = await consumer.consumeAndClear('render-1', 1000);
          expect(out.events.length).toBe(3);
          expect(out.events.map((e) => (e as { kind: string }).kind)).toEqual([
            'first',
            'second',
            'third',
          ]);
        });
      });

      it('clears the buffer — second consume returns empty', async () => {
        await withConsumer(async ({ consumer, seed }) => {
          await seed('render-1');
          await consumer.append('render-1', { kind: 'a' });
          const first = await consumer.consumeAndClear('render-1', 1000);
          expect(first.events.length).toBe(1);
          const second = await consumer.consumeAndClear('render-1', 1000);
          expect(second.events).toEqual([]);
        });
      });

      it('throws PendingPipeNotFoundError on append to unseeded render', async () => {
        await withConsumer(async ({ consumer }) => {
          try {
            await consumer.append('never-seeded', { kind: 'lost' });
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
          await consumer.append('render-A', { kind: 'A-only' });
          const outB = await consumer.consumeAndClear('render-B', 1000);
          expect(outB.events).toEqual([]);
          const outA = await consumer.consumeAndClear('render-A', 1000);
          expect(outA.events.length).toBe(1);
          expect((outA.events[0] as { kind: string }).kind).toBe('A-only');
        });
      });
    });

  });
}
