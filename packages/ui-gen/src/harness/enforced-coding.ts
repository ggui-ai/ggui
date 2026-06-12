// packages/ui-gen/src/harness/enforced-coding.ts
//
// Provider-name mapping shared by the harness coding session
// (`harness/coding/init-session.ts`, `harness/coding/run-eval-round.ts`).
//
// The text-only enforced coding loop that used to live here
// (`runEnforcedCodingLoop` + its prompt builders) was superseded by the
// tool-driven loop in `harness/coding/run-coding-turn.ts` and deleted.

// =============================================================================
// Provider Mapping
// =============================================================================

/**
 * Map AgentConfig provider names ('anthropic') to evaluator provider names ('claude').
 * The evaluator.ts uses 'claude' | 'openai' | 'google', while AgentConfig uses 'anthropic' | 'openai' | 'google'.
 */
export function mapProviderForEvaluator(provider: 'anthropic' | 'openai' | 'google' | 'openrouter'): 'claude' | 'openai' | 'google' | 'openrouter' {
  return provider === 'anthropic' ? 'claude' : provider;
}
