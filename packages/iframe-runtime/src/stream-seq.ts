/**
 * The view's stream cursor (ggui#1496, rev 2.4).
 *
 * `StreamEnvelope.seq` is session-scoped and gap-free, and stream delivery
 * is at-least-once, so the view applies a stamped envelope only when its
 * `seq` is above the highest one it has applied. That highest `seq` is
 * also where a new subscribe resumes the stream from
 * (`SubscribePayload.fromSeq`). An unstamped envelope (a deployment with no
 * stream buffer) is single-shot and always passes, and it moves nothing.
 *
 * A server's counter can restart (a process restart, an in-memory buffer, a
 * stored counter that expired), after which its `seq` starts over below the
 * view's cursor and every new envelope would be dropped. The ack reveals
 * it: its `streamSeq` is the server's current counter, and a monotonic
 * counter can never be below a `seq` this view applied. So an ack whose
 * `streamSeq` is lower means the counter restarted, and the cursor is
 * forgotten.
 *
 * That numeric test misses a counter that restarted and has already
 * climbed past the cursor before the next ack. The stream EPOCH closes it
 * (ggui#1531): the server names each counter generation, on every stamped
 * envelope and on the ack, and a different epoch means a new generation
 * whatever the numbers say, so the cursor resets to nothing applied. A
 * missing epoch (a server, or an envelope, from before epochs) is
 * unknown, never a mismatch: the `seq` rule alone decides, and a first
 * epoch after unknown history is adopted without a reset.
 *
 * The cursor never moves back to an epoch it has left: it remembers the
 * last {@link LEFT_EPOCHS_KEPT}, and drops their frames and ignores their
 * acks. Otherwise a late frame of the old generation (a cross-replica frame
 * published just before the restart) would move it back with nothing
 * applied, and the next frame of the new one would move it forward again
 * with an empty floor, letting a duplicate through. The server keeps the
 * same rule (SPEC §12.2.1 invariant 4).
 */
export interface StreamSeqTracker {
  /**
   * Whether to apply an envelope with this `seq` and `streamEpoch`; records
   * it when so. An envelope from a different epoch first resets the cursor.
   */
  admit(seq: number | undefined, epoch?: string): boolean;
  /** The highest `seq` applied so far; `undefined` before the first stamped envelope. */
  last(): number | undefined;
  /** The counter generation the cursor belongs to; `undefined` until one is seen. */
  epoch(): string | undefined;
  /**
   * An ack's stream position (`AckPayload.streamSeq`, `AckPayload.streamEpoch`).
   * A different epoch, or a `streamSeq` below the highest applied `seq`,
   * means the counter restarted: the cursor is forgotten, and `true` says
   * so.
   */
  observeAck(streamSeq: number | undefined, streamEpoch: string | undefined): boolean;
}

/** How many epochs the cursor remembers having left; the server keeps as many. */
export const LEFT_EPOCHS_KEPT = 4;

export function createStreamSeqTracker(): StreamSeqTracker {
  let highest: number | undefined;
  let current: string | undefined;
  let left: string[] = [];
  const hasLeft = (epoch: string | undefined): boolean => epoch !== undefined && left.includes(epoch);
  /** Adopt `epoch`; a different known epoch resets the cursor. Returns whether it reset. */
  const meetEpoch = (epoch: string | undefined): boolean => {
    if (epoch === undefined) return false;
    const from = current;
    const changed = from !== undefined && epoch !== from;
    current = epoch;
    if (changed) {
      left = [...left, from].slice(-LEFT_EPOCHS_KEPT);
      highest = undefined;
    }
    return changed;
  };
  return {
    admit(seq, epoch) {
      if (seq === undefined) return true;
      if (hasLeft(epoch)) return false;
      meetEpoch(epoch);
      if (highest !== undefined && seq <= highest) return false;
      highest = seq;
      return true;
    },
    last: () => highest,
    epoch: () => current,
    observeAck(streamSeq, streamEpoch) {
      if (hasLeft(streamEpoch)) return false;
      if (meetEpoch(streamEpoch)) return true;
      if (streamSeq === undefined || highest === undefined || streamSeq >= highest) return false;
      highest = undefined;
      return true;
    },
  };
}
