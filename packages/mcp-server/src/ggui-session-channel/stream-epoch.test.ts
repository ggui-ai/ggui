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
    expect(cursor).toEqual({ seq: 0, epoch: 'e2', retired: ['e1'] });
    // The new generation's next frame passes; the old one's no longer can move it back silently.
    expect(admitLiveEnvelope(cursor, { seq: 2, streamEpoch: 'e2' })).toEqual({ deliver: true });
  });

  it('never moves back to an epoch it left: a late frame of that epoch is dropped', () => {
    const cursor: StreamReplayCursor = { seq: 5, epoch: 'e1' };
    admitLiveEnvelope(cursor, { seq: 1, streamEpoch: 'e2' });
    admitLiveEnvelope(cursor, { seq: 2, streamEpoch: 'e2' });
    // A cross-replica frame of the old generation, published just before the restart, arrives late.
    expect(admitLiveEnvelope(cursor, { seq: 6, streamEpoch: 'e1' })).toEqual({ deliver: false });
    expect(cursor).toMatchObject({ epoch: 'e2', seq: 0, retired: ['e1'] });
    // The new generation carries on, and a restart after it still moves forward.
    expect(admitLiveEnvelope(cursor, { seq: 3, streamEpoch: 'e2' })).toEqual({ deliver: true });
    expect(admitLiveEnvelope(cursor, { seq: 1, streamEpoch: 'e3' })).toMatchObject({ deliver: true, epochChanged: { from: 'e2', to: 'e3' } });
    expect(cursor.retired).toEqual(['e1', 'e2']);
  });

  it('remembers a bounded number of epochs it left', () => {
    const cursor: StreamReplayCursor = { seq: 0, epoch: 'e0' };
    for (let i = 1; i <= 6; i += 1) admitLiveEnvelope(cursor, { seq: 1, streamEpoch: `e${i}` });
    expect(cursor.retired).toEqual(['e2', 'e3', 'e4', 'e5']);
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
