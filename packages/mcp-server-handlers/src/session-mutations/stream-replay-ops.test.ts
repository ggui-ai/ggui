/**
 * Pure replay-ops — every policy branch + every replay rule.
 *
 * Mirrors the coverage of `InMemorySessionStreamBuffer`'s suite in
 * `@ggui-ai/mcp-server-core`, just on the stateless functions that drive
 * both OSS and hosted implementations from a single source of truth.
 *
 * The pure ops are the contract; any storage adapter (in-memory ring,
 * DDB-backed Session row) MUST produce the same outcomes when threaded
 * through `applyRecordOp` + `replayFromBufferOp`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { StreamSpec } from '@ggui-ai/protocol';
import {
  applyRecordOp,
  replayFromBufferOp,
  normalizeBufferState,
  runSequencedRecord,
  ReplayConflictError,
  ReplayMaxRetriesExceededError,
  ReplaySessionNotFoundError,
  EMPTY_BUFFER_STATE,
  DEFAULT_REPLAY_MAX_PER_SESSION,
  DEFAULT_REPLAY_MAX_RETRIES,
  type BufferState,
  type BufferedReplayEnvelope,
  type ReplaySequencerDeps,
  type StreamReplayInput,
} from './stream-replay-ops.js';

const SPEC: StreamSpec = {
  // 'latest'
  status: {
    mode: 'replace',
    replay: 'latest',
    schema: { type: 'object', properties: { active: { type: 'boolean' } } },
  },
  // 'all'
  message: {
    mode: 'append',
    replay: 'all',
    schema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  // default (none)
  noise: {
    mode: 'append',
    schema: { type: 'object', properties: { value: { type: 'number' } } },
  },
  // 'all' + completable
  progress: {
    mode: 'append',
    replay: 'all',
    complete: true,
    schema: { type: 'object', properties: { step: { type: 'string' } } },
  },
};

function mkInput(
  overrides: Partial<StreamReplayInput> & Pick<StreamReplayInput, 'channel'>,
): StreamReplayInput {
  return {
    sessionId: 'sess_1',
    mode: 'append',
    payload: { dummy: true },
    ...overrides,
  };
}

describe('applyRecordOp', () => {
  it('assigns monotonic seq starting at 1 even when policy is "none"', () => {
    const r1 = applyRecordOp(
      EMPTY_BUFFER_STATE,
      mkInput({ channel: 'noise', payload: { value: 1 } }),
      SPEC,
    );
    expect(r1.envelope.seq).toBe(1);
    expect(r1.buffered).toBe(false);
    expect(r1.next.streamSeq).toBe(1);
    expect(r1.next.ring).toEqual([]);
    expect(r1.next.latestByChannel).toEqual({});

    const r2 = applyRecordOp(
      r1.next,
      mkInput({ channel: 'noise', payload: { value: 2 } }),
      SPEC,
    );
    expect(r2.envelope.seq).toBe(2);
    expect(r2.buffered).toBe(false);
    expect(r2.next.streamSeq).toBe(2);
  });

  it('stores "latest" policy entries one-per-channel, replacing prior', () => {
    let state: BufferState = EMPTY_BUFFER_STATE;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'status', mode: 'replace', payload: { active: false } }),
      SPEC,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'status', mode: 'replace', payload: { active: true } }),
      SPEC,
    ).next;
    // Only the most recent status entry — the prior is gone.
    expect(state.latestByChannel.status?.seq).toBe(2);
    expect(state.latestByChannel.status?.payload).toEqual({ active: true });
    expect(state.ring).toEqual([]);
  });

  it('keeps separate "latest" slots per channel', () => {
    const spec: StreamSpec = {
      a: { mode: 'replace', replay: 'latest', schema: { type: 'object' } },
      b: { mode: 'replace', replay: 'latest', schema: { type: 'object' } },
    };
    let state: BufferState = EMPTY_BUFFER_STATE;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'a', mode: 'replace', payload: { v: 1 } }),
      spec,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'b', mode: 'replace', payload: { v: 2 } }),
      spec,
    ).next;
    expect(state.latestByChannel.a?.payload).toEqual({ v: 1 });
    expect(state.latestByChannel.b?.payload).toEqual({ v: 2 });
  });

  it('appends "all" policy entries to the ring and preserves order', () => {
    let state: BufferState = EMPTY_BUFFER_STATE;
    for (let i = 1; i <= 3; i++) {
      state = applyRecordOp(
        state,
        mkInput({ channel: 'message', payload: { text: `m${i}` } }),
        SPEC,
      ).next;
    }
    expect(state.ring.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(state.ring.map((e) => (e.payload as { text: string }).text)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
  });

  it('FIFO-evicts "all" entries past maxPerSession and tracks evictedAboveSeq', () => {
    let state: BufferState = EMPTY_BUFFER_STATE;
    const cap = 3;
    for (let i = 1; i <= 5; i++) {
      state = applyRecordOp(
        state,
        mkInput({ channel: 'message', payload: { text: `m${i}` } }),
        SPEC,
        cap,
      ).next;
    }
    // Ring holds last 3 (seq 3,4,5). Evicted = seq 1,2; newest-evicted = 2.
    expect(state.ring.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(state.evictedAboveSeq).toBe(2);
    expect(state.streamSeq).toBe(5);
  });

  it('"latest" entries never participate in cap-driven eviction', () => {
    let state: BufferState = EMPTY_BUFFER_STATE;
    // 3 'all' + 2 'latest' with cap=3. The 'latest' entries should not
    // count against the ring cap; the ring should only hold 'all' entries.
    state = applyRecordOp(
      state,
      mkInput({ channel: 'message', payload: { text: 'a' } }),
      SPEC,
      3,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'status', mode: 'replace', payload: { active: true } }),
      SPEC,
      3,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'message', payload: { text: 'b' } }),
      SPEC,
      3,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'message', payload: { text: 'c' } }),
      SPEC,
      3,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'message', payload: { text: 'd' } }),
      SPEC,
      3,
    ).next;
    expect(state.ring.length).toBe(3);
    expect(state.ring.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(state.evictedAboveSeq).toBe(1);
    expect(state.latestByChannel.status).toBeDefined();
    expect(state.latestByChannel.status?.seq).toBe(2);
  });

  it('respects input.complete when present (carries through to envelope)', () => {
    const r = applyRecordOp(
      EMPTY_BUFFER_STATE,
      mkInput({
        channel: 'progress',
        payload: { step: 'done' },
        complete: true,
      }),
      SPEC,
    );
    expect(r.envelope.complete).toBe(true);
    expect(r.next.ring[0]?.complete).toBe(true);
  });

  it('omits complete from envelope when input did not set it', () => {
    const r = applyRecordOp(
      EMPTY_BUFFER_STATE,
      mkInput({ channel: 'message', payload: { text: 'x' } }),
      SPEC,
    );
    expect('complete' in r.envelope).toBe(false);
  });

  it('defaults to replay: "none" when spec is absent', () => {
    const r = applyRecordOp(
      EMPTY_BUFFER_STATE,
      mkInput({ channel: 'anything', payload: { x: 1 } }),
      undefined,
    );
    expect(r.envelope.seq).toBe(1);
    expect(r.buffered).toBe(false);
    expect(r.next.ring).toEqual([]);
    expect(r.next.latestByChannel).toEqual({});
  });

  it('throws when maxPerSession < 1', () => {
    expect(() =>
      applyRecordOp(
        EMPTY_BUFFER_STATE,
        mkInput({ channel: 'message', payload: { text: 'x' } }),
        SPEC,
        0,
      ),
    ).toThrow(TypeError);
  });

  it('uses DEFAULT_REPLAY_MAX_PER_SESSION when cap is omitted', () => {
    let state: BufferState = EMPTY_BUFFER_STATE;
    // Don't actually push 257 entries — just confirm the ring absorbs
    // a handful without eviction at default cap.
    for (let i = 0; i < 10; i++) {
      state = applyRecordOp(
        state,
        mkInput({ channel: 'message', payload: { text: `m${i}` } }),
        SPEC,
      ).next;
    }
    expect(state.ring.length).toBe(10);
    expect(state.evictedAboveSeq).toBe(0);
    expect(DEFAULT_REPLAY_MAX_PER_SESSION).toBeGreaterThanOrEqual(256);
  });
});

describe('replayFromBufferOp', () => {
  function seed(): BufferState {
    let state: BufferState = EMPTY_BUFFER_STATE;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'status', mode: 'replace', payload: { active: false } }),
      SPEC,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'message', payload: { text: 'm1' } }),
      SPEC,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'status', mode: 'replace', payload: { active: true } }),
      SPEC,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'message', payload: { text: 'm2' } }),
      SPEC,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'noise', payload: { value: 99 } }),
      SPEC,
    ).next;
    return state;
  }

  it('returns empty envelopes + current cursor for fresh subscribe (fromSeq undefined)', () => {
    const state = seed();
    const result = replayFromBufferOp(state, undefined, SPEC);
    expect(result.envelopes).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.streamSeq).toBe(5);
  });

  it('returns single "latest" entry when fromSeq is before its seq', () => {
    const state = seed();
    const result = replayFromBufferOp(state, 0, SPEC);
    // Latest status (seq 3) — the prior status at seq 1 is gone.
    // All message entries (seq 2, 4).
    // Noise (seq 5) has replay 'none' → not included.
    expect(result.envelopes.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('filters entries where seq <= fromSeq (inclusive cursor)', () => {
    const state = seed();
    const result = replayFromBufferOp(state, 3, SPEC);
    // Only seq > 3 → message seq 4. Latest status (seq 3) excluded.
    expect(result.envelopes.map((e) => e.seq)).toEqual([4]);
    expect(result.envelopes[0]?.channel).toBe('message');
  });

  it('orders envelopes by seq ASC across channels', () => {
    const state = seed();
    const result = replayFromBufferOp(state, 0, SPEC);
    const seqs = result.envelopes.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('reports truncated when fromSeq < evictedAboveSeq on an "all" channel', () => {
    let state: BufferState = EMPTY_BUFFER_STATE;
    const cap = 2;
    for (let i = 1; i <= 5; i++) {
      state = applyRecordOp(
        state,
        mkInput({ channel: 'message', payload: { text: `m${i}` } }),
        SPEC,
        cap,
      ).next;
    }
    // Ring holds [4, 5], evictedAboveSeq = 3.
    expect(state.evictedAboveSeq).toBe(3);
    const resumed = replayFromBufferOp(state, 1, SPEC);
    expect(resumed.truncated).toBe(true);
    expect(resumed.envelopes.map((e) => e.seq)).toEqual([4, 5]);
  });

  it('does NOT report truncated when fromSeq >= evictedAboveSeq', () => {
    let state: BufferState = EMPTY_BUFFER_STATE;
    const cap = 2;
    for (let i = 1; i <= 5; i++) {
      state = applyRecordOp(
        state,
        mkInput({ channel: 'message', payload: { text: `m${i}` } }),
        SPEC,
        cap,
      ).next;
    }
    // evictedAboveSeq = 3; asking for seq > 3 is safe.
    const resumed = replayFromBufferOp(state, 3, SPEC);
    expect(resumed.truncated).toBe(false);
    expect(resumed.envelopes.map((e) => e.seq)).toEqual([4, 5]);
  });

  it('returns empty envelopes when live spec declares no channels', () => {
    const state = seed();
    const result = replayFromBufferOp(state, 0, {});
    expect(result.envelopes).toEqual([]);
    expect(result.streamSeq).toBe(5);
  });

  it('returns empty envelopes when spec is undefined (default policy = none)', () => {
    const state = seed();
    const result = replayFromBufferOp(state, 0, undefined);
    expect(result.envelopes).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('ignores channels whose spec says "none" even when buffer has entries', () => {
    // Seed buffer using an 'all' policy, then replay against a spec that
    // downgrades the same channel to 'none' — buffer shouldn't be read.
    let state: BufferState = EMPTY_BUFFER_STATE;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'message', payload: { text: 'a' } }),
      SPEC,
    ).next;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'message', payload: { text: 'b' } }),
      SPEC,
    ).next;
    const downgradedSpec: StreamSpec = {
      message: {
        mode: 'append',
        replay: 'none',
        schema: { type: 'object' },
      },
    };
    const result = replayFromBufferOp(state, 0, downgradedSpec);
    expect(result.envelopes).toEqual([]);
    expect(result.streamSeq).toBe(2);
  });

  it('honors fresh cursor even when buffer holds history', () => {
    const state = seed();
    // Reconnecting at cursor == streamSeq → nothing to replay.
    const result = replayFromBufferOp(state, state.streamSeq, SPEC);
    expect(result.envelopes).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.streamSeq).toBe(5);
  });

  it('carries complete through the envelope on replay', () => {
    let state: BufferState = EMPTY_BUFFER_STATE;
    state = applyRecordOp(
      state,
      mkInput({ channel: 'progress', payload: { step: 'done' }, complete: true }),
      SPEC,
    ).next;
    const result = replayFromBufferOp(state, 0, SPEC);
    const env = result.envelopes.find((e) => e.channel === 'progress');
    expect(env?.complete).toBe(true);
  });
});

describe('normalizeBufferState', () => {
  it('returns an equivalent of EMPTY_BUFFER_STATE for an all-null partial', () => {
    const state = normalizeBufferState({
      streamSeq: null,
      ring: null,
      latestByChannel: null,
      evictedAboveSeq: null,
    });
    expect(state).toEqual(EMPTY_BUFFER_STATE);
  });

  it('fills defaults for missing fields', () => {
    const state = normalizeBufferState({ streamSeq: 7 });
    expect(state.streamSeq).toBe(7);
    expect(state.ring).toEqual([]);
    expect(state.latestByChannel).toEqual({});
    expect(state.evictedAboveSeq).toBe(0);
  });

  it('preserves supplied buffer slices verbatim', () => {
    const ring: BufferedReplayEnvelope[] = [
      { seq: 1, channel: 'message', mode: 'append', payload: { text: 'x' } },
    ];
    const latestByChannel: Record<string, BufferedReplayEnvelope> = {
      status: { seq: 2, channel: 'status', mode: 'replace', payload: { active: true } },
    };
    const state = normalizeBufferState({
      streamSeq: 2,
      ring,
      latestByChannel,
      evictedAboveSeq: 0,
    });
    expect(state.ring).toBe(ring);
    expect(state.latestByChannel).toBe(latestByChannel);
  });
});

// ── runSequencedRecord — OCC / retry semantics ─────────────────────
//
// Tests use an in-memory sequencer with a settable "next-conflict"
// knob. That lets us model exactly "the conditional-write failed N
// times then succeeded" without real DDB. The retry loop's contract is:
//   - on first-attempt success, no retries.
//   - on conflict, re-fetch fresh state + re-apply + re-persist.
//   - on missing session (fetchState returns null), throw immediately.
//   - on exhausted budget, throw with the attempt count.
// Seq monotonicity is the cross-cutting invariant: two concurrent
// sequenced records MUST observe distinct seqs.

interface FakeSequencer {
  readonly deps: ReplaySequencerDeps;
  readonly calls: { fetchState: number; persist: number };
  /** Force the next N persist() calls to reject with ReplayConflictError. */
  queueConflicts(n: number): void;
  /** Force fetchState to return null for the next N calls. */
  queueMissing(n: number): void;
  /** Inspect the most recent buffer state accepted by persist. */
  currentState(): BufferState;
  /** Inspect the spec returned by fetchState. */
  setSpec(spec: StreamSpec | undefined): void;
}

function mkFakeSequencer(
  initialState: BufferState = EMPTY_BUFFER_STATE,
): FakeSequencer {
  let state: BufferState = initialState;
  let spec: StreamSpec | undefined = SPEC;
  let conflictsToThrow = 0;
  let missingToReturn = 0;
  const calls = { fetchState: 0, persist: 0 };
  const deps: ReplaySequencerDeps = {
    async fetchState(sessionId) {
      calls.fetchState += 1;
      if (missingToReturn > 0) {
        missingToReturn -= 1;
        return null;
      }
      void sessionId;
      return { state, spec };
    },
    async persist(sessionId, expectedOldSeq, newState) {
      calls.persist += 1;
      if (conflictsToThrow > 0) {
        conflictsToThrow -= 1;
        throw new ReplayConflictError(sessionId, expectedOldSeq);
      }
      if (expectedOldSeq !== state.streamSeq) {
        // Realistic DDB behavior: condition check failed silently.
        throw new ReplayConflictError(sessionId, expectedOldSeq);
      }
      state = newState;
    },
  };
  return {
    deps,
    calls,
    queueConflicts(n) {
      conflictsToThrow = n;
    },
    queueMissing(n) {
      missingToReturn = n;
    },
    currentState() {
      return state;
    },
    setSpec(s) {
      spec = s;
    },
  };
}

describe('runSequencedRecord', () => {
  it('succeeds on first attempt when no conflict', async () => {
    const seq = mkFakeSequencer();
    const result = await runSequencedRecord(
      'sess_1',
      mkInput({ channel: 'message', payload: { text: 'hi' } }),
      seq.deps,
    );
    expect(result.envelope.seq).toBe(1);
    expect(seq.calls.fetchState).toBe(1);
    expect(seq.calls.persist).toBe(1);
    expect(seq.currentState().streamSeq).toBe(1);
  });

  it('retries on ReplayConflictError and surfaces monotonic seq', async () => {
    const seq = mkFakeSequencer();
    seq.queueConflicts(2);
    const result = await runSequencedRecord(
      'sess_1',
      mkInput({ channel: 'message', payload: { text: 'hi' } }),
      seq.deps,
    );
    expect(result.envelope.seq).toBe(1);
    expect(seq.calls.fetchState).toBe(3);
    expect(seq.calls.persist).toBe(3);
  });

  it('throws ReplayMaxRetriesExceededError when retry budget exhausted', async () => {
    const seq = mkFakeSequencer();
    seq.queueConflicts(DEFAULT_REPLAY_MAX_RETRIES + 10);
    await expect(
      runSequencedRecord(
        'sess_1',
        mkInput({ channel: 'message', payload: { text: 'x' } }),
        seq.deps,
      ),
    ).rejects.toBeInstanceOf(ReplayMaxRetriesExceededError);
    // Budget = maxRetries (5) + 1 initial attempt = 6 persist calls before giving up.
    expect(seq.calls.persist).toBe(DEFAULT_REPLAY_MAX_RETRIES + 1);
  });

  it('honors maxRetries option override', async () => {
    const seq = mkFakeSequencer();
    seq.queueConflicts(10);
    await expect(
      runSequencedRecord(
        'sess_1',
        mkInput({ channel: 'message', payload: { text: 'x' } }),
        seq.deps,
        { maxRetries: 1 },
      ),
    ).rejects.toBeInstanceOf(ReplayMaxRetriesExceededError);
    // 1 initial + 1 retry = 2 persist calls.
    expect(seq.calls.persist).toBe(2);
  });

  it('throws ReplaySessionNotFoundError immediately when fetchState returns null', async () => {
    const seq = mkFakeSequencer();
    seq.queueMissing(1);
    await expect(
      runSequencedRecord(
        'sess_1',
        mkInput({ channel: 'message', payload: { text: 'x' } }),
        seq.deps,
      ),
    ).rejects.toBeInstanceOf(ReplaySessionNotFoundError);
    expect(seq.calls.fetchState).toBe(1);
    expect(seq.calls.persist).toBe(0);
  });

  it('re-surfaces unexpected errors from persist without retry', async () => {
    const customError = new Error('network exploded');
    const deps: ReplaySequencerDeps = {
      async fetchState() {
        return { state: EMPTY_BUFFER_STATE, spec: SPEC };
      },
      async persist() {
        throw customError;
      },
    };
    await expect(
      runSequencedRecord(
        'sess_1',
        mkInput({ channel: 'message', payload: { text: 'x' } }),
        deps,
      ),
    ).rejects.toBe(customError);
  });

  it('monotonic seq holds under interleaved record calls (two racers sharing one sequencer)', async () => {
    // Both racers read initial state=0, compute seq=1, persist. One wins;
    // the other sees conflict (expectedOldSeq=0 now != actual=1), retries,
    // sees state=1, computes seq=2, persists, succeeds. Final state.streamSeq=2.
    const seq = mkFakeSequencer();
    const [a, b] = await Promise.all([
      runSequencedRecord(
        'sess_1',
        mkInput({ channel: 'message', payload: { text: 'A' } }),
        seq.deps,
      ),
      runSequencedRecord(
        'sess_1',
        mkInput({ channel: 'message', payload: { text: 'B' } }),
        seq.deps,
      ),
    ]);
    const seqs = [a.envelope.seq, b.envelope.seq].sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2]);
    expect(seq.currentState().streamSeq).toBe(2);
  });

  it('retry picks up fresh state — envelope stamped with post-conflict seq', async () => {
    // Seed: one winner wrote state.streamSeq=5. Our racer's first attempt
    // reads streamSeq=0 (initial), computes seq=1, hits queued conflict,
    // retries after winner's write → reads streamSeq=5, computes seq=6.
    //
    // Simulate an already-advanced state on second fetch — the simplest
    // way is to queue one conflict, then upon retry fetchState returns
    // a fresher state. We encode this via a spy-driven fake.
    let fetchCalls = 0;
    const customDeps: ReplaySequencerDeps = {
      async fetchState() {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return { state: EMPTY_BUFFER_STATE, spec: SPEC };
        }
        return {
          state: normalizeBufferState({ streamSeq: 5 }),
          spec: SPEC,
        };
      },
      persist: vi
        .fn()
        .mockRejectedValueOnce(new ReplayConflictError('sess_1', 0))
        .mockResolvedValueOnce(undefined),
    };
    const result = await runSequencedRecord(
      'sess_1',
      mkInput({ channel: 'message', payload: { text: 'x' } }),
      customDeps,
    );
    expect(result.envelope.seq).toBe(6);
  });

  it('uses maxPerSession cap from options during apply', async () => {
    // Start with a 3-entry ring, cap=3; next record evicts oldest.
    const seeded = normalizeBufferState({
      streamSeq: 3,
      ring: [
        { seq: 1, channel: 'message', mode: 'append', payload: { text: 'a' } },
        { seq: 2, channel: 'message', mode: 'append', payload: { text: 'b' } },
        { seq: 3, channel: 'message', mode: 'append', payload: { text: 'c' } },
      ],
    });
    const customDeps: ReplaySequencerDeps = {
      async fetchState() {
        return { state: seeded, spec: SPEC };
      },
      persist: vi.fn().mockResolvedValue(undefined),
    };
    const result = await runSequencedRecord(
      'sess_1',
      mkInput({ channel: 'message', payload: { text: 'd' } }),
      customDeps,
      { maxPerSession: 3 },
    );
    expect(result.envelope.seq).toBe(4);
    expect(result.next.ring.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(result.next.evictedAboveSeq).toBe(1);
  });
});
