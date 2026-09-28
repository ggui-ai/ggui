/**
 * The live tail's replay boundary, with the stream counter's epoch
 * (ggui#1531). One rule, shared by the two places a live data frame is
 * filtered against a subscriber's replay: the in-process pump
 * (`subscriber-lifecycle.ts`) and the cross-replica direct walk
 * (`outbound.ts`, `externalBroadcast`).
 *
 * A `seq` counts within one counter. When the counter restarts while a
 * subscriber stays attached (a hosted counter evicted or expired, a
 * server restarted over a persistent session store), the next frame
 * arrives at a low `seq` with a new epoch. Filtering it by the old
 * boundary would drop it, and every later one, with no signal: the
 * frame of another epoch is delivered instead, and the subscriber moves
 * to the new epoch with an empty boundary.
 */

/**
 * A subscriber's replay boundary: the latest `seq` its snapshot and
 * replay covered, and the epoch that `seq` counts in (`undefined` when
 * the snapshot had none: no counter yet, or a buffer that predates
 * epochs). Mutable: a live frame of another epoch moves it.
 */
export interface StreamReplayCursor {
  seq: number;
  epoch: string | undefined;
}

/** What to do with one live data frame for one subscriber. */
export interface LiveAdmission {
  readonly deliver: boolean;
  /** Set when the frame moved the subscriber to another epoch. */
  readonly epochChanged?: { readonly from: string; readonly to: string };
}

/**
 * Decide whether a live data frame reaches a subscriber, and move its
 * cursor when the frame's epoch differs:
 *   - an unstamped frame (no `seq`) was never buffered and always passes;
 *   - a frame of another epoch than the cursor's is delivered, and the
 *     cursor moves to that epoch with an empty boundary (a restart);
 *   - the first epoch a cursor without one sees is adopted, and its seq
 *     boundary stands (the snapshot simply had no epoch yet);
 *   - otherwise a frame at or below the boundary was, or will be, sent
 *     by the replay, and is skipped.
 * An absent epoch on the frame is unknown, never a mismatch.
 */
export function admitLiveEnvelope(
  cursor: StreamReplayCursor,
  envelope: { readonly seq?: number; readonly streamEpoch?: string },
): LiveAdmission {
  if (envelope.seq === undefined) return { deliver: true };
  const epoch = envelope.streamEpoch;
  if (epoch !== undefined && epoch !== cursor.epoch) {
    const from = cursor.epoch;
    cursor.epoch = epoch;
    if (from !== undefined) {
      cursor.seq = 0;
      return { deliver: true, epochChanged: { from, to: epoch } };
    }
  }
  return { deliver: envelope.seq > cursor.seq };
}
