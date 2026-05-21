/**
 * Variant-selection seam types. Sister of {@link BlueprintSelector}
 * (which ships the deterministic ladder): variant selection is the
 * LLM-pick layer that lands AHEAD of the ladder when the matcher can
 * make a confident, context-aware choice. The deterministic ladder
 * remains the floor — when the LLM picks low-confidence (or no LLM is
 * bound), the ladder takes over.
 *
 * Three layers of this seam, top to bottom:
 *
 *   - {@link VariantSelectionContext} — per-call inputs: the
 *     `(intent, variance, contractHash)` triple plus any
 *     handshake-level signals the negotiator carries in.
 *   - {@link VariantSelectionDecision} — LLM-pick output: the chosen
 *     blueprintId + a confidence score + a human-readable reason.
 *   - {@link VariantSelectionCache} — cache for the LLM-pick across
 *     calls. Cache key is the `(contractHash, persona, context-hash)`
 *     triple; cache hits skip the round-trip.
 *
 * The orchestration that combines these — `selectVariantWithLlm` —
 * lives in `variant-selector-with-llm.ts`.
 */
import { canonicalizeValue } from '@ggui-ai/protocol';
import { createHash } from 'node:crypto';
import type { JsonObject } from '@ggui-ai/protocol';

/**
 * Per-call inputs to the LLM-driven variant pick. Carried through the
 * `decide()` seam on `HandshakeNegotiator` and surfaced to the
 * `selectVariant?()` extension.
 *
 * The fields are the same `(contractHash, variance, intent)` shape the
 * cache key derives from — so cache misses don't have to recover any
 * data the orchestration didn't already see.
 */
export interface VariantSelectionContext {
  /**
   * Canonical RFC 8785 (JCS) hash of the agent's draft contract. Equal
   * hashes mean the candidates are byte-exact same-contract variants
   * (different `generator` / `variance`); divergent hashes mean
   * the candidates came from {@link BlueprintSearch.search} above a
   * shape-equivalence threshold.
   *
   * The cache key prefixes on this field so cross-contract variant
   * choices don't collide.
   */
  readonly contractHash: string;
  /**
   * Concise semantic identity of the UI from the handshake input.
   * Drives the LLM's pick when the variance signals tie. The LLM
   * sees this verbatim — operator-facing tokenization happens only
   * on the cache-key side.
   */
  readonly intent?: string;
  /**
   * Variance signals from the agent's draft. The LLM compares these
   * to each candidate's `variance` tags and picks the closest match.
   * Note: `aesthetic` rides through as a free-form tag; on the
   * candidate side it lives in `variance.context.aesthetic`.
   */
  readonly variance?: {
    readonly persona?: string;
    readonly aesthetic?: string;
    readonly context?: JsonObject;
    readonly seedPrompt?: string;
  };
}

/**
 * Output of the LLM-pick step. The orchestration in
 * {@link selectVariantWithLlm} treats `confidence < CONFIDENCE_THRESHOLD`
 * as a fall-through trigger to the deterministic ladder, so the
 * implementation MUST surface a calibrated `[0, 1]` confidence — a
 * naive impl that always returns `1.0` defeats the fallback.
 */
export interface VariantSelectionDecision {
  /**
   * The chosen blueprint's id. MUST be one of the
   * `candidates[*].blueprintId` values the LLM was shown — the
   * orchestration validates membership before honoring the decision
   * (a hallucinated id falls through to the ladder).
   */
  readonly blueprintId: string;
  /**
   * `[0, 1]` confidence the implementation has in this pick.
   * `0` ≡ "I have no clue, fall through"; `1` ≡ "definite".
   * The orchestration thresholds against
   * {@link DEFAULT_VARIANT_SELECTION_CONFIDENCE_THRESHOLD}.
   */
  readonly confidence: number;
  /**
   * Human-readable rationale. Surfaced on the suggestion's
   * `blueprintMeta.selectedReason` field + the variant-selection
   * telemetry record.
   */
  readonly reason: string;
}

/**
 * Cache for the LLM-pick. Keyed by
 * `(contractHash, persona, context-hash)` per the plan's risk
 * register ("LLM sees ≤5 candidates per call; cache the decision
 * keyed on `(contractHash, persona, context-hash)`").
 *
 * Bounded by TTL on production impls (Redis with `EX` set). The
 * in-memory reference impl uses lazy expiry on read.
 *
 * The cache MUST NOT cross app boundaries — operators wire one cache
 * per app, or the cache key prefixes on `appId` implicitly via the
 * `contractHash` (which is itself per-app scoped via the
 * {@link BlueprintStore} tenancy lookup). Either is correct.
 */
export interface VariantSelectionCache {
  /**
   * Read a cached decision by key. Returns `null` on miss or expiry.
   * The orchestration validates the cached `blueprintId` against the
   * current candidate list before honoring the hit — a stale cache
   * entry pointing at a deleted blueprint falls through to a fresh
   * LLM pick.
   */
  get(key: string): Promise<VariantSelectionCacheEntry | null>;
  /**
   * Write a decision under `key`. The optional `ttlSec` lets the
   * orchestration tune lifetime per call; defaults to the cache
   * impl's own default when omitted.
   */
  put(
    key: string,
    entry: VariantSelectionCacheEntry,
    opts?: { readonly ttlSec?: number },
  ): Promise<void>;
}

/**
 * Cache row. Carries enough metadata for the orchestration to thread
 * telemetry on a cache-hit (the reason gets surfaced as the new
 * `selectedReason` even when the LLM didn't run for this call).
 */
export interface VariantSelectionCacheEntry {
  readonly blueprintId: string;
  readonly reason: string;
  /**
   * Round-tripped from the LLM-pick that produced this entry. The
   * orchestration surfaces this on telemetry so cache hits and fresh
   * LLM picks share the same observability shape.
   */
  readonly confidence: number;
}

/**
 * Default minimum confidence the orchestration accepts from an LLM
 * pick. Below this, fall through to the deterministic ladder.
 *
 * `0.6` is a deliberate midpoint: high enough that low-info picks
 * (model hallucinating a candidate, repeating the first id, etc.)
 * fall through; low enough that the LLM's typical "I'm pretty sure
 * but not certain" reads as a hit.
 *
 * Operators tune this via the orchestration's `confidenceThreshold`
 * option when the default doesn't fit their model's calibration.
 */
export const DEFAULT_VARIANT_SELECTION_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Default per-entry TTL on the variant-selection cache. The decision
 * is sticky for ten minutes — matches the handshake record TTL so
 * a session that re-handshakes inside its own window doesn't have to
 * re-run the LLM pick.
 *
 * Operators tune via the impl's constructor or per-call `ttlSec`.
 */
export const DEFAULT_VARIANT_SELECTION_CACHE_TTL_SEC = 600;

/**
 * Max number of candidates the orchestration shows the LLM per call.
 * Per the plan's risk register: "Pre-filter candidates by tier +
 * non-draft status; LLM sees ≤5 candidates per call."
 *
 * Pre-filter strategy: keep `isOperatorDefault === true` candidates
 * (always), then top-up by `validatorScore desc` until the limit is
 * reached. The remaining candidates fall back to the ladder
 * (deterministic) — they don't disappear, the LLM just doesn't see
 * them.
 */
export const DEFAULT_VARIANT_SELECTION_SHORTLIST_SIZE = 5;

/**
 * Derive the cache key for the variant-selection cache. Triple is
 * `(contractHash, persona, context-hash)` per the plan's risk
 * register; deterministic on identical inputs.
 *
 * `persona` is taken from `context.variance.persona` (free-form
 * string, lowercased + trimmed for collision resistance — operators
 * authoring `'Minimalist'` vs `'minimalist'` should share a cache
 * entry).
 *
 * `context-hash` is the first 16 hex chars of `sha256(JCS(variance))`.
 * The full variance object — including aesthetic + context +
 * seedPrompt — rides the hash so cache hits are precise.
 *
 * Pure / deterministic. Exposed so cloud cache adapters round-trip
 * keys identically to the in-memory reference.
 */
export function computeVariantSelectionCacheKey(
  context: VariantSelectionContext,
): string {
  const personaSegment = (context.variance?.persona ?? '').toLowerCase().trim();
  // Canonicalize the variance object MINUS `persona` — persona rides
  // through the dedicated key segment above (normalized
  // lowercase + trim for collision resistance). Hashing the raw
  // persona again here would fragment cache hits across
  // capitalization variants.
  //
  // The remaining variance fields (aesthetic, context, seedPrompt)
  // ride the hash so cache hits are precise — different
  // contexts/seedPrompts still produce distinct cache rows even when
  // persona is identical.
  //
  // Intent is NOT in the cache key (per the brief: "(contractHash,
  // persona, context-hash)") — the LLM's pick is keyed on identity
  // signals, not raw natural-language intent prose which has high
  // entropy.
  const varianceWithoutPersona = stripPersona(context.variance);
  const varianceCanonical = canonicalizeValue(varianceWithoutPersona);
  const varianceJson =
    varianceCanonical === undefined ? '{}' : JSON.stringify(varianceCanonical);
  const contextHash = createHash('sha256')
    .update(varianceJson)
    .digest('hex')
    .slice(0, 16);
  return `${context.contractHash}:${personaSegment}:${contextHash}`;
}

function stripPersona(
  variance: VariantSelectionContext['variance'],
): Omit<NonNullable<VariantSelectionContext['variance']>, 'persona'> {
  if (!variance) return {};
  const { persona: _persona, ...rest } = variance;
  return rest;
}
