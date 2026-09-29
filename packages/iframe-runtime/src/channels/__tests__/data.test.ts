/**
 * ggui#1496 (rev 2.4) — the `data` handler applies a stamped stream
 * envelope at most once. `StreamEnvelope.seq` is session-scoped and
 * delivery is at-least-once, so a client dedupes on it; the highest
 * applied `seq` is also the stream cursor a new subscribe resumes from
 * (`SubscribePayload.fromSeq`). An unstamped envelope is single-shot and
 * always passes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { StreamEnvelope } from '@ggui-ai/protocol/wire';
import { StreamBus } from '../../wire-config.js';
import { createDataHandler } from '../data.js';
import { createStreamSeqTracker } from '../../stream-seq.js';

function envelope(seq: number | undefined, text = 'x', streamEpoch?: string): StreamEnvelope {
  return {
    sessionId: 's1',
    channel: 'feed',
    mode: 'append',
    payload: { text },
    ...(seq !== undefined ? { seq } : {}),
    ...(streamEpoch !== undefined ? { streamEpoch } : {}),
  };
}

function handler() {
  const streamBus = new StreamBus();
  const emit = vi.spyOn(streamBus, 'emit');
  const streamSeq = createStreamSeqTracker();
  const h = createDataHandler({
    getCurrentGguiSession: () => null,
    streamBus,
    validatorCtx: { reservedValidators: undefined },
    streamSeq,
  });
  return { h, emit, streamSeq };
}

describe('data handler: a stamped envelope is applied at most once (ggui#1496)', () => {
  it('drops a redelivered seq', () => {
    const { h, emit } = handler();
    void h.onMessage(envelope(1));
    void h.onMessage(envelope(1));
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('drops a seq at or below the highest applied one', () => {
    const { h, emit } = handler();
    void h.onMessage(envelope(3, 'third'));
    void h.onMessage(envelope(2, 'second'));
    void h.onMessage(envelope(4, 'fourth'));
    expect(emit.mock.calls.map((c) => (c[0] as StreamEnvelope).seq)).toEqual([3, 4]);
  });

  it('always applies an unstamped envelope (single-shot, no replay possible)', () => {
    const { h, emit } = handler();
    void h.onMessage(envelope(undefined));
    void h.onMessage(envelope(undefined));
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('reports the highest applied seq as the stream cursor, undefined before any', () => {
    const { h, streamSeq } = handler();
    expect(streamSeq.last()).toBeUndefined();
    void h.onMessage(envelope(undefined));
    expect(streamSeq.last()).toBeUndefined();
    void h.onMessage(envelope(5));
    void h.onMessage(envelope(2));
    expect(streamSeq.last()).toBe(5);
  });
});

describe('stream cursor: the server counter restarted (ggui#1496)', () => {
  it('an ack whose streamSeq is below the highest applied seq forgets the cursor and says so; at or above it keeps it', () => {
    const t = createStreamSeqTracker();
    t.admit(9);
    expect(t.observeAck(9, undefined)).toBe(false);
    expect(t.observeAck(12, undefined)).toBe(false);
    expect(t.last()).toBe(9);
    expect(t.observeAck(2, undefined)).toBe(true);
    expect(t.last()).toBeUndefined();
    expect(t.admit(1)).toBe(true);
  });

  it('with nothing applied yet there is nothing to forget', () => {
    const t = createStreamSeqTracker();
    expect(t.observeAck(0, undefined)).toBe(false);
  });
});

describe('stream cursor: the stream epoch (ggui#1531)', () => {
  it('a frame from a different epoch resets the cursor and is applied; the new epoch is adopted', () => {
    const t = createStreamSeqTracker();
    t.admit(9, 'A');
    expect(t.admit(1, 'B')).toBe(true);
    expect(t.last()).toBe(1);
    expect(t.epoch()).toBe('B');
    expect(t.admit(1, 'B')).toBe(false);
  });

  it('within one epoch, a redelivery still drops', () => {
    const t = createStreamSeqTracker();
    t.admit(9, 'A');
    expect(t.admit(5, 'A')).toBe(false);
  });

  it('a missing epoch is unknown, never a mismatch: the seq rule alone decides and the epoch is kept', () => {
    const t = createStreamSeqTracker();
    t.admit(9, 'A');
    expect(t.admit(5, undefined)).toBe(false);
    expect(t.epoch()).toBe('A');
    expect(t.admit(10, undefined)).toBe(true);
  });

  it('a first epoch after unknown history is adopted without a reset', () => {
    const t = createStreamSeqTracker();
    t.admit(9);
    expect(t.admit(5, 'A')).toBe(false);
    expect(t.epoch()).toBe('A');
    expect(t.last()).toBe(9);
  });

  it('an ack from a different epoch resets before the replay, even when its streamSeq is higher', () => {
    const t = createStreamSeqTracker();
    t.admit(9, 'A');
    expect(t.observeAck(12, 'B')).toBe(true);
    expect(t.last()).toBeUndefined();
    expect(t.epoch()).toBe('B');
    expect(t.admit(1, 'B')).toBe(true);
  });

  it('an ack in the same epoch, or without one, falls back to the seq rule', () => {
    const t = createStreamSeqTracker();
    t.admit(9, 'A');
    expect(t.observeAck(12, 'A')).toBe(false);
    expect(t.observeAck(12, undefined)).toBe(false);
    expect(t.epoch()).toBe('A');
    expect(t.observeAck(2, undefined)).toBe(true);
  });

  it('an ack adopts an epoch when none is known, without a reset', () => {
    const t = createStreamSeqTracker();
    t.admit(9);
    expect(t.observeAck(12, 'A')).toBe(false);
    expect(t.epoch()).toBe('A');
    expect(t.last()).toBe(9);
  });

  it('no epoch before one is seen', () => {
    expect(createStreamSeqTracker().epoch()).toBeUndefined();
  });
});

// ggui#1531 — never move back to an epoch the view has left. A late frame of
// the old generation (a cross-replica frame published just before the
// restart) would otherwise move the cursor back with nothing applied, and the
// next frame of the new generation would move it forward again with an empty
// floor, so an at-least-once duplicate within the new generation would pass.
// The server keeps the same rule (stream-epoch.ts, RETIRED_EPOCHS_KEPT).
describe('stream cursor: an epoch the view has left (ggui#1531)', () => {
  it('drops a late frame of a left epoch and moves nothing, so a duplicate in the current epoch still drops', () => {
    const t = createStreamSeqTracker();
    t.admit(9, 'A');
    expect(t.admit(1, 'B')).toBe(true);
    expect(t.admit(2, 'B')).toBe(true);
    expect(t.admit(10, 'A')).toBe(false);
    expect(t.epoch()).toBe('B');
    expect(t.last()).toBe(2);
    expect(t.admit(2, 'B')).toBe(false);
  });

  it('ignores an ack naming a left epoch entirely: no reset, and no seq fallback', () => {
    const t = createStreamSeqTracker();
    t.admit(9, 'A');
    expect(t.observeAck(0, 'B')).toBe(true);
    t.admit(3, 'B');
    expect(t.observeAck(20, 'A')).toBe(false);
    expect(t.observeAck(1, 'A')).toBe(false);
    expect(t.epoch()).toBe('B');
    expect(t.last()).toBe(3);
  });

  it('remembers the last four epochs it left, as the server does, and no more', () => {
    const t = createStreamSeqTracker();
    for (const epoch of ['A', 'B', 'C', 'D', 'E', 'F']) t.admit(1, epoch);
    for (const left of ['B', 'C', 'D', 'E']) expect(t.admit(5, left), left).toBe(false);
    expect(t.epoch()).toBe('F');
    // The fifth epoch back is forgotten: its frame reads as a new generation.
    expect(t.admit(5, 'A')).toBe(true);
    expect(t.epoch()).toBe('A');
  });

  it('an unstamped frame still always passes', () => {
    const t = createStreamSeqTracker();
    t.admit(9, 'A');
    t.admit(1, 'B');
    expect(t.admit(undefined, 'A')).toBe(true);
    expect(t.epoch()).toBe('B');
  });
});

describe('data handler: the envelope epoch reaches the tracker (ggui#1531)', () => {
  it('an envelope from a new epoch is applied although its seq is below the cursor', () => {
    const { h, emit, streamSeq } = handler();
    void h.onMessage(envelope(9, 'old', 'A'));
    void h.onMessage(envelope(1, 'new', 'B'));
    expect(emit).toHaveBeenCalledTimes(2);
    expect(streamSeq.epoch()).toBe('B');
  });
});
