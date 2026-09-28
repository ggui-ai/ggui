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
 */
export interface StreamSeqTracker {
  /** Whether to apply an envelope with this `seq`; records it when so. */
  admit(seq: number | undefined): boolean;
  /** The highest `seq` applied so far; `undefined` before the first stamped envelope. */
  last(): number | undefined;
  /**
   * The server's current counter, from an ack (`AckPayload.streamSeq`).
   * Below the highest applied `seq` it can only mean the counter restarted:
   * the cursor is forgotten, and `true` says so.
   */
  observeServerSeq(serverSeq: number): boolean;
}

export function createStreamSeqTracker(): StreamSeqTracker {
  let highest: number | undefined;
  return {
    admit(seq) {
      if (seq === undefined) return true;
      if (highest !== undefined && seq <= highest) return false;
      highest = seq;
      return true;
    },
    last: () => highest,
    observeServerSeq(serverSeq) {
      if (highest === undefined || serverSeq >= highest) return false;
      highest = undefined;
      return true;
    },
  };
}
