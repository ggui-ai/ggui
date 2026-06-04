/**
 * SessionStreamBuffer — per-session bounded replay ring for live-channel
 * outbound stream envelopes.
 *
 * Scope (2026-04-19). Lands the server-side primitive that makes
 * `streamSpec[name].replay` ('none' | 'latest' | 'all')
 * operational, instead of advisory. Per the three-channel-topology
 * doctrine, the live channel is the enforcement point for the typed live
 * contract; replay is one half of its durability story (the other
 * being idempotent inbound action delivery, which lives on
 * RenderStore's inbound-event log).
 *
 * Intentionally narrow:
 *
 *   - In-memory only. No SQLite / Postgres / Dynamo adapter. The OSS
 *     server uses this directly; hosted cloud has its own durability
 *     model and is OUT of scope for this slice.
 *   - Bounded, NOT persistent. Server restart drops all buffered
 *     envelopes — documented on the interface. Consumers that need
 *     persistence layer a different `SessionStreamBuffer`
 *     implementation behind this interface.
 *   - Replay policy applied at RECORD time (memory-optimal). `'none'`
 *     channels don't store; `'latest'` channels keep a single slot;
 *     `'all'` channels append to the ring with FIFO eviction.
 *   - Sequencing scope: one monotonic counter per session, shared
 *     across all channels. `seq` is session-scoped — NOT cross-session
 *     global — and gap-free once started. Counter resumes from the
 *     latest stored value if any envelope remains in the buffer after
 *     a record/replay cycle; there's no explicit "reset" path short
 *     of `clear(renderId)`.
 *   - NOT a replacement for RenderStore's inbound-event log.
 *     RenderStore tracks user actions + UI mutations for
 *     observation/audit. SessionStreamBuffer tracks outbound
 *     live-channel deliveries for the narrower purpose of reconnect
 *     replay. Different seq spaces, different retention policies,
 *     different consumers.
 *
 * The full authoritative outbound envelope shape is still evolving.
 * For the current protocol state:
 *
 *   - `seq` is optional on `StreamEnvelope`; OSS emits with seq,
 *     hosted does not yet.
 *   - `timestamp` is intentionally NOT on the envelope today.
 *     Replay correctness needs seq only; timestamp is a future
 *     optional addition driven by a concrete client-UX need.
 */
import type {
  JsonValue,
  StreamChannelMode,
  StreamSpec,
} from '@ggui-ai/protocol';
import { DEFAULT_STREAM_REPLAY_POLICY } from '@ggui-ai/protocol';

/**
 * The outbound delivery a producer hands to the buffer. Lacks `seq`
 * — the buffer assigns it. Mirrors `StreamEnvelope` (from
 * `@ggui-ai/protocol`) minus the sequencing field, so every call-site
 * can upcast trivially with `{...delivery, seq}`.
 */
export interface StreamEnvelopeInput {
  readonly renderId: string;
  readonly channel: string;
  readonly mode: StreamChannelMode;
  readonly payload: JsonValue;
  readonly complete?: boolean;
}

/**
 * A buffered outbound envelope — what the buffer stores and what
 * `replay()` returns. Every field matches the wire envelope plus an
 * assigned `seq`.
 *
 * Note: `seq` is REQUIRED here because buffered records MUST carry
 * their assigned sequence. This narrows `StreamEnvelope.seq?: number`
 * (optional on the wire) to required at the record layer.
 */
export interface BufferedStreamEnvelope {
  readonly renderId: string;
  readonly seq: number;
  readonly channel: string;
  readonly mode: StreamChannelMode;
  readonly payload: JsonValue;
  readonly complete?: boolean;
  /**
   * Protocol schema version stamped at record time. Forward-compat
   * advisory field — consumers MUST NOT reject on mismatch pre-launch.
   * See `PROTOCOL_SCHEMA_VERSION` on `@ggui-ai/protocol`.
   */
  readonly schemaVersion?: string;
}

/**
 * Outcome of a `record` call.
 */
export interface RecordResult {
  /** The stamped envelope — producers fan this out to subscribers. */
  readonly envelope: BufferedStreamEnvelope;
  /**
   * True if the buffer stored the envelope for replay. False when the
   * channel's replay policy is `'none'` (seq still assigned, envelope
   * still fan-outable, just not persisted for reconnecting subscribers).
   */
  readonly buffered: boolean;
}

/**
 * Outcome of a `replay` call.
 */
export interface ReplayResult {
  /**
   * Envelopes to re-deliver to the reconnecting subscriber, ordered
   * by assigned `seq` ASC. Filtered per-channel by the channel's
   * declared replay policy.
   */
  readonly envelopes: readonly BufferedStreamEnvelope[];
  /**
   * True when the caller's `fromSeq` is older than the oldest buffered
   * envelope for any channel with replay: 'all'. The subscriber has
   * lost a portion of the live history; clients SHOULD surface this
   * as a break in their view. Always false for 'none'/'latest'-only
   * specs (those policies don't have "history" to truncate).
   */
  readonly truncated: boolean;
  /**
   * Current latest assigned seq for the session. Mirrors the session's
   * stream cursor as the subscriber saw it at replay time. Use this
   * as the boundary between replayed frames and the live tail. When
   * the session has never recorded, this is 0.
   */
  readonly streamSeq: number;
}

/**
 * `SessionStreamBuffer` — server-side durability primitive for channel
 * 3's outbound stream. Every field is documented on the individual
 * methods.
 *
 * Async by design. The
 * in-memory reference impl resolves all promises on the same tick (no
 * real async hop), preserving the original FIFO-call-order property
 * for OSS. Hosted impls (Redis sorted-set + hash) honor the contract
 * via async wire round-trips and accept that concurrent producers may
 * interleave at the byte/network level — replay correctness is
 * still guaranteed by atomic `INCR`-based seq assignment, so the
 * recorded order matches seq order even under concurrent writers.
 */
export interface SessionStreamBuffer {
  /**
   * Assign the next seq for `input.renderId` and (conditionally)
   * store the stamped envelope per the channel's replay policy.
   *
   * Per-channel policy resolution:
   *
   *   - If `spec` is provided and declares the channel, its
   *     `replay` field (with `DEFAULT_STREAM_REPLAY_POLICY` applied
   *     when omitted) drives the decision.
   *   - If `spec` is omitted OR the channel is not declared on the
   *     spec, `DEFAULT_STREAM_REPLAY_POLICY` ('none') applies — seq
   *     is still assigned, nothing stored.
   *
   * Seq is monotonic per session, starting at 1, gap-free under a
   * single producer. The in-memory impl serializes record-calls on
   * the JS event loop so concurrent in-process producers resolve
   * FIFO in call order. Hosted impls assign seq via atomic `INCR`,
   * so concurrent network-side producers are also gap-free though
   * not necessarily FIFO-by-call-time.
   */
  record(input: StreamEnvelopeInput, spec?: StreamSpec): Promise<RecordResult>;

  /**
   * Return the buffered envelopes this subscriber should receive on
   * (re)connect. When `fromSeq` is `undefined`, returns an empty
   * envelopes array — a fresh subscribe does NOT pull history. When
   * `fromSeq` is a number, returns envelopes with `seq > fromSeq` up
   * to the current stream seq at call time.
   *
   * Per-channel filtering applied using the supplied `spec`:
   *
   *   - Channels with `replay: 'none'` contribute nothing (they were
   *     never stored).
   *   - Channels with `replay: 'latest'` contribute at most one
   *     envelope — the most recently recorded for the channel, IF
   *     its seq > fromSeq.
   *   - Channels with `replay: 'all'` contribute every stored
   *     envelope for the channel with seq > fromSeq, in seq order.
   *
   * When `spec` is absent, `DEFAULT_STREAM_REPLAY_POLICY` applies to
   * every channel — i.e., nothing is replayed. The buffer does NOT
   * second-guess the spec; if a spec says `'all'` but the live render
   * spec at replay time says `'none'`, the replay is empty.
   *
   * `truncated` is true ONLY when at least one `'all'` channel has
   * evicted envelopes with seq > fromSeq that it can no longer
   * return. For `'none'` and `'latest'` policies, truncation is
   * meaningless (no history by definition) and always reported
   * false.
   *
   * Output is stable-sorted by `seq` ASC across channels.
   */
  replay(
    renderId: string,
    fromSeq: number | undefined,
    spec?: StreamSpec,
  ): Promise<ReplayResult>;

  /**
   * Current latest assigned seq for this session, or 0 when never
   * recorded. Useful for a reconnecting subscriber that wants to know
   * the live cursor without pulling history.
   */
  currentSeq(renderId: string): Promise<number>;

  /**
   * Drop all buffered state for a render. Invoked on render `delete`
   * or TTL eviction by the render-lifecycle layer. Idempotent —
   * no-op when the render has no buffered state.
   */
  clear(renderId: string): Promise<void>;

  /**
   * Total buffered envelope count across all sessions. Useful for
   * health endpoints / operator diagnostics. Not a cap.
   *
   * Async to support hosted impls (where this is a `DBSIZE`/`SCAN`-
   * scope query). In-memory resolves on the same tick.
   */
  getSize(): Promise<number>;
}

/**
 * Config for {@link SessionStreamBuffer} implementations. Implementers
 * are NOT required to honor every field — in-memory uses all of them;
 * a persistent adapter might ignore `maxPerSession` and use a
 * different retention model.
 */
export interface SessionStreamBufferOptions {
  /**
   * Per-session cap on buffered envelopes across ALL `'all'` channels.
   * Does not cap `'latest'` channels (they're always single-slot
   * per-channel). When reached, FIFO-evicts the oldest buffered
   * envelope for the session. Default: 256.
   */
  readonly maxPerSession?: number;
}

/**
 * Default cap for per-session ring. Held here so adapters and
 * consumers agree without re-declaring the literal.
 */
export const DEFAULT_SESSION_STREAM_BUFFER_MAX = 256;

// Re-export so consumers don't need a second import.
export { DEFAULT_STREAM_REPLAY_POLICY };
