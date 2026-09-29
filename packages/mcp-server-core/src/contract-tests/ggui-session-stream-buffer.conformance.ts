/**
 * `GguiSessionStreamBuffer` cross-impl conformance suite.
 *
 * The behaviour every implementation of the port holds, whatever it
 * stores in: seq assignment, the three replay policies at record time
 * and at replay time, truncation, `clear`, `getSize`, the recognized
 * reserved channels, and epochs (ggui#1531). Real impls plug in:
 *
 * - `InMemoryGguiSessionStreamBuffer` from
 *   `../in-memory/ggui-session-stream-buffer.test.ts`.
 * - `SqliteGguiSessionStreamBuffer` from
 *   `../sqlite/ggui-session-stream-buffer.test.ts`, on a temp file.
 * - Any other backend plugs in the same way from its own test suite.
 *
 * What differs by design between implementations stays in their own
 * suites: whether a new instance continues a session's counter (a
 * persistent buffer does, over the same storage; an in-memory one
 * cannot), and the epoch's exact format (the port fixes only an opaque
 * string of at most 32 characters).
 */
import { describe, expect, it } from 'vitest';
import type { StreamSpec } from '@ggui-ai/protocol';
import type {
  GguiSessionStreamBuffer,
  GguiSessionStreamBufferOptions,
} from '../ggui-session-stream-buffer.js';

/** How the suite obtains a fresh, empty buffer per test, and releases it. */
export interface GguiSessionStreamBufferConformanceFactory {
  create(
    opts?: GguiSessionStreamBufferOptions,
  ): GguiSessionStreamBuffer | Promise<GguiSessionStreamBuffer>;
  cleanup?(buffer: GguiSessionStreamBuffer): void | Promise<void>;
}

const SESSION = 'sess-1';

/** Spec with mixed replay policies, one of each. */
const MIXED_SPEC: StreamSpec = {
  silent: { schema: { type: 'object' }, replay: 'none' },
  snap: { schema: { type: 'object' }, replay: 'latest' },
  feed: { schema: { type: 'object' }, replay: 'all' },
};

/**
 * Run the conformance suite. `label` prefixes every nested describe so a
 * failure names the implementation.
 */
export function runGguiSessionStreamBufferConformance(
  label: string,
  factory: GguiSessionStreamBufferConformanceFactory,
): void {
  async function withBuffer<T>(
    fn: (buf: GguiSessionStreamBuffer) => Promise<T>,
    opts?: GguiSessionStreamBufferOptions,
  ): Promise<T> {
    const buf = await factory.create(opts);
    try {
      return await fn(buf);
    } finally {
      if (factory.cleanup) await factory.cleanup(buf);
    }
  }

  describe(`${label} — sequencing`, () => {
    it('assigns monotonic gap-free seq per session starting at 1', () =>
      withBuffer(async (buf) => {
        const r1 = await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { n: 1 } }, MIXED_SPEC);
        const r2 = await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { n: 2 } }, MIXED_SPEC);
        const r3 = await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'x' } }, MIXED_SPEC);
        expect(r1.envelope.seq).toBe(1);
        expect(r2.envelope.seq).toBe(2);
        expect(r3.envelope.seq).toBe(3);
        expect(await buf.currentSeq(SESSION)).toBe(3);
      }));

    it('seq is session-scoped — concurrent sessions advance independently', () =>
      withBuffer(async (buf) => {
        const a1 = await buf.record({ sessionId: 'A', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        const b1 = await buf.record({ sessionId: 'B', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        const a2 = await buf.record({ sessionId: 'A', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        expect(a1.envelope.seq).toBe(1);
        expect(b1.envelope.seq).toBe(1);
        expect(a2.envelope.seq).toBe(2);
        expect(await buf.currentSeq('A')).toBe(2);
        expect(await buf.currentSeq('B')).toBe(1);
      }));

    it('assigns seq to "none" channels too (cursor stays contiguous for fan-out) even though nothing is buffered', () =>
      withBuffer(async (buf) => {
        const { envelope, buffered } = await buf.record(
          { sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} },
          MIXED_SPEC,
        );
        expect(envelope.seq).toBe(1);
        expect(buffered).toBe(false);
        expect(await buf.currentSeq(SESSION)).toBe(1);
      }));

    it('applies DEFAULT_STREAM_REPLAY_POLICY (none) when spec is absent', () =>
      withBuffer(async (buf) => {
        const r = await buf.record({ sessionId: SESSION, channel: 'anything', mode: 'append', payload: {} }, undefined);
        expect(r.envelope.seq).toBe(1);
        expect(r.buffered).toBe(false);
      }));

    it('currentSeq is 0 before the first record', () =>
      withBuffer(async (buf) => {
        expect(await buf.currentSeq('never-seen')).toBe(0);
      }));

    it('stamps the envelope the producer fans out: its fields, its seq, and a schema version', () =>
      withBuffer(async (buf) => {
        const { envelope } = await buf.record(
          { sessionId: SESSION, channel: 'feed', mode: 'append', payload: { nested: { a: [1, 'b', null] } }, complete: true },
          MIXED_SPEC,
        );
        expect(envelope).toMatchObject({
          sessionId: SESSION,
          seq: 1,
          channel: 'feed',
          mode: 'append',
          payload: { nested: { a: [1, 'b', null] } },
          complete: true,
        });
        expect(typeof envelope.schemaVersion).toBe('string');
        // The replayed copy is the same envelope, byte for byte.
        const replayed = (await buf.replay(SESSION, 0, MIXED_SPEC)).envelopes[0];
        expect(replayed).toEqual(envelope);
      }));
  });

  describe(`${label} — record policies`, () => {
    it('"none" policy stores nothing', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: { ignore: true } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: { also: true } }, MIXED_SPEC);
        expect(await buf.getSize()).toBe(0);
      }));

    it('"latest" policy replaces prior latest for the same channel, not for different channels', () =>
      withBuffer(async (buf) => {
        const spec: StreamSpec = {
          snap1: { schema: { type: 'object' }, replay: 'latest' },
          snap2: { schema: { type: 'object' }, replay: 'latest' },
        };
        await buf.record({ sessionId: SESSION, channel: 'snap1', mode: 'replace', payload: { v: 1 } }, spec);
        await buf.record({ sessionId: SESSION, channel: 'snap2', mode: 'replace', payload: { v: 'a' } }, spec);
        await buf.record({ sessionId: SESSION, channel: 'snap1', mode: 'replace', payload: { v: 2 } }, spec);
        expect(await buf.getSize()).toBe(2);
        const r = await buf.replay(SESSION, 0, spec);
        expect(r.envelopes).toHaveLength(2);
        const snap1 = r.envelopes.find((e) => e.channel === 'snap1');
        const snap2 = r.envelopes.find((e) => e.channel === 'snap2');
        expect(snap1?.payload).toEqual({ v: 2 });
        expect(snap1?.seq).toBe(3);
        expect(snap2?.payload).toEqual({ v: 'a' });
        expect(snap2?.seq).toBe(2);
      }));

    it('"all" policy appends to a FIFO ring capped by maxPerSession', () =>
      withBuffer(
        async (buf) => {
          const spec: StreamSpec = { feed: { schema: { type: 'object' }, replay: 'all' } };
          for (let i = 1; i <= 5; i++) {
            await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i } }, spec);
          }
          const r = await buf.replay(SESSION, 0, spec);
          expect(r.envelopes.map((e) => e.seq)).toEqual([3, 4, 5]);
          expect(r.truncated).toBe(true);
        },
        { maxPerSession: 3 },
      ));

    it('the cap is per session: one session filling its ring evicts nothing of another', () =>
      withBuffer(
        async (buf) => {
          const spec: StreamSpec = { feed: { schema: { type: 'object' }, replay: 'all' } };
          await buf.record({ sessionId: 'B', channel: 'feed', mode: 'append', payload: { b: 1 } }, spec);
          for (let i = 1; i <= 4; i++) {
            await buf.record({ sessionId: 'A', channel: 'feed', mode: 'append', payload: { i } }, spec);
          }
          // The recording session holds exactly its cap, oldest evicted...
          const a = await buf.replay('A', 0, spec);
          expect(a.envelopes.map((e) => e.payload)).toEqual([{ i: 3 }, { i: 4 }]);
          expect(a.truncated).toBe(true);
          // ...and the other session keeps everything it had.
          expect((await buf.replay('B', 0, spec)).envelopes.map((e) => e.payload)).toEqual([{ b: 1 }]);
          expect((await buf.replay('B', 0, spec)).truncated).toBe(false);
          expect(await buf.getSize()).toBe(3);
        },
        { maxPerSession: 2 },
      ));

    it('a "latest" slot is per session: two sessions on one channel each keep their own', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: 'A', channel: 'snap', mode: 'replace', payload: { v: 'a1' } }, MIXED_SPEC);
        await buf.record({ sessionId: 'B', channel: 'snap', mode: 'replace', payload: { v: 'b1' } }, MIXED_SPEC);
        await buf.record({ sessionId: 'A', channel: 'snap', mode: 'replace', payload: { v: 'a2' } }, MIXED_SPEC);
        expect((await buf.replay('A', 0, MIXED_SPEC)).envelopes.map((e) => e.payload)).toEqual([{ v: 'a2' }]);
        expect((await buf.replay('B', 0, MIXED_SPEC)).envelopes.map((e) => e.payload)).toEqual([{ v: 'b1' }]);
      }));

    it('records of mixed policies coexist without interference', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 1 } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 2 } }, MIXED_SPEC);
        expect(await buf.getSize()).toBe(3);
      }));
  });

  describe(`${label} — replay`, () => {
    it('returns empty envelopes + streamSeq when fromSeq is undefined (fresh subscribe)', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, MIXED_SPEC);
        const r = await buf.replay(SESSION, undefined, MIXED_SPEC);
        expect(r.envelopes).toEqual([]);
        expect(r.truncated).toBe(false);
        expect(r.streamSeq).toBe(2);
      }));

    it('returns only envelopes with seq > fromSeq', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 3 } }, MIXED_SPEC);
        const r = await buf.replay(SESSION, 1, MIXED_SPEC);
        expect(r.envelopes.map((e) => e.seq)).toEqual([2, 3]);
        expect(r.truncated).toBe(false);
        expect(r.streamSeq).toBe(3);
      }));

    it('"latest" channel replays at most one envelope — the stored latest', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'a' } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'b' } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'c' } }, MIXED_SPEC);
        const r = await buf.replay(SESSION, 0, MIXED_SPEC);
        expect(r.envelopes).toHaveLength(1);
        expect(r.envelopes[0]?.payload).toEqual({ v: 'c' });
        expect(r.envelopes[0]?.seq).toBe(3);
      }));

    it('"latest" channel replays nothing when latest.seq <= fromSeq', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'old' } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        const r = await buf.replay(SESSION, 2, MIXED_SPEC);
        expect(r.envelopes).toEqual([]);
      }));

    it('"none" channel contributes nothing even when receiver requests full replay', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
        const r = await buf.replay(SESSION, 0, MIXED_SPEC);
        expect(r.envelopes).toEqual([]);
        expect(r.streamSeq).toBe(2);
      }));

    it('mixed policies replay correctly together and in seq order', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'a' } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'b' } }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 3 } }, MIXED_SPEC);
        const r = await buf.replay(SESSION, 0, MIXED_SPEC);
        expect(r.envelopes.map((e) => ({ seq: e.seq, channel: e.channel }))).toEqual([
          { seq: 1, channel: 'feed' },
          { seq: 4, channel: 'feed' },
          { seq: 5, channel: 'snap' },
          { seq: 6, channel: 'feed' },
        ]);
        expect(r.truncated).toBe(false);
      }));

    it('flags truncated=true when fromSeq is older than the oldest retained seq for an "all" channel', () =>
      withBuffer(
        async (buf) => {
          const spec: StreamSpec = { feed: { schema: { type: 'object' }, replay: 'all' } };
          await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, spec);
          await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, spec);
          await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 3 } }, spec);
          const r = await buf.replay(SESSION, 0, spec);
          expect(r.truncated).toBe(true);
          expect(r.envelopes.map((e) => e.seq)).toEqual([2, 3]);
          const r2 = await buf.replay(SESSION, 2, spec);
          expect(r2.truncated).toBe(false);
          expect(r2.envelopes.map((e) => e.seq)).toEqual([3]);
        },
        { maxPerSession: 2 },
      ));

    it('returns streamSeq=0 for a session with no records', () =>
      withBuffer(async (buf) => {
        const r = await buf.replay('never-seen', 0, MIXED_SPEC);
        expect(r.envelopes).toEqual([]);
        expect(r.truncated).toBe(false);
        expect(r.streamSeq).toBe(0);
      }));

    it('returns nothing when spec is absent — default policy (none) everywhere', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
        const r = await buf.replay(SESSION, 0, undefined);
        expect(r.envelopes).toEqual([]);
        expect(r.streamSeq).toBe(1);
      }));

    it('a known reserved channel is stored and replayed whatever the spec declares (_ggui:preview)', () =>
      withBuffer(async (buf) => {
        const rec = await buf.record(
          { sessionId: SESSION, channel: '_ggui:preview', mode: 'replace', payload: { stage: 'assembling' } },
          undefined,
        );
        expect(rec.buffered).toBe(true);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
        const r = await buf.replay(SESSION, 0, MIXED_SPEC);
        expect(r.envelopes.map((e) => e.channel)).toEqual(['_ggui:preview', 'feed']);
        // A typo of a reserved name is an ordinary undeclared channel: never stored.
        const typo = await buf.record(
          { sessionId: 'sess-typo', channel: '_ggui:preveiw', mode: 'replace', payload: {} },
          undefined,
        );
        expect(typo.buffered).toBe(false);
      }));
  });

  describe(`${label} — clear`, () => {
    it('drops all state for a session; other sessions untouched', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: 'A', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        await buf.record({ sessionId: 'A', channel: 'snap', mode: 'replace', payload: {} }, MIXED_SPEC);
        await buf.record({ sessionId: 'B', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        await buf.clear('A');
        expect(await buf.currentSeq('A')).toBe(0);
        expect((await buf.replay('A', 0, MIXED_SPEC)).envelopes).toEqual([]);
        expect(await buf.currentSeq('B')).toBe(1);
        expect((await buf.replay('B', 0, MIXED_SPEC)).envelopes).toHaveLength(1);
      }));

    it('is idempotent', () =>
      withBuffer(async (buf) => {
        await buf.clear('nope');
        await buf.clear('nope');
        expect(await buf.currentSeq('nope')).toBe(0);
      }));

    it('after clear, new records start seq at 1 again', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        await buf.clear(SESSION);
        const r = await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        expect(r.envelope.seq).toBe(1);
      }));
  });

  describe(`${label} — getSize`, () => {
    it('counts buffered entries across sessions + both storage forms', () =>
      withBuffer(async (buf) => {
        await buf.record({ sessionId: 'A', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        await buf.record({ sessionId: 'A', channel: 'snap', mode: 'replace', payload: {} }, MIXED_SPEC);
        await buf.record({ sessionId: 'A', channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
        await buf.record({ sessionId: 'B', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
        expect(await buf.getSize()).toBe(3);
      }));
  });

  describe(`${label} — epochs (ggui#1531)`, () => {
    const feed = (n: number) => ({ sessionId: SESSION, channel: 'feed', mode: 'append' as const, payload: { n } });

    it('has no epoch before the first record, then stamps one epoch on every record, the replay and the cursor', () =>
      withBuffer(async (buf) => {
        if (!buf.currentCursor) throw new Error(`${label} implements no currentCursor`);
        expect(await buf.currentCursor(SESSION)).toEqual({ seq: 0 });
        const r1 = await buf.record(feed(1), MIXED_SPEC);
        const r2 = await buf.record(feed(2), MIXED_SPEC);
        const epoch = r1.envelope.streamEpoch;
        expect(typeof epoch).toBe('string');
        expect(epoch?.length).toBeGreaterThan(0);
        expect(epoch?.length).toBeLessThanOrEqual(32);
        expect(r2.envelope.streamEpoch).toBe(epoch);
        expect(await buf.currentCursor(SESSION)).toEqual({ seq: 2, epoch });
        const replay = await buf.replay(SESSION, 0, MIXED_SPEC);
        expect(replay).toMatchObject({ streamSeq: 2, streamEpoch: epoch });
        expect(replay.envelopes.map((e) => e.streamEpoch)).toEqual([epoch, epoch]);
      }));

    it('a cleared counter restarts in a new epoch and replays nothing of the old generation', () =>
      withBuffer(async (buf) => {
        const before = (await buf.record(feed(1), MIXED_SPEC)).envelope;
        await buf.record(feed(2), MIXED_SPEC);
        await buf.clear(SESSION);
        const after = (await buf.record(feed(3), MIXED_SPEC)).envelope;
        expect(after.seq).toBe(1);
        expect(after.streamEpoch).not.toBe(before.streamEpoch);
        const replay = await buf.replay(SESSION, 0, MIXED_SPEC);
        expect(replay.envelopes.map((e) => [e.seq, e.streamEpoch])).toEqual([[1, after.streamEpoch]]);
      }));

    it('sessions hold their own epochs', () =>
      withBuffer(async (buf) => {
        const a = (await buf.record(feed(1), MIXED_SPEC)).envelope.streamEpoch;
        const b = (await buf.record({ ...feed(1), sessionId: 'sess-2' }, MIXED_SPEC)).envelope.streamEpoch;
        expect(a).not.toBe(b);
      }));
  });
}
