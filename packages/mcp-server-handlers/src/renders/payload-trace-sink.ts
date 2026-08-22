/**
 * Live payload trace sink — devtools introspection of every MCP tool
 * payload that flows through the ggui render-mutation handlers.
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
 *     `ggui_render` / `ggui_update` MCP tool call payload as it lands
 *     on the handler. Answers "what JSON did the agent actually send
 *     me?" — invaluable when debugging contract drift.
 *
 * **Why constructor injection, not a module-level registry (ggui#605).**
 * An earlier revision kept a module-global `activeSink` with an exported
 * setter — registered from `@ggui-ai/mcp-server` (the console wiring)
 * while emission happened here. That cross-package module-global
 * topology is exactly the class that went dark in production elsewhere
 * (#604's audit): any loader topology that splits module instances —
 * ESM instrumentation hooks, dual-resolution bundling — lands the
 * registration on one instance while the emitters read another, and
 * traces vanish silently. The sink now rides the handler DEPS
 * (`payloadTraceSink` on the render/update factory deps), so registrar
 * and emitter meet on a call path that no loader topology can split.
 *
 * **Default = no sink.** Handlers whose deps carry no sink pay zero
 * hot-path cost — the emit helper returns before copying or
 * stringifying the payload.
 *
 * **Direction labelling.** `inbound-render` for `ggui_render` invocations,
 * `outbound-update` for `ggui_update` invocations. From the agent's
 * perspective both are inbound MCP tool calls, but viewed from the
 * end-user UI: a render delivers a new surface (in to the UI), and an
 * update mutates a delivered surface (out to the UI as a `props_update`
 * frame on the live-channel wire). The label aliases the *intent* of the
 * payload, not its transport direction.
 */

/** Direction of the payload from the agent → end-user UI perspective. */
export type PayloadTraceDirection = 'inbound-render' | 'outbound-update';

/**
 * One payload trace entry. Emitted **after** the handler successfully
 * parses input and resolves the render — so `sessionId` and `appId`
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
  /** Resolved render id. Always populated. */
  readonly sessionId: string;
  /** Resolved app/tenant id from `HandlerContext`. */
  readonly appId: string;
  /** Tool name (`'ggui_render'` | `'ggui_update'`). */
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

/**
 * Called from the `ggui_render` + `ggui_update` handlers with the sink
 * their DEPS carry (ggui#605 — #604's structural rule: the registrar
 * lives in `@ggui-ai/mcp-server`, the emitters live here; a
 * module-global registry across that package boundary goes dark under
 * any loader topology that splits module instances, so registrar and
 * emitter meet on a call path instead). No-op when the deps carry no
 * sink, so the byte-size compute + JSON.stringify are skipped on the
 * unwired hot path. Swallows sink-thrown errors (a broken devtools
 * sink must not break tool dispatch).
 */
export function emitPayloadTraceEvent(
  sink: PayloadTraceSink | null | undefined,
  input: Omit<PayloadTraceEvent, 'id' | 'at' | 'byteSize'> &
    Partial<Pick<PayloadTraceEvent, 'id' | 'at' | 'byteSize'>>,
): void {
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
