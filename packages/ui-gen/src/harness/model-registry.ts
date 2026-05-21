// Per-model harness overrides — a git-committed TS const map.
//
// The registry is the source of truth for "what harness does model X get?".
// Unknown models fall through to DEFAULT_CONTEXT_POLICY (no-op, matches the
// pre-registry behavior byte-for-byte).
//
// Why a file and not a database:
//   - Reviewable via PR — every registry change is a code change.
//   - Type-checked — schema drift fails the build.
//   - Versioned with the harness it configures — no runtime/schema skew.
//   - Self-documenting — each entry carries the benchmark data that
//     justifies the override, right next to the override itself.
//
// How entries graduate:
//   1. A scheduled benchmark runs the current corpus against each known
//      model × candidate override.
//   2. An override must pass every pre-registered quality gate.
//   3. The benchmark emits a registry patch (a diff against this file).
//   4. A human reviews + merges the PR. Each merged entry records its
//      metric deltas in the preceding comment block.
//
// How entries are retired:
//   - When a subsequent default change subsumes an override (for
//     example, shipping `codeFormat: "flat"` as the default absorbed an
//     earlier per-model override), the benchmark flags the override as
//     no longer needed and a removal PR is opened with the
//     revalidation data as the rationale.
//
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextPolicy } from "./policy.js";

/**
 * Partial override of the default context policy for a specific model.
 * Missing fields inherit from `DEFAULT_CONTEXT_POLICY`.
 */
export type ModelHarnessOverride = Partial<ContextPolicy>;

/**
 * Registry of per-model overrides. Keys are model ids as reported by
 * `RuntimeCtx.modelId` (i.e. the string passed to the provider SDK, not the
 * provider's display name). Unknown ids fall through to default resolution.
 *
 * Empty by design at launch — the scheduled bench populates this as
 * experiments validate. Every entry must cite the experiment that
 * justified it (exp #, date, gate results) in a preceding comment block.
 */
export const MODEL_HARNESS_REGISTRY: Readonly<Record<string, ModelHarnessOverride>> =
  Object.freeze({
    // No entries yet. Seed candidates from session 2026-04-16 below are
    // tracked here for context but NOT shipped — they failed gates under
    // current defaults.
    //
    // ─────────────────────────────────────────────────────────────────
    // CANDIDATE (NOT SHIPPED): "gemini-3.1-flash-lite-preview"
    //   exp: #53 (hashline-v2) — initial signal −38% ms
    //   later: #67 (per-provider-hashline-v1, 2026-04-16) — FALSIFIED
    //   reason: #53's win was already subsumed by codeFormat:"flat"
    //           shipped as default in #60. Under current defaults the
    //           hashline re-application produces no additional win and
    //           adds OpenAI stale-rate cost. Override retired.
    //
    // CANDIDATE (NOT SHIPPED): "gpt-5.4-mini"
    //   exp: #53 signal (-32% ms, +9 score)
    //   later: #67 — FALSIFIED (12% HASHLINE_STALE rate blocked G2)
    //   reason: same as above — subsumed by #60 default flat-code schema.
    //
    // Narrow-merge candidate (#48, 2026-04-16) — asymmetric win
    // on hard slice (Google −46% ms, OpenAI −27% ms, Claude flat −3pt
    // score). Per-provider or per-model routing deferred pending
    // universal-bench non-regression gate + decision on whether to
    // fire the scaffold-narrowing axis as a default vs a routed override.
  });

/**
 * Look up a per-model override. Returns `undefined` when the model is
 * unknown — caller should fall through to default resolution.
 *
 * Pure function, no side effects, no I/O — the registry is compiled in.
 */
export function resolveModelOverride(
  modelId: string | undefined,
): ModelHarnessOverride | undefined {
  if (!modelId) return undefined;
  return MODEL_HARNESS_REGISTRY[modelId];
}
