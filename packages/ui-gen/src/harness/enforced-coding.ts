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

/**
 * The visual judge's provider for an agent's provider (ggui#1248) — only the
 * providers whose SDK path takes an image (`createVisionAgent`: Anthropic,
 * Google). `undefined` for a provider with no vision path, so a caller must
 * decide what the visual leg does there instead of asserting it away: the
 * in-loop judge inherits the generation's agent by default, and an OpenAI or
 * OpenRouter lane reaching `createVisionAgent` got `undefined` back and threw.
 */
export function visionJudgeProvider(provider: 'anthropic' | 'openai' | 'google' | 'openrouter'): 'claude' | 'google' | undefined {
  switch (provider) {
    case 'anthropic':
      return 'claude';
    case 'google':
      return 'google';
    case 'openai':
    case 'openrouter':
      return undefined;
  }
}
