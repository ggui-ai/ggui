/**
 * Live validator-tier trace sink — devtools introspection of every
 * `runCheck()` invocation the harness performs.
 *
 * **Distinct from {@link LlmTraceSink}, {@link TelemetrySink}, and
 * {@link AuditSink}.**
 *   - **LLM trace** (sibling) = devtools-only ring buffer of LLM call
 *     payloads (system + user prompt, tools, completion, tokens).
 *     Answers "what did the LLM see / say?".
 *   - **Telemetry** (mcp-server-core) = ops signals (`pair.completed`,
 *     `render.duration_ms`). Lossy. Flat scalars.
 *   - **Audit** (mcp-server-core) = compliance log of privileged
 *     mutations. Durable.
 *   - **Validator trace** (this) = devtools-only ring buffer of every
 *     `runCheck()` call's full validator-tier breakdown — which axis /
 *     tier / runtime-render / LLM checks fired, what each returned
 *     (pass/fail/warn issues with description, fix, line, severity).
 *     Answers "which check failed, and what did the LLM emit?".
 *
 * **Why module-level registry instead of constructor injection.** Same
 * argument as the LLM trace sink — `runCheck()` is called from multiple
 * orchestrator entrypoints (`runHarness`, `run-eval-round`) across the
 * harness package; threading a sink through every call site for a
 * devtools-only surface isn't worth the churn. The ggui server is
 * single-process per CLI invocation; a hosted runtime isolates per
 * request via a process pool.
 *
 * **Default = no sink.** When unset, `runCheck` emits nothing and spends
 * no CPU formatting events. Passing `null` removes a previously
 * registered sink.
 */
import type { Classification } from "../classifier/axes.js";
import type { EvalIssue } from "../evaluation/types-public.js";

/**
 * One `runCheck()` invocation. Emitted **after** all tiers complete
 * (success or partial — even when one tier throws, the others ran and
 * we surface what we have). Single event per call.
 */
export interface ValidatorTraceEvent {
  /** Random per-event ID. */
  readonly id: string;
  /** Epoch ms when `runCheck` was entered. */
  readonly at: number;
  /** Epoch ms when `runCheck` returned. */
  readonly endedAt: number;
  /** `endedAt - at` — convenience. */
  readonly durationMs: number;
  /** Harness fingerprint that drove these checks. */
  readonly harnessId: string;
  /** Classification axes that produced the harness — useful when the
   *  operator asks "why did this axis-check fire?". */
  readonly classification: Classification;
  /** Workflow that produced the source-under-check. */
  readonly workflowId: string;
  /** Was a non-null compiledCode fed in? When false, runCheck short-
   *  circuits to an empty result — surfaced for transparency. */
  readonly hadCompiledCode: boolean;
  /** Was the runtime-render probe deliberately skipped? Mirrors the
   *  `skipRuntimeRender` input flag. */
  readonly skippedRuntimeRender: boolean;
  /** Per-tier issue counts and which check ids fired. */
  readonly summary: {
    readonly totalIssues: number;
    readonly axisIssues: number;
    readonly tierIssues: number;
    readonly llmIssues: number;
    readonly runtimeRenderIssues: number;
    readonly firedCheckIds: readonly string[];
  };
  /** Every issue emitted across all tiers. Carries description + fix +
   *  line + severity + tier + category — the full per-issue payload the
   *  validator UI renders into a per-tier breakdown. */
  readonly issues: readonly EvalIssue[];
  /** Source under check — capped at ~16KB. Operators expanding a card
   *  want to see what failed; longer sources are truncated with a
   *  trailing marker so the UI shows the truncation honestly. */
  readonly sourceCode?: string;
  /** Original prompt — useful when "this passed eval but doesn't match
   *  the request" comes up in operator triage. */
  readonly prompt?: string;
  /** Set when `runCheck` itself threw before completing. The event is
   *  still emitted (devtools want to see partial / failed runs). */
  readonly error?: { readonly message: string };
}

/**
 * Sink that receives one event per `runCheck()` invocation. Same
 * contract as {@link LlmTraceSink} — implementations MUST be sync +
 * non-throwing. Buffer + drop or fan out to a queue inside the
 * implementation.
 */
export interface ValidatorTraceSink {
  emit(event: ValidatorTraceEvent): void;
}

let activeSink: ValidatorTraceSink | null = null;

/**
 * Register the active sink. Pass `null` to remove. Subsequent
 * {@link emitValidatorTraceEvent} calls dispatch to this sink.
 */
export function setValidatorTraceSink(sink: ValidatorTraceSink | null): void {
  activeSink = sink;
}

/** Read the active sink. Mostly for tests. */
export function getValidatorTraceSink(): ValidatorTraceSink | null {
  return activeSink;
}

/**
 * Internal — used by `runCheck`. No-op when no sink is registered.
 * Swallows sink-thrown errors (a broken devtools sink must not break
 * generation).
 */
export function emitValidatorTraceEvent(event: ValidatorTraceEvent): void {
  const sink = activeSink;
  if (!sink) return;
  try {
    sink.emit(event);
  } catch {
    // Devtools sink is allowed to be buggy — generation must not die.
  }
}

/**
 * Truncate a source string to ~16KB so a runaway component doesn't
 * blow the per-event memory budget. Adds a visible truncation marker.
 */
export function truncateSourceForTrace(source: string): string {
  const cap = 16 * 1024;
  if (source.length <= cap) return source;
  return source.slice(0, cap) + "\n\n/* … truncated for devtools trace … */";
}

/**
 * Crockford-style random ID. Same approach as the LLM trace sink —
 * dep-free for any runtime the harness might run in.
 */
export function newValidatorTraceId(): string {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}
