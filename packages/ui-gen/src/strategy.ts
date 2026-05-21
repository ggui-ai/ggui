/**
 * Generation strategy types — controls how aggressive the generator is
 * about reusing blueprints vs generating fresh code.
 *
 * - strict: Blueprints only, no generation (maxTurns=0)
 * - balanced: Blueprints preferred, generate if needed (maxTurns=45)
 * - creative: Agent always decides, push aesthetics (maxTurns=90)
 */

export type StrategyName = 'strict' | 'balanced' | 'creative';

/**
 * Blueprint policy for generation strategies.
 * - only: Use blueprints only, fail if no match
 * - preferred: Prefer blueprints, generate if no match
 * - reference: Use blueprints as reference, agent decides
 */
export type BlueprintPolicy = 'only' | 'preferred' | 'reference';

export interface StrategyConfig {
  readonly name: StrategyName;
  readonly maxTurns: number;
  readonly blueprintPolicy: BlueprintPolicy;
  readonly bypassAgentOnExactMatch: boolean;
}

export const STRATEGIES: Record<StrategyName, StrategyConfig> = {
  strict: {
    name: 'strict',
    maxTurns: 0,
    blueprintPolicy: 'only',
    bypassAgentOnExactMatch: true,
  },
  balanced: {
    name: 'balanced',
    maxTurns: 45,
    blueprintPolicy: 'preferred',
    bypassAgentOnExactMatch: true,
  },
  creative: {
    name: 'creative',
    maxTurns: 90,
    blueprintPolicy: 'reference',
    bypassAgentOnExactMatch: false,
  },
};

/**
 * Match type for generation metrics — describes how the final UI was
 * produced (cache hit, blueprint match variant, or full generation).
 */
export type MatchType =
  | 'exact'
  | 'cached'
  | 'predefined'
  | 'partial_reuse'
  | 'generated';
