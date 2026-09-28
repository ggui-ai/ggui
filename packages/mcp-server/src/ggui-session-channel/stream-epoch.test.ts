/**
 * ggui#1531 — the one rule the pump and `externalBroadcast` share for a
 * live data frame against a subscriber's replay cursor.
 */
import { describe, expect, it } from 'vitest';
import { admitLiveEnvelope, type StreamReplayCursor } from './stream-epoch.js';

describe('admitLiveEnvelope (ggui#1531)', () => {
  it('skips a same-epoch frame the replay covered, and delivers one past it', () => {
    const cursor: StreamReplayCursor = { seq: 5, epoch: 'e1' };
    expect(admitLiveEnvelope(cursor, { seq: 5, streamEpoch: 'e1' })).toEqual({ deliver: false });
    expect(admitLiveEnvelope(cursor, { seq: 6, streamEpoch: 'e1' })).toEqual({ deliver: true });
    expect(cursor).toEqual({ seq: 5, epoch: 'e1' });
  });

  it('delivers a frame of another epoch whatever its seq, and moves the cursor to that epoch with an empty boundary', () => {
    const cursor: StreamReplayCursor = { seq: 5, epoch: 'e1' };
    expect(admitLiveEnvelope(cursor, { seq: 1, streamEpoch: 'e2' })).toEqual({
      deliver: true,
      epochChanged: { from: 'e1', to: 'e2' },
    });
    expect(cursor).toEqual({ seq: 0, epoch: 'e2' });
    // The new generation's next frame passes; the old one's no longer can move it back silently.
    expect(admitLiveEnvelope(cursor, { seq: 2, streamEpoch: 'e2' })).toEqual({ deliver: true });
  });

  it('adopts the first epoch a cursor without one sees, and keeps its seq boundary', () => {
    const cursor: StreamReplayCursor = { seq: 3, epoch: undefined };
    expect(admitLiveEnvelope(cursor, { seq: 2, streamEpoch: 'e1' })).toEqual({ deliver: false });
    expect(cursor).toEqual({ seq: 3, epoch: 'e1' });
    expect(admitLiveEnvelope(cursor, { seq: 4, streamEpoch: 'e1' })).toEqual({ deliver: true });
  });

  it('reads an absent epoch as unknown, never a mismatch, and passes an unstamped frame', () => {
    const cursor: StreamReplayCursor = { seq: 5, epoch: 'e1' };
    expect(admitLiveEnvelope(cursor, { seq: 4 })).toEqual({ deliver: false });
    expect(admitLiveEnvelope(cursor, { seq: 6 })).toEqual({ deliver: true });
    expect(admitLiveEnvelope(cursor, {})).toEqual({ deliver: true });
    expect(cursor).toEqual({ seq: 5, epoch: 'e1' });
  });
});
