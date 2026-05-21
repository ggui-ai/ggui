// Duplicate-patch break.
//
// Failure mode this addresses: the LLM re-submits a byte-identical
// `apply_changes` patch after a PATCH_INVALID response, each time
// failing with the same esbuild error. The retry prompt looks similar
// enough that the model's output is effectively a fixed point.
//
// Detector: fingerprint each PATCH_INVALID turn by (normalized ranges,
// normalized code payload, error-class bucket). On match with the prior
// patch turn's fingerprint, flip `forceEscapeNextTurn` so the next turn
// is restricted to a narrow escape tool — escaping the loop. A cooldown
// prevents oscillation if the forced escape also fails.
//
// The escape tool that fires is `APPLY_CHANGES_TOOL_SCOPED` (a single
// change, ≤20 lines) — a narrow blast radius that preserves the rest of
// the file.
//
// All per-session state lives in `DupeBreakState`, attached to the
// `CodingSession` and mutated in place by `run-coding-turn`. Gated
// behind `ContextPolicy.breakDuplicatePatch`.

import { createHash } from "node:crypto";

/** Per-session dupe-break state machine. Mutated in place; initialize via
 *  {@link createDupeBreakState}. */
/** Compact summary of one prior failed patch, kept for diagnostic-mode
 *  retry-prompt enumeration. Bounded ring (cap 2 most-recent). */
export interface RecentFailedPatch {
  /** Sorted-then-joined ranges, e.g. `"47-47|71-75"`. Display-only. */
  rangesShort: string;
  /** First 200 chars of normalized code (joined). Display-only. */
  codeHead: string;
  /** Error-class bucket (see {@link errorClassBucket}). Display-only. */
  errClass: string;
  /** Full SHA-256 hex; the diagnostic prompt only shows the first 12 chars
   *  but the full hex is used to detect "next patch fingerprint differs"
   *  for Gate 2 of #43. */
  fingerprint: string;
}

export interface DupeBreakState {
  /** Fingerprint of the most recent PATCH_INVALID patch turn. `null` when
   *  there's no prior failure or the chain was broken by a success. */
  lastFailedPatchFingerprint: string | null;
  /** Set by detection (`escape` action); consumed by selectTurnTools on
   *  the next turn. */
  forceEscapeNextTurn: boolean;
  /** Set by detection (`diagnostic` action); consumed by run-coding-turn
   *  prompt assembly on the next turn. */
  pendingDiagnosticTurn: boolean;
  /** Turns remaining in the no-re-entry window after an intervention
   *  fires. Decrements on every turn; detection only fires when
   *  `cooldown === 0`. */
  cooldown: number;
  /** Number of times the dupe-break mechanism has fired this generation —
   *  telemetry / audit. Gate 1 (#42/#43): DUPLICATE_PATCH_BREAK count. */
  firedCount: number;
  /** #42 — count of forced-escape turns that emitted a conforming scoped
   *  tool call (1 change, ≤20 lines). Dormant under #43 profile. */
  scopedEscapeUsedCount: number;
  /** #43 — true when the immediately prior turn rendered the diagnostic
   *  retry prompt. Read by the post-tool-call block to score outcomes
   *  (`diagnosticReturnedCount`, `diagnosticBrokeLoopCount`). Cleared
   *  the same turn it's read. */
  awaitingDiagnosticOutcome: boolean;
  /** #43 — count of diagnostic-prompt renders this generation (Gate 1
   *  for the diagnostic profile). Should equal firedCount when
   *  `dupeBreakAction === "diagnostic"`. */
  diagnosticFiredCount: number;
  /** #43 — count of times the LLM's response after a diagnostic prompt
   *  included a parseable `DIAG:` commit_message (proxy for "did the
   *  model engage with the structured diagnosis request"). */
  diagnosticReturnedCount: number;
  /** #43 — count of times the next turn after a diagnostic prompt
   *  produced a DIFFERENT fingerprint (or a PASS). Gate 2 lever — if
   *  this lags `diagnosticFiredCount`, the lever didn't change
   *  reasoning state. */
  diagnosticBrokeLoopCount: number;
  /** Bounded ring of the last 2 failed-patch summaries, used to
   *  populate the diagnostic retry prompt. Newest first. */
  recentFailedPatches: RecentFailedPatch[];
  /** Count of consecutive PATCH_APPLIED_BROKEN results (apply-and-warn
   *  semantics). Resets on any clean apply. When ≥3, selectTurnTools
   *  advertises `REWRITE_TOOL` as the only authoring tool — an escape
   *  from a tangled broken workspace. */
  consecutiveBrokenApplies: number;
  /** Count of consecutive turns where the model returned zero tool
   *  calls. This can happen when turn 1 produces a broken patch
   *  (preflight fail) and turn 2 returns no tool call. A single
   *  no-tool-call returns "continue" so the outer loop re-prompts
   *  (with the prior broken-patch context still in scope). Two
   *  consecutive no-tool-calls breaks the loop — the model
   *  is genuinely stuck. */
  consecutiveNoToolCalls: number;
}

export function createDupeBreakState(): DupeBreakState {
  return {
    lastFailedPatchFingerprint: null,
    forceEscapeNextTurn: false,
    pendingDiagnosticTurn: false,
    cooldown: 0,
    firedCount: 0,
    scopedEscapeUsedCount: 0,
    awaitingDiagnosticOutcome: false,
    diagnosticFiredCount: 0,
    diagnosticReturnedCount: 0,
    diagnosticBrokeLoopCount: 0,
    recentFailedPatches: [],
    consecutiveBrokenApplies: 0,
    consecutiveNoToolCalls: 0,
  };
}

/** Structure of one change entry in an `apply_changes` tool call.
 *
 *  `code` should be `string[]` per the tool schema, but Google Gemini has
 *  been observed to emit a single `string` instead. Typed as the union so
 *  callers don't have to cast — {@link computePatchFingerprint} normalizes
 *  both shapes internally. */
export interface PatchChange {
  startLine: number;
  endLine: number;
  code: readonly string[] | string;
}

/**
 * Bucket an esbuild error message into a coarse class so "same patch,
 * different error" registers as distinct. Reads the first diagnostic
 * phrase (up to the first period or colon, lowercased, whitespace
 * collapsed). Stable across trivial line/column variations.
 */
export function errorClassBucket(errText: string): string {
  if (!errText) return "unknown";
  return errText
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * Compute a fingerprint of a failed `apply_changes` attempt.
 *
 * Three components, each normalized before hashing so trivial whitespace
 * shifts in the LLM's output don't dodge detection:
 *
 *   1. Ranges: sorted by startLine, serialized as `"47-47|71-75|89-89"`.
 *   2. Code:   per-change trim each line, drop empties, join with `\n`;
 *              changes joined with a separator. Captures the LLM's
 *              intent without penalizing trailing whitespace.
 *   3. Error:  {@link errorClassBucket} of the esbuild message.
 *
 * Full SHA-256 (hex). Short-hash for logging is the first 12 chars.
 */
export function computePatchFingerprint(
  changes: readonly PatchChange[],
  errText: string,
): string {
  // Sort BEFORE extracting ranges + code so a re-ordered changes array
  // with identical content produces an identical fingerprint.
  const sorted = [...changes].sort(
    (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
  );
  const normRanges = sorted.map((c) => `${c.startLine}-${c.endLine}`).join("|");
  const normCode = sorted
    .map((c) => {
      // Defensive: providers occasionally emit `code` as a single string
      // instead of `string[]` despite the schema (observed: Google Gemini
      // on apply_changes calls). Normalize both shapes here so the
      // fingerprint is provider-agnostic and never crashes.
      const lines = Array.isArray(c.code)
        ? c.code
        : typeof c.code === "string"
          ? [c.code]
          : [];
      return lines
        .map((line) => String(line).trim())
        .filter((line) => line.length > 0)
        .join("\n");
    })
    .join("\n---\n");
  const errBucket = errorClassBucket(errText);
  const h = createHash("sha256");
  h.update(normRanges);
  h.update("|");
  h.update(normCode);
  h.update("|");
  h.update(errBucket);
  return h.digest("hex");
}
