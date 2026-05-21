/**
 * `BlueprintSelector` — variant-pick seam. When the handshake handler
 * resolves a contract hash to a candidate list via
 * {@link BlueprintStore.list}, the selector decides which variant the
 * push handler renders.
 *
 * The default implementation is a deterministic fallback ladder. An
 * LLM-driven selector can layer ahead of step (1) — when the LLM
 * picks confidently, use it; otherwise fall through to the
 * deterministic ladder. The deterministic floor never disappears.
 *
 * Ladder (deterministic):
 *
 *   1. find candidate where `isOperatorDefault === true`
 *   2. else sort by `validatorScore` desc, first non-null
 *   3. else sort by `createdAt` desc, first
 *   4. else sort by `blueprintId` asc (deterministic tiebreaker)
 *
 * The ladder always picks one variant when the candidate list is
 * non-empty; an empty list resolves to `null` (the push handler
 * branches on this and triggers fresh generation against a freshly
 * minted blueprintId).
 */
import type { Blueprint } from '@ggui-ai/protocol';

/**
 * Request context handed to {@link BlueprintSelector.selectVariant}.
 * Currently an empty marker interface; an LLM-driven selector can
 * widen it with the negotiator's intent / hint / persona signals.
 * Adapters can be authored against this shape today without breaking
 * when those fields land.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- marker interface; an LLM-driven selector widens it.
export interface BlueprintSelectorContext {
  // intentionally empty — see file-level docstring.
}

/**
 * Seam for picking one blueprint from a candidate list. Operators
 * MAY swap the default deterministic selector for an LLM-backed one
 * without changing the surrounding code path.
 */
export interface BlueprintSelector {
  /**
   * Pick one blueprint from `candidates`. Returns `null` iff
   * `candidates` is empty.
   *
   * Implementations MUST be deterministic on identical inputs — the
   * fallback ladder's step 4 (lexicographic `blueprintId`) is the
   * guaranteed tiebreaker. Non-deterministic variants of this seam
   * (LLM-backed, telemetry-weighted) MUST cache their decision so
   * the same call with the same inputs returns the same blueprint
   * within a request lifetime; cross-request determinism is not
   * required.
   */
  selectVariant(
    candidates: readonly Blueprint[],
    context?: BlueprintSelectorContext,
  ): Blueprint | null;
}

/**
 * Factory for the v1 deterministic selector. Implements the four-step
 * ladder above. Stateless — safe to share across requests.
 */
export function createDeterministicBlueprintSelector(): BlueprintSelector {
  return {
    selectVariant(candidates) {
      if (candidates.length === 0) return null;

      // Step 1 — operator default.
      const opDefault = candidates.find((c) => c.isOperatorDefault === true);
      if (opDefault) return opDefault;

      // Step 2 — highest validator score, ignoring undefined.
      let bestScore: Blueprint | null = null;
      for (const c of candidates) {
        if (typeof c.validatorScore !== 'number') continue;
        if (bestScore === null) {
          bestScore = c;
          continue;
        }
        const bs = bestScore.validatorScore;
        const cs = c.validatorScore;
        if (typeof bs !== 'number' || cs > bs) {
          bestScore = c;
        } else if (cs === bs) {
          // Tiebreak on createdAt desc, then blueprintId asc — keeps
          // the choice stable when two variants share the top score.
          if (c.createdAt > bestScore.createdAt) {
            bestScore = c;
          } else if (
            c.createdAt === bestScore.createdAt &&
            c.blueprintId < bestScore.blueprintId
          ) {
            bestScore = c;
          }
        }
      }
      if (bestScore) return bestScore;

      // Step 3 — newest createdAt (string ISO-8601 sorts
      // chronologically when both stamps are well-formed).
      let newest: Blueprint | null = null;
      for (const c of candidates) {
        if (newest === null || c.createdAt > newest.createdAt) {
          newest = c;
        } else if (
          c.createdAt === newest.createdAt &&
          c.blueprintId < newest.blueprintId
        ) {
          newest = c;
        }
      }
      if (newest) return newest;

      // Step 4 — lexicographic blueprintId fallback. Only reachable
      // when all candidates share the same createdAt AND none carry
      // a validatorScore; the linear scan above already produces
      // the right answer, so this branch is theoretical. Kept so the
      // ladder's four steps are all explicit in code.
      let lex: Blueprint | null = null;
      for (const c of candidates) {
        if (lex === null || c.blueprintId < lex.blueprintId) lex = c;
      }
      return lex;
    },
  };
}
