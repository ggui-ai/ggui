/**
 * Variant-selector orchestration.
 *
 * `selectVariantWithLlm` combines an LLM-pick step, a cache, and the
 * deterministic ladder fallback ({@link BlueprintSelector}) into a
 * single addressable seam, layered over the deterministic ladder:
 *
 * ```
 *   candidates → pre-filter (≤ shortlistSize) → cache lookup
 *       ├── cache hit  ⇒ return cached blueprint (source: 'llm')
 *       ├── cache miss ⇒ LLM pick
 *             ├── confidence ≥ threshold ⇒ return + cache (source: 'llm')
 *             └── confidence <  threshold ⇒ fall through to ladder
 *       └── ladder fallback ⇒ {@link BlueprintSelector.selectVariant}
 * ```
 *
 * The deterministic ladder is the LOAD-BEARING FLOOR: when the LLM is
 * absent, low-confidence, or hallucinates a blueprintId not in the
 * candidate list, the ladder takes over and a deterministic answer
 * still flows out. Layered, never replaced.
 *
 * Pre-filter strategy: always keep candidates with `isOperatorDefault
 * === true`, then top up the shortlist by `validatorScore desc` until
 * the limit is reached. Operator pins always survive the cut so the
 * LLM can defer to them; the remaining candidates fall back to the
 * ladder when they're not chosen.
 */
import type { Blueprint } from '@ggui-ai/protocol';
import type { BlueprintSelector } from './blueprint-selector.js';
import {
  DEFAULT_VARIANT_SELECTION_CONFIDENCE_THRESHOLD,
  DEFAULT_VARIANT_SELECTION_SHORTLIST_SIZE,
  computeVariantSelectionCacheKey,
  type VariantSelectionCache,
  type VariantSelectionContext,
  type VariantSelectionDecision,
} from './variant-selection.js';

/**
 * LLM-pick function. The orchestration treats this as opaque — any
 * implementation that reads the candidate list + context and produces
 * a {@link VariantSelectionDecision} satisfies the seam. In practice
 * this is the negotiator's `selectVariant` method (see
 * `@ggui-ai/mcp-server-handlers/HandshakeNegotiator.selectVariant?`),
 * but the seam is intentionally narrow so tests can inject a
 * deterministic pick fn without spinning up an LLM.
 */
export type VariantSelectionPickFn = (input: {
  readonly candidates: readonly Blueprint[];
  readonly context: VariantSelectionContext;
}) => Promise<VariantSelectionDecision>;

/**
 * Composite result of {@link selectVariantWithLlm}. Always returns a
 * blueprint (or `null` when the candidate list was empty). The
 * `source` discriminator anchors telemetry — operators tune the
 * LLM-pick cost / ladder-fallback frequency from this signal.
 */
export interface VariantSelectionResult {
  /** The chosen blueprint. `null` iff the input candidate list was empty. */
  readonly blueprint: Blueprint | null;
  /**
   * Where the pick came from:
   *
   *   - `'llm'`    — fresh LLM-pick above the confidence threshold.
   *   - `'cache'`  — a previously-stored LLM pick (cache hit).
   *   - `'ladder'` — deterministic ladder fallback. Fires on
   *                  empty candidates, single-candidate
   *                  short-circuit, no LLM bound, LLM
   *                  low-confidence, or LLM hallucination
   *                  (blueprintId not in candidate set).
   */
  readonly source: 'llm' | 'cache' | 'ladder';
  /** Human-readable rationale — surfaced on `blueprintMeta.selectedReason`. */
  readonly reason: string;
  /**
   * `[0, 1]` confidence carried from the LLM-pick (or 1.0 from
   * cache; `undefined` on ladder fallback since the deterministic
   * ladder doesn't expose a confidence axis).
   */
  readonly confidence?: number;
}

/**
 * Configuration for the orchestration. All fields optional —
 * sensible defaults from the {@link variant-selection} module
 * constants ride through when omitted.
 */
export interface VariantSelectorWithLlmOptions {
  /**
   * Minimum LLM confidence the orchestration honors. Below this,
   * fall through to the deterministic ladder. Defaults to
   * {@link DEFAULT_VARIANT_SELECTION_CONFIDENCE_THRESHOLD}.
   */
  readonly confidenceThreshold?: number;
  /**
   * Maximum candidates the LLM sees per call. Pre-filter keeps the
   * operator-default + top-`validatorScore` candidates; remaining
   * candidates fall back to the ladder. Defaults to
   * {@link DEFAULT_VARIANT_SELECTION_SHORTLIST_SIZE}.
   */
  readonly shortlistSize?: number;
}

/**
 * Run the variant-selection orchestration. Returns a
 * {@link VariantSelectionResult} carrying the chosen blueprint + the
 * source enum + a human-readable reason.
 *
 * The orchestration is fail-open: any error from the LLM-pick fn
 * (network flap, provider 5xx) falls through to the ladder. The
 * caller never sees an exception unless the underlying ladder itself
 * throws — which it MUST NOT (the deterministic ladder is total on
 * non-empty input).
 *
 * Determinism: given identical inputs (same candidate list + same
 * context + same cache state + same LLM pick), the function is
 * deterministic. The LLM-pick fn is the only non-deterministic
 * component; the cache acts as a determinism dampener for repeated
 * calls within the cache window.
 */
export async function selectVariantWithLlm(
  candidates: readonly Blueprint[],
  context: VariantSelectionContext,
  deps: {
    readonly pickFn: VariantSelectionPickFn | undefined;
    readonly ladder: BlueprintSelector;
    readonly cache?: VariantSelectionCache;
  },
  opts: VariantSelectorWithLlmOptions = {},
): Promise<VariantSelectionResult> {
  const threshold =
    opts.confidenceThreshold ??
    DEFAULT_VARIANT_SELECTION_CONFIDENCE_THRESHOLD;
  const shortlistSize =
    opts.shortlistSize ?? DEFAULT_VARIANT_SELECTION_SHORTLIST_SIZE;

  // Empty candidates → no work to do. Return the ladder's `null`.
  if (candidates.length === 0) {
    return {
      blueprint: null,
      source: 'ladder',
      reason: 'empty candidate list',
    };
  }

  // Single candidate → ladder short-circuit. Cheap, deterministic,
  // saves an LLM round-trip when the matcher's search returned just
  // one blueprint.
  if (candidates.length === 1) {
    return {
      blueprint: candidates[0]!,
      source: 'ladder',
      reason: 'single candidate — no selection needed',
    };
  }

  // No LLM-pick fn bound → straight to the ladder. The deterministic
  // floor is the only path in this configuration.
  if (!deps.pickFn) {
    const pick = deps.ladder.selectVariant(candidates);
    return {
      blueprint: pick,
      source: 'ladder',
      reason: 'no LLM-pick fn bound — deterministic ladder fallback',
    };
  }

  // Cache lookup. Hits skip the LLM round-trip; miss + stale entries
  // fall through to a fresh LLM pick.
  const cacheKey = computeVariantSelectionCacheKey(context);
  if (deps.cache) {
    const hit = await deps.cache.get(cacheKey);
    if (hit) {
      const matched = candidates.find(
        (c) => c.blueprintId === hit.blueprintId,
      );
      if (matched) {
        return {
          blueprint: matched,
          source: 'cache',
          reason: `cache-hit: ${hit.reason}`,
          confidence: hit.confidence,
        };
      }
      // Stale cache entry — referenced blueprint no longer in the
      // candidate set (operator deleted / search reranked). Fall
      // through to a fresh LLM pick.
    }
  }

  // Pre-filter to ≤ shortlistSize candidates per the risk register
  // ("LLM sees ≤5 candidates per call").
  const shortlist = preFilterCandidates(candidates, shortlistSize);

  // LLM-pick. Errors fall through to the ladder — the caller never
  // sees an exception from this orchestration unless the ladder
  // itself throws.
  let decision: VariantSelectionDecision;
  try {
    decision = await deps.pickFn({ candidates: shortlist, context });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const pick = deps.ladder.selectVariant(candidates);
    return {
      blueprint: pick,
      source: 'ladder',
      reason: `llm-pick error — ladder fallback: ${errMessage}`,
    };
  }

  // Validate the LLM's blueprintId is in the candidate set. A
  // hallucinated id falls through to the ladder.
  const matched = candidates.find(
    (c) => c.blueprintId === decision.blueprintId,
  );
  if (!matched) {
    const pick = deps.ladder.selectVariant(candidates);
    return {
      blueprint: pick,
      source: 'ladder',
      reason: `llm picked unknown blueprintId="${decision.blueprintId}" — ladder fallback`,
    };
  }

  // Low confidence → fall through to the deterministic ladder. The
  // LLM's "I'm not sure" reads as ladder-take-over rather than a
  // forced low-confidence pick.
  if (decision.confidence < threshold) {
    const pick = deps.ladder.selectVariant(candidates);
    return {
      blueprint: pick,
      source: 'ladder',
      reason: `llm-low-confidence (${decision.confidence.toFixed(2)} < ${threshold.toFixed(2)}): ${decision.reason} — ladder fallback`,
      confidence: decision.confidence,
    };
  }

  // Confident pick. Cache + return.
  if (deps.cache) {
    await deps.cache.put(cacheKey, {
      blueprintId: decision.blueprintId,
      reason: decision.reason,
      confidence: decision.confidence,
    });
  }
  return {
    blueprint: matched,
    source: 'llm',
    reason: decision.reason,
    confidence: decision.confidence,
  };
}

/**
 * Encode a {@link VariantSelectionResult} onto a single
 * `selectedReason` string suitable for `BlueprintMeta.selectedReason`.
 * Appends a `conf=<n>` suffix when the result carries confidence so
 * the handshake handler's telemetry can round-trip it.
 *
 * Convention: telemetry parsers regex `\bconf=([01](?:\.\d+)?|0?\.\d+)\b`
 * to extract the axis. The format is intentionally narrow + stable
 * so cross-impl consumers (cloud pod, OSS, future adapters) agree
 * on the on-wire shape without a typed protocol field.
 *
 * Pure / deterministic. Exposed so cloud adapters round-trip
 * identically.
 */
export function encodeSelectedReason(
  result: VariantSelectionResult,
): string {
  if (result.confidence === undefined) return result.reason;
  // Clamp to [0, 1] defensively — the matcher's regex rejects
  // out-of-range values but the encoder should never produce them.
  const clamped = Math.max(0, Math.min(1, result.confidence));
  // 2 decimal places — narrow enough to be parseable, wide enough
  // for operator-visible precision.
  return `${result.reason} conf=${clamped.toFixed(2)}`;
}

/**
 * Pre-filter the candidate list to at most `limit` entries. Keeps
 * every operator-default candidate (their pin is the strongest
 * signal); fills the remaining slots by `validatorScore desc` then
 * `createdAt desc` then `blueprintId asc` (lexicographic) — same
 * tiebreak order as the deterministic ladder, so the LLM sees the
 * same "preferred" candidates the ladder would.
 *
 * Exposed so cloud adapters can re-use the pre-filter helper when
 * authoring their own orchestration variants.
 */
export function preFilterCandidates(
  candidates: readonly Blueprint[],
  limit: number,
): readonly Blueprint[] {
  if (candidates.length <= limit) return candidates;
  const operatorPins = candidates.filter((c) => c.isOperatorDefault === true);
  const remaining = candidates.filter((c) => c.isOperatorDefault !== true);
  // Sort remaining by score desc, then createdAt desc, then
  // blueprintId asc. Mirrors the deterministic ladder's preference
  // order on non-pinned rows.
  const sorted = [...remaining].sort((a, b) => {
    const aScore = a.validatorScore ?? Number.NEGATIVE_INFINITY;
    const bScore = b.validatorScore ?? Number.NEGATIVE_INFINITY;
    if (aScore !== bScore) return bScore - aScore;
    if (a.createdAt !== b.createdAt) {
      return b.createdAt.localeCompare(a.createdAt);
    }
    return a.blueprintId.localeCompare(b.blueprintId);
  });
  return [...operatorPins, ...sorted].slice(0, limit);
}
