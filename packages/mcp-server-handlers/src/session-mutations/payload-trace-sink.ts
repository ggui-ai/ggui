/**
 * Live payload trace sink — devtools introspection of every MCP tool
 * payload that flows through the ggui session-mutation handlers.
 *
 * **Distinct from {@link TelemetrySink}, {@link AuditSink}, and
 * {@link LlmTraceSink}.**
 *   - **Telemetry** = ops signals (counters / timings, scalar attrs).
 *     Lossy on backpressure.
 *   - **Audit** = durable compliance log of privileged mutations.
 *   - **LLM trace** (`@ggui-ai/ui-gen/harness/llm-trace-sink`) =
 *     devtools-only ring buffer of every LLM call's full prompt /
 *     completion / token counts.
 *   - **Payload trace** (this) = devtools-only ring buffer of every
 *     `ggui_push` / `ggui_update` MCP tool call payload as it lands
 *     on the handler. Answers "what JSON did the agent actually send
 *     me?" — invaluable when debugging contract drift.
 *
 * **Why module-level registry instead of constructor injection.** The
 * push + update handlers are constructed once per server boot via
 * `createGguiPushHandler` / `createGguiUpdateHandler` factories.
 * Threading a sink through every handler dep struct + every test that
 * builds them would touch ~30 callsites for a devtools-only surface.
 * The OSS ggui server is a single process per CLI invocation — global
 * state has no confusion-cost there. The hosted runtime isolates per
 * request via process-pool, so a global per-pool is also safe. If we ever
 * multi-tenant inside one process we'll thread it then.
 *
 * **Default = no sink.** When unset, the handler emit calls return
 * immediately without copying or stringifying the payload — zero hot-
 * path cost. Passing `null` removes a previously registered sink.
 *
 * **Direction labelling.** `inbound-push` for `ggui_push` invocations,
 * `outbound-update` for `ggui_update` invocations. From the agent's
 * perspective both are inbound MCP tool calls, but viewed from the
 * end-user UI: a push delivers a new surface (in to the UI), and an
 * update mutates a delivered surface (out to the UI as a `props_update`
 * frame on the live-channel wire). The label aliases the *intent* of the
 * payload, not its transport direction.
 */

/** Direction of the payload from the agent → end-user UI perspective. */
export type PayloadTraceDirection = 'inbound-push' | 'outbound-update';

/**
 * One payload trace entry. Emitted **after** the handler successfully
 * parses input and resolves the session — so `sessionId` and `appId`
 * are always populated and the payload is the post-validation shape
 * the handler is about to act on. Pre-validation rejections (schema
 * shape, missing handshakeStore, etc.) never reach this sink.
 */
export interface PayloadTraceEvent {
  /** Random per-event ID. */
  readonly id: string;
  /** Epoch ms when the handler accepted the payload. */
  readonly at: number;
  readonly direction: PayloadTraceDirection;
  /** Resolved session id. Always populated. */
  readonly sessionId: string;
  /** Resolved app/tenant id from `HandlerContext`. */
  readonly appId: string;
  /** Tool name (`'ggui_push'` | `'ggui_update'`). */
  readonly tool: string;
  /**
   * The post-validation payload the handler is about to act on. Shape
   * is the tool's parsed input — not the wire input — so any handshake
   * synthesis or context default already applied. Stored as `unknown`
   * because consumers (the operator UI) treat it as opaque JSON.
   */
  readonly payload: unknown;
  /**
   * Approximate JSON byte size of `payload`. Pre-computed by the emitter
   * so the operator UI can show a size-at-a-glance without re-stringifying
   * on every render. Falls back to `0` on circular-ref payloads (which
   * shouldn't happen for parsed Zod output, but the catch is cheap).
   */
  readonly byteSize: number;
}

/**
 * Sink that receives one event per accepted payload. Implementations
 * MUST be sync + non-throwing — handlers fire events on the hot path
 * and cannot tolerate backpressure or rejected promises. Buffer + drop
 * or fan out to a queue inside the implementation.
 */
export interface PayloadTraceSink {
  emit(event: PayloadTraceEvent): void;
}

let activeSink: PayloadTraceSink | null = null;

/**
 * Register the active sink. Pass `null` to remove. Subsequent
 * {@link emitPayloadTraceEvent} calls dispatch to this sink.
 */
export function setPayloadTraceSink(sink: PayloadTraceSink | null): void {
  activeSink = sink;
}

/** Read the active sink. Mostly for tests. */
export function getPayloadTraceSink(): PayloadTraceSink | null {
  return activeSink;
}

/**
 * Internal — called from `ggui_push` + `ggui_update` handlers. No-op
 * when no sink is registered, so the byte-size compute + JSON.stringify
 * are skipped on the no-sink hot path. Swallows sink-thrown errors (a
 * broken devtools sink must not break tool dispatch).
 */
export function emitPayloadTraceEvent(
  input: Omit<PayloadTraceEvent, 'id' | 'at' | 'byteSize'> &
    Partial<Pick<PayloadTraceEvent, 'id' | 'at' | 'byteSize'>>,
): void {
  const sink = activeSink;
  if (!sink) return;
  let byteSize = input.byteSize;
  if (byteSize === undefined) {
    try {
      byteSize = Buffer.byteLength(JSON.stringify(input.payload) ?? '', 'utf8');
    } catch {
      // Circular-ref or BigInt — fall back to 0. Shape drift, not a
      // hot-path concern.
      byteSize = 0;
    }
  }
  const event: PayloadTraceEvent = {
    id: input.id ?? newPayloadTraceId(),
    at: input.at ?? Date.now(),
    direction: input.direction,
    sessionId: input.sessionId,
    appId: input.appId,
    tool: input.tool,
    payload: input.payload,
    byteSize,
  };
  try {
    sink.emit(event);
  } catch {
    // Devtools sink is allowed to be buggy — handlers must not die.
  }
}

/**
 * Crockford-style random ID. `crypto.randomUUID()` would do, but we
 * keep this dep-free + sync to match the LlmTraceSink pattern and
 * avoid forcing handlers to await on the trace path.
 */
export function newPayloadTraceId(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}
