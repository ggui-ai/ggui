/**
 * v0 seed corpus — 3 cases.
 *
 * Each case carries:
 *   - `seedEntries`: vectors pre-populated in the VectorStore
 *     before `negotiate()` runs. `[]` for the empty-registry case.
 *   - `prompt`: the natural-language query the case fires at the
 *     negotiator.
 *   - `expectedBlueprintId`: the blueprint the case expects the
 *     negotiator to retrieve (`null` on miss cases).
 *   - `expectedOutcome`: pre-registered ground truth.
 *
 * Why no multi-registry / arbitration case? The current
 * `negotiate()` signature takes a single `VectorStore`. Arbitration
 * across multiple stores is roadmap (§6.9 RAG partitioning per
 * MEMORY.md). When it lands, add a fourth case here; the schema
 * already has an `arbitrationObserved` slot reserved on the tags.
 */

import type { ExpectedOutcome, RegistryMode } from './types.js';

/**
 * Pre-populated blueprint entry the runner writes into the
 * VectorStore before `negotiate()` fires. v0 needs a stable shape
 * shared across cases; the runner expands this into the
 * VectorStore's `VectorEntry` + the metadata the negotiator's
 * RAG search path reads.
 */
export interface BlueprintSeedEntry {
  /**
   * Stable id the corpus labels against (the `expectedBlueprintId`).
   * Prefix convention: `p_` marks a "registered / private" blueprint
   * (returned identity by the negotiator). Bare ids get auto-
   * prefixed with `c_` on the way out, which confuses labeling —
   * v0 corpus sticks to `p_` so expected == observed.
   */
  readonly blueprintId: string;
  /** Prompt the entry represents — shapes the embedded vector. */
  readonly prompt: string;
  /** Category the entry belongs to (e.g., 'form', 'list'). */
  readonly category: string;
}

export interface NegotiationCase {
  readonly id: string;
  readonly registryMode: RegistryMode;
  readonly expectedOutcome: ExpectedOutcome;
  readonly expectedBlueprintId: string | null;
  /** Vectors pre-loaded into the store for this case. */
  readonly seedEntries: readonly BlueprintSeedEntry[];
  /** The prompt fed into the negotiator. */
  readonly prompt: string;
}

export const BLUEPRINT_NEGOTIATION_V0_CASES: readonly NegotiationCase[] = [
  // ── Case 1: clear hit ─────────────────────────────────────────
  // Query matches the seed's prompt VERBATIM — the bench's
  // orthogonal embedder produces cosine 1.0 on identical strings,
  // which routes through the negotiator's fast path. This makes
  // the hit deterministic: exact-match retrieval is what's under
  // test, not semantic similarity math (that's the real embedder's
  // job in production; we stub it here for label reliability).
  {
    id: 'clear-hit-feedback-form',
    registryMode: 'hosted',
    expectedOutcome: 'hit',
    expectedBlueprintId: 'p_feedback-form',
    seedEntries: [
      {
        blueprintId: 'p_feedback-form',
        prompt: 'collect customer feedback form with rating and comment',
        category: 'form',
      },
      // Distractors — present in the store so the ranking/dedup
      // paths still run. With the orthogonal embedder, they score
      // cosine 0 against the hit prompt and get filtered out.
      {
        blueprintId: 'p_login-form',
        prompt: 'sign in with email and password',
        category: 'form',
      },
      {
        blueprintId: 'p_product-list',
        prompt: 'show a list of products with prices',
        category: 'list',
      },
    ],
    prompt: 'collect customer feedback form with rating and comment',
  },

  // ── Case 2: clean miss (registry populated, nothing relevant) ──
  {
    id: 'clean-miss-nothing-relevant',
    registryMode: 'hosted',
    expectedOutcome: 'miss',
    expectedBlueprintId: null,
    // Store has entries, but none match the prompt's intent.
    // Tests that the negotiator gates on relevance, not presence.
    seedEntries: [
      {
        blueprintId: 'p_calendar-view',
        prompt: 'display a calendar with events',
        category: 'display',
      },
      {
        blueprintId: 'p_chat-interface',
        prompt: 'real-time chat with message history',
        category: 'conversation',
      },
    ],
    prompt: 'render a periodic table of chemical elements',
  },

  // ── Case 3: empty-registry miss (clean miss on zero entries) ──
  // Per v0 discipline: this is a SUCCESS case, not a failure. The
  // negotiator should recognize "nothing to retrieve" and return
  // a clean miss instead of inventing a match.
  {
    id: 'empty-registry-miss',
    registryMode: 'empty',
    expectedOutcome: 'miss',
    expectedBlueprintId: null,
    seedEntries: [],
    prompt: 'collect customer feedback',
  },
];
