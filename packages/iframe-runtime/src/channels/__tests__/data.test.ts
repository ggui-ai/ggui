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

function envelope(seq: number | undefined, text = 'x'): StreamEnvelope {
  return {
    sessionId: 's1',
    channel: 'feed',
    mode: 'append',
    payload: { text },
    ...(seq !== undefined ? { seq } : {}),
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
  it('observeServerSeq below the highest applied seq forgets the cursor and says so; at or above it keeps it', () => {
    const t = createStreamSeqTracker();
    t.admit(9);
    expect(t.observeServerSeq(9)).toBe(false);
    expect(t.observeServerSeq(12)).toBe(false);
    expect(t.last()).toBe(9);
    expect(t.observeServerSeq(2)).toBe(true);
    expect(t.last()).toBeUndefined();
    expect(t.admit(1)).toBe(true);
  });

  it('with nothing applied yet there is nothing to forget', () => {
    const t = createStreamSeqTracker();
    expect(t.observeServerSeq(0)).toBe(false);
  });
});
