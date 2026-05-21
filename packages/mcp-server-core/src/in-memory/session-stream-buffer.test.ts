/**
 * InMemorySessionStreamBuffer — focused unit tests.
 *
 * Every test exercises a single normative behavior of the buffer
 * primitive. End-to-end replay semantics over the OSS `/ws` channel
 * live in `packages/mcp-server/src/session-channel.test.ts` — the
 * tests here prove the primitive behaves correctly in isolation.
 */
import { describe, expect, it } from 'vitest';
import type { StreamSpec } from '@ggui-ai/protocol';
import { InMemorySessionStreamBuffer } from './session-stream-buffer.js';

const SESSION = 'sess-1';

/** Spec with mixed replay policies, one of each. */
const MIXED_SPEC: StreamSpec = {
  silent: { schema: { type: 'object' }, replay: 'none' },
  snap: { schema: { type: 'object' }, replay: 'latest' },
  feed: { schema: { type: 'object' }, replay: 'all' },
};

describe('InMemorySessionStreamBuffer — sequencing', () => {
  it('assigns monotonic gap-free seq per session starting at 1', async () => {
    const buf = new InMemorySessionStreamBuffer();
    const r1 = await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { n: 1 } }, MIXED_SPEC);
    const r2 = await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { n: 2 } }, MIXED_SPEC);
    const r3 = await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'x' } }, MIXED_SPEC);
    expect(r1.envelope.seq).toBe(1);
    expect(r2.envelope.seq).toBe(2);
    expect(r3.envelope.seq).toBe(3);
    expect(await buf.currentSeq(SESSION)).toBe(3);
  });

  it('seq is session-scoped — concurrent sessions advance independently', async () => {
    const buf = new InMemorySessionStreamBuffer();
    const a1 = await buf.record({ sessionId: 'A', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
    const b1 = await buf.record({ sessionId: 'B', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
    const a2 = await buf.record({ sessionId: 'A', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
    expect(a1.envelope.seq).toBe(1);
    expect(b1.envelope.seq).toBe(1);
    expect(a2.envelope.seq).toBe(2);
    expect(await buf.currentSeq('A')).toBe(2);
    expect(await buf.currentSeq('B')).toBe(1);
  });

  it('assigns seq to "none" channels too (cursor stays contiguous for fan-out) even though nothing is buffered', async () => {
    const buf = new InMemorySessionStreamBuffer();
    const { envelope, buffered } = await buf.record(
      { sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} },
      MIXED_SPEC,
    );
    expect(envelope.seq).toBe(1);
    expect(buffered).toBe(false);
    // currentSeq still 1 — seq cursor is independent of buffering.
    expect(await buf.currentSeq(SESSION)).toBe(1);
  });

  it('applies DEFAULT_STREAM_REPLAY_POLICY (none) when spec is absent', async () => {
    const buf = new InMemorySessionStreamBuffer();
    const r = await buf.record(
      { sessionId: SESSION, channel: 'anything', mode: 'append', payload: {} },
      undefined,
    );
    expect(r.envelope.seq).toBe(1);
    expect(r.buffered).toBe(false);
  });

  it('currentSeq is 0 before the first record', async () => {
    const buf = new InMemorySessionStreamBuffer();
    expect(await buf.currentSeq('never-seen')).toBe(0);
  });
});

describe('InMemorySessionStreamBuffer — record policies', () => {
  it('"none" policy stores nothing', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: { ignore: true } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: { also: true } }, MIXED_SPEC);
    expect(await buf.getSize()).toBe(0);
  });

  it('"latest" policy replaces prior latest for the same channel, not for different channels', async () => {
    const spec: StreamSpec = {
      snap1: { schema: { type: 'object' }, replay: 'latest' },
      snap2: { schema: { type: 'object' }, replay: 'latest' },
    };
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'snap1', mode: 'replace', payload: { v: 1 } }, spec);
    await buf.record({ sessionId: SESSION, channel: 'snap2', mode: 'replace', payload: { v: 'a' } }, spec);
    await buf.record({ sessionId: SESSION, channel: 'snap1', mode: 'replace', payload: { v: 2 } }, spec);

    // One slot per channel, so 2 entries total.
    expect(await buf.getSize()).toBe(2);
    const r = await buf.replay(SESSION, 0, spec);
    expect(r.envelopes).toHaveLength(2);
    // snap1 latest has seq 3, snap2 latest has seq 2.
    const snap1 = r.envelopes.find((e) => e.channel === 'snap1');
    const snap2 = r.envelopes.find((e) => e.channel === 'snap2');
    expect(snap1?.payload).toEqual({ v: 2 });
    expect(snap1?.seq).toBe(3);
    expect(snap2?.payload).toEqual({ v: 'a' });
    expect(snap2?.seq).toBe(2);
  });

  it('"all" policy appends to a FIFO ring capped by maxPerSession', async () => {
    const buf = new InMemorySessionStreamBuffer({ maxPerSession: 3 });
    const spec: StreamSpec = {
      feed: { schema: { type: 'object' }, replay: 'all' },
    };
    for (let i = 1; i <= 5; i++) {
      await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i } }, spec);
    }
    // Seq 1,2 evicted; 3,4,5 retained.
    const r = await buf.replay(SESSION, 0, spec);
    expect(r.envelopes.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(r.truncated).toBe(true); // fromSeq=0 is older than evicted seq 1
  });

  it('records of mixed policies coexist without interference', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 1 } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 2 } }, MIXED_SPEC);
    // silent=0 stored, feed=2 in ring, snap=1 in latest-slot
    expect(await buf.getSize()).toBe(3);
  });
});

describe('InMemorySessionStreamBuffer — replay', () => {
  it('returns empty envelopes + streamSeq when fromSeq is undefined (fresh subscribe)', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, MIXED_SPEC);

    const r = await buf.replay(SESSION, undefined, MIXED_SPEC);
    expect(r.envelopes).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.streamSeq).toBe(2);
  });

  it('returns only envelopes with seq > fromSeq', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 3 } }, MIXED_SPEC);

    const r = await buf.replay(SESSION, 1, MIXED_SPEC);
    expect(r.envelopes.map((e) => e.seq)).toEqual([2, 3]);
    expect(r.truncated).toBe(false);
    expect(r.streamSeq).toBe(3);
  });

  it('"latest" channel replays at most one envelope — the stored latest', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'a' } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'b' } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'c' } }, MIXED_SPEC);

    const r = await buf.replay(SESSION, 0, MIXED_SPEC);
    expect(r.envelopes).toHaveLength(1);
    expect(r.envelopes[0].payload).toEqual({ v: 'c' });
    expect(r.envelopes[0].seq).toBe(3);
  });

  it('"latest" channel replays nothing when latest.seq <= fromSeq', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'old' } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);

    // Subscriber already saw seq 2 — snap's latest is at seq 1 which is behind.
    const r = await buf.replay(SESSION, 2, MIXED_SPEC);
    // Nothing to replay: snap's latest seq is 1 < fromSeq(2); feed's only
    // envelope is at seq 2, also <= fromSeq.
    expect(r.envelopes).toEqual([]);
  });

  it('"none" channel contributes nothing even when receiver requests full replay', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
    const r = await buf.replay(SESSION, 0, MIXED_SPEC);
    expect(r.envelopes).toEqual([]);
    expect(r.streamSeq).toBe(2); // seq still advances
  });

  it('mixed policies replay correctly together and in seq order', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'a' } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'b' } }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 3 } }, MIXED_SPEC);

    // fromSeq=0 → everything past the cutoff per-policy.
    const r = await buf.replay(SESSION, 0, MIXED_SPEC);
    // feed: all three (seq 1, 4, 6). snap: latest (seq 5). silent: nothing.
    expect(r.envelopes.map((e) => ({ seq: e.seq, channel: e.channel }))).toEqual([
      { seq: 1, channel: 'feed' },
      { seq: 4, channel: 'feed' },
      { seq: 5, channel: 'snap' },
      { seq: 6, channel: 'feed' },
    ]);
    expect(r.truncated).toBe(false);
  });

  it('flags truncated=true when fromSeq is older than the oldest retained seq for an "all" channel', async () => {
    const buf = new InMemorySessionStreamBuffer({ maxPerSession: 2 });
    const spec: StreamSpec = {
      feed: { schema: { type: 'object' }, replay: 'all' },
    };
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, spec);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 2 } }, spec);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 3 } }, spec);
    // Seq 1 evicted.

    // fromSeq=0 subscriber missed seq 1, which is gone.
    const r = await buf.replay(SESSION, 0, spec);
    expect(r.truncated).toBe(true);
    expect(r.envelopes.map((e) => e.seq)).toEqual([2, 3]);

    // fromSeq=2 — subscriber has already seen seq 2; the missing
    // history is only seq 1, which they explicitly DON'T want. Not
    // truncated from THIS subscriber's view.
    const r2 = await buf.replay(SESSION, 2, spec);
    expect(r2.truncated).toBe(false);
    expect(r2.envelopes.map((e) => e.seq)).toEqual([3]);
  });

  it('returns streamSeq=0 for a session with no records', async () => {
    const buf = new InMemorySessionStreamBuffer();
    const r = await buf.replay('never-seen', 0, MIXED_SPEC);
    expect(r.envelopes).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.streamSeq).toBe(0);
  });

  it('returns nothing when spec is absent — default policy (none) everywhere', async () => {
    const buf = new InMemorySessionStreamBuffer();
    // Record with a spec so something gets stored.
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: { i: 1 } }, MIXED_SPEC);
    // Replay without spec — buffer has no live contract to honor.
    const r = await buf.replay(SESSION, 0, undefined);
    expect(r.envelopes).toEqual([]);
    expect(r.streamSeq).toBe(1);
  });
});

describe('InMemorySessionStreamBuffer — clear', () => {
  it('drops all state for a session; other sessions untouched', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: 'A', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
    await buf.record({ sessionId: 'A', channel: 'snap', mode: 'replace', payload: {} }, MIXED_SPEC);
    await buf.record({ sessionId: 'B', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);

    await buf.clear('A');
    expect(await buf.currentSeq('A')).toBe(0);
    expect((await buf.replay('A', 0, MIXED_SPEC)).envelopes).toEqual([]);
    expect(await buf.currentSeq('B')).toBe(1);
    expect((await buf.replay('B', 0, MIXED_SPEC)).envelopes).toHaveLength(1);
  });

  it('is idempotent', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.clear('nope');
    await buf.clear('nope');
    expect(await buf.currentSeq('nope')).toBe(0);
  });

  it('after clear, new records start seq at 1 again', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
    await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
    await buf.clear(SESSION);
    const r = await buf.record({ sessionId: SESSION, channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
    expect(r.envelope.seq).toBe(1);
  });
});

describe('InMemorySessionStreamBuffer — getSize', () => {
  it('counts buffered entries across sessions + both storage forms', async () => {
    const buf = new InMemorySessionStreamBuffer();
    await buf.record({ sessionId: 'A', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
    await buf.record({ sessionId: 'A', channel: 'snap', mode: 'replace', payload: {} }, MIXED_SPEC);
    await buf.record({ sessionId: 'A', channel: 'silent', mode: 'append', payload: {} }, MIXED_SPEC);
    await buf.record({ sessionId: 'B', channel: 'feed', mode: 'append', payload: {} }, MIXED_SPEC);
    // A: 1 ring + 1 latest = 2; silent not counted. B: 1 ring.
    expect(await buf.getSize()).toBe(3);
  });
});

describe('InMemorySessionStreamBuffer — constructor guards', () => {
  it('rejects maxPerSession < 1', () => {
    expect(() => new InMemorySessionStreamBuffer({ maxPerSession: 0 })).toThrow();
    expect(() => new InMemorySessionStreamBuffer({ maxPerSession: -5 })).toThrow();
  });
});
