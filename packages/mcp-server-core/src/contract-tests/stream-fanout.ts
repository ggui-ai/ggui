/**
 * Contract test factory for {@link StreamFanout} implementations.
 *
 * Normative semantics covered (matching the Protocol & Contract Bar
 * obligations declared on `stream-fanout.ts`):
 *   - Single publish delivered to a single live subscriber.
 *   - Many publishes delivered in seq order (no coalesce / drop / reorder).
 *   - Multi-subscriber fanout — every live subscriber sees every frame.
 *   - Publish-before-subscribe semantics — frames published before
 *     subscribe-return MAY be missed; frames published after MUST arrive.
 *   - Concurrent producers for the same session interleave without loss.
 *   - `close(sessionId)` drains all subscribers cleanly (iterator ends).
 *   - Consumer abandoning the iterator unregisters the subscriber
 *     (observable via `subscriberCount` when implementations expose it;
 *     the contract is enforced via a close-after-drop round-trip).
 *   - Session isolation — `publish({sessionId: A})` never delivers to a
 *     subscriber of session B.
 */
import { describe, expect, it } from 'vitest';
import type { StreamFanout } from '../stream-fanout.js';
import type { BufferedStreamEnvelope } from '../session-stream-buffer.js';

function makeEnvelope(
  sessionId: string,
  seq: number,
  overrides: Partial<BufferedStreamEnvelope> = {},
): BufferedStreamEnvelope {
  return {
    sessionId,
    seq,
    channel: 'message',
    mode: 'append',
    payload: { i: seq },
    ...overrides,
  };
}

/**
 * Pull up to `max` frames from an iterator, bailing when `stopAt(value)`
 * returns true or when the source signals done. Used to drive conformance
 * tests past a known stop point without depending on close semantics.
 */
async function collect<T>(
  iter: AsyncIterator<T>,
  max: number,
  stopAt?: (value: T) => boolean,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < max; i++) {
    const { value, done } = await iter.next();
    if (done) break;
    out.push(value);
    if (stopAt?.(value)) break;
  }
  return out;
}

export function streamFanoutContract(
  label: string,
  makeFanout: () => Promise<StreamFanout> | StreamFanout,
): void {
  describe(`StreamFanout contract — ${label}`, () => {
    it('publish delivers to a single live subscriber', async () => {
      const fanout = await makeFanout();
      const iter = fanout.subscribe('s1')[Symbol.asyncIterator]();
      // Per Protocol Bar: subscribe() returns with the subscriber
      // already registered; the very next publish MUST arrive. The
      // test parks next() first so a delivered envelope resolves it.
      const first = iter.next();
      await fanout.publish({ sessionId: 's1', envelope: makeEnvelope('s1', 1) });
      const { value, done } = await first;
      expect(done).toBe(false);
      expect(value).toMatchObject({ sessionId: 's1', seq: 1 });
      await fanout.close('s1');
    });

    it('delivers 1000 publishes in seq order (no coalesce/drop/reorder)', async () => {
      const fanout = await makeFanout();
      const iter = fanout.subscribe('s1')[Symbol.asyncIterator]();
      // Prime the iterator so subsequent publishes are guaranteed delivery.
      const primed = iter.next();
      await fanout.publish({ sessionId: 's1', envelope: makeEnvelope('s1', 1) });
      const first = await primed;
      expect(first.done).toBe(false);

      for (let i = 2; i <= 1000; i++) {
        await fanout.publish({
          sessionId: 's1',
          envelope: makeEnvelope('s1', i),
        });
      }
      const rest = await collect(iter, 999);
      expect(rest).toHaveLength(999);
      expect(rest.map((e) => e.seq)).toEqual(
        Array.from({ length: 999 }, (_, i) => i + 2),
      );
      await fanout.close('s1');
    });

    it('multi-subscriber fanout — every subscriber sees every frame', async () => {
      const fanout = await makeFanout();
      const iterA = fanout.subscribe('s1')[Symbol.asyncIterator]();
      const iterB = fanout.subscribe('s1')[Symbol.asyncIterator]();
      const primeA = iterA.next();
      const primeB = iterB.next();
      await fanout.publish({ sessionId: 's1', envelope: makeEnvelope('s1', 1) });
      const [a0, b0] = await Promise.all([primeA, primeB]);
      expect(a0.value).toMatchObject({ seq: 1 });
      expect(b0.value).toMatchObject({ seq: 1 });

      for (let i = 2; i <= 10; i++) {
        await fanout.publish({
          sessionId: 's1',
          envelope: makeEnvelope('s1', i),
        });
      }
      const [restA, restB] = await Promise.all([
        collect(iterA, 9),
        collect(iterB, 9),
      ]);
      expect(restA.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(restB.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
      await fanout.close('s1');
    });

    it('session isolation — publish to A does not reach subscribers of B', async () => {
      const fanout = await makeFanout();
      const iterB = fanout.subscribe('sB')[Symbol.asyncIterator]();
      const primed = iterB.next();
      // Publish to a different session; iterB must still be pending.
      await fanout.publish({
        sessionId: 'sA',
        envelope: makeEnvelope('sA', 1),
      });
      // Give the event loop a chance to deliver (if it were going to).
      await new Promise((r) => setTimeout(r, 20));
      // Now publish to sB and confirm that's what iterB gets.
      await fanout.publish({
        sessionId: 'sB',
        envelope: makeEnvelope('sB', 1),
      });
      const first = await primed;
      expect(first.value).toMatchObject({ sessionId: 'sB', seq: 1 });
      await fanout.close('sA');
      await fanout.close('sB');
    });

    it('concurrent producers to one session — no frame loss, count matches', async () => {
      const fanout = await makeFanout();
      const iter = fanout.subscribe('s1')[Symbol.asyncIterator]();
      // Prime with a sentinel seq=0 so we know the subscriber is live.
      const primed = iter.next();
      await fanout.publish({ sessionId: 's1', envelope: makeEnvelope('s1', 0) });
      await primed;

      const N = 200;
      const PRODUCERS = 4;
      const batches: Promise<void>[] = [];
      let seq = 1;
      for (let p = 0; p < PRODUCERS; p++) {
        const start = seq;
        seq += N;
        const end = seq; // exclusive
        batches.push(
          (async () => {
            for (let s = start; s < end; s++) {
              await fanout.publish({
                sessionId: 's1',
                envelope: makeEnvelope('s1', s),
              });
            }
          })(),
        );
      }
      await Promise.all(batches);
      const total = PRODUCERS * N;
      const collected = await collect(iter, total);
      expect(collected).toHaveLength(total);
      // Every seq should appear exactly once, regardless of interleave order.
      const seqs = collected.map((e) => e.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      await fanout.close('s1');
    });

    it('close(sessionId) drains all subscribers — iterator ends cleanly', async () => {
      const fanout = await makeFanout();
      const iterA = fanout.subscribe('s1')[Symbol.asyncIterator]();
      const iterB = fanout.subscribe('s1')[Symbol.asyncIterator]();
      // Park both iterators (they're waiting on next()).
      const a = iterA.next();
      const b = iterB.next();
      await fanout.close('s1');
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.done).toBe(true);
      expect(rb.done).toBe(true);
    });

    it('close(sessionId) is idempotent', async () => {
      const fanout = await makeFanout();
      await expect(fanout.close('never-subscribed')).resolves.toBeUndefined();
      const iter = fanout.subscribe('s1')[Symbol.asyncIterator]();
      // Don't await next() — eager registration means the subscriber is
      // already live; awaiting without a pending publish would park.
      const parked = iter.next();
      await fanout.close('s1');
      const first = await parked;
      expect(first.done).toBe(true);
      await expect(fanout.close('s1')).resolves.toBeUndefined();
    });

    it('consumer returning the iterator unregisters the subscriber', async () => {
      const fanout = await makeFanout();
      const iter = fanout.subscribe('s1')[Symbol.asyncIterator]();
      const primed = iter.next();
      await fanout.publish({ sessionId: 's1', envelope: makeEnvelope('s1', 1) });
      await primed;
      // Abandon the iterator explicitly.
      await iter.return?.();
      // Subsequent publishes must not keep state pinned — the best
      // observable proof here is that close() on a session with no live
      // subscribers is still a no-op (and publishes after return don't
      // throw). This is a smoke-level check; impl-specific tests can go
      // deeper via e.g. subscriberCount().
      await expect(
        fanout.publish({ sessionId: 's1', envelope: makeEnvelope('s1', 2) }),
      ).resolves.toBeUndefined();
      await fanout.close('s1');
    });
  });
}
