/**
 * Live LLM trace sink — devtools introspection of every LLM call the
 * generation harness makes.
 *
 * **Distinct from {@link TelemetrySink} and {@link AuditSink}.**
 *   - **Telemetry** (mcp-server-core) = ops signals (`pair.completed`,
 *     `render.duration_ms`). Sink may be lossy and drops on backpressure.
 *     Attributes are flat scalars (`string | number | boolean`).
 *   - **Audit** (mcp-server-core) = compliance log of privileged
 *     mutations. Durable, async, may throw.
 *   - **LLM trace** (this) = devtools-only, hostable in-memory ring
 *     buffer of every LLM call's full payload (system prompt, user
 *     prompt, tool defs, completion, token counts, cache hits, error).
 *     Lossy by default. A hosted closed runtime may swap in a durable
 *     sink for internal debugging; OSS ships an in-memory sink the
 *     `/devtools/llm-trace` page reads.
 *
 * **Why module-level registry instead of constructor injection.** The
 * harness constructs LLM agents on every generation via
 * {@link createAgent}. Threading a sink through every call site
 * (createAgent → run-coding-turn → llm-evaluator → file-agent → …)
 * touches ~5 packages for a devtools-only surface. The OSS ggui server
 * is a single process per CLI invocation — global state has no
 * confusion-cost there. A hosted closed runtime isolates per request
 * via process-pool, so a global per-pool is also safe. If we ever
 * multi-tenant inside one process we'll thread it then.
 *
 * **Default = no sink.** When unset, the router emits nothing and
 * spends no CPU formatting events. Passing `null` removes a previously
 * registered sink.
 */
import type { LLMToolDef } from '../llm.js';

/** Provider tag that produced the call. Mirrors {@link AgentConfig.provider}. */
export type LlmTraceProvider = 'anthropic' | 'openai' | 'google' | 'openrouter';

/** Which `LLMAgent` method initiated the call. */
export type LlmTraceKind =
  | 'callText'
  | 'callTools'
  | 'callWithTools'
  | 'callStructured';

/**
 * One LLM call. Emitted **after** the call completes (success or error)
 * — single event, not start/end split. Devtools UI is timeline-friendly
 * because each event carries `at` (start) + `endedAt` (end).
 */
export interface LlmTraceEvent {
  /** Random per-event ID. */
  readonly id: string;
  /** Epoch ms when the call was issued. */
  readonly at: number;
  /** Epoch ms when the call completed (success or error). */
  readonly endedAt: number;
  /** `endedAt - at` — convenience. */
  readonly durationMs: number;
  readonly provider: LlmTraceProvider;
  readonly model: string;
  readonly kind: LlmTraceKind;
  readonly systemPrompt?: string;
  readonly userPrompt?: string;
  /**
   * Tool defs sent on the call (if any). Stripped to `name + description`
   * — full JSON schema would balloon the trace and is rarely useful in
   * the operator UI.
   */
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
  }>;
  /** Set on successful completion. */
  readonly result?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Anthropic only. Bytes counted toward the cache write. */
    readonly cacheCreated?: number;
    /** Anthropic only. Bytes served from cache (90% discounted). */
    readonly cacheRead?: number;
    /** Set when the call returned text content. */
    readonly text?: string;
    /** Set when the call returned tool_use blocks. */
    readonly toolCalls?: ReadonlyArray<{
      readonly name: string;
      readonly input: unknown;
    }>;
    /** Set for `callWithTools` — number of agentic turns consumed. */
    readonly turnsUsed?: number;
  };
  /** Set on failure. `result` is undefined. */
  readonly error?: { readonly message: string };
}

/**
 * Sink that receives one event per LLM call. Implementations MUST be
 * sync + non-throwing — the harness fires events on the hot path and
 * cannot tolerate backpressure or rejected promises. Buffer + drop or
 * fan out to a queue inside the implementation.
 */
export interface LlmTraceSink {
  emit(event: LlmTraceEvent): void;
}

let activeSink: LlmTraceSink | null = null;

/**
 * Register the active sink. Pass `null` to remove. Subsequent
 * {@link emitLlmTraceEvent} calls dispatch to this sink.
 */
export function setLlmTraceSink(sink: LlmTraceSink | null): void {
  activeSink = sink;
}

/** Read the active sink. Mostly for tests. */
export function getLlmTraceSink(): LlmTraceSink | null {
  return activeSink;
}

/**
 * Internal — used by `LLMAgent` adapters. No-op when no sink is
 * registered. Swallows sink-thrown errors (a broken devtools sink must
 * not break generation).
 */
export function emitLlmTraceEvent(event: LlmTraceEvent): void {
  const sink = activeSink;
  if (!sink) return;
  try {
    sink.emit(event);
  } catch {
    // Devtools sink is allowed to be buggy — generation must not die.
  }
}

/** Strip `LLMToolDef[]` to the trace-friendly subset. */
export function summarizeTools(
  tools: ReadonlyArray<LLMToolDef>,
): ReadonlyArray<{ readonly name: string; readonly description: string }> {
  return tools.map((t) => ({ name: t.name, description: t.description }));
}

/**
 * Crockford-style random ID. Crypto.randomUUID() would do, but we want
 * to keep this dep-free for non-Node runtimes the harness might run in.
 */
export function newLlmTraceId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}
