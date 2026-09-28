// packages/ui-gen/src/evaluation/cost-tracker.ts
//
// Per-generation cost tracker.
// Records LLM token usage across all calls in a generation pipeline
// and enforces an optional budget ceiling.

import { MODEL_REGISTRY, type ModelId } from '@ggui-ai/protocol';

/**
 * Resolve a bare wire model id (what the generation pipeline reports —
 * `gpt-5.6-luna`, `claude-haiku-4-5-20251001`) to a LiteLLM-keyed
 * {@link MODEL_REGISTRY} entry (`openai/gpt-5.6-luna`,
 * `anthropic/claude-haiku-4-5`).
 *
 * This table used to hand-maintain its own per-1K prices, and drifted:
 * on 2026-07-31 four of its six rows were wrong (Haiku 4.5 20% low,
 * gemini-3-flash-preview 5-7x low, gpt-5.4-mini ~3x low, Luna 5x high
 * after OpenAI's cut). Deriving from the registry — whose Anthropic rows
 * `@ggui-ai/protocol`'s own tests pin — means one place to update and one place that can be wrong.
 *
 * Resolution order mirrors the benchmark harness's
 * `resolveJudgeCostModelId`: exact key, unique `/<model>` suffix, then
 * the same suffix match with a trailing `-YYYYMMDD` date pin stripped.
 */
function resolveRegistryId(model: string): ModelId | null {
  const keys = Object.keys(MODEL_REGISTRY) as ModelId[];
  if ((keys as string[]).includes(model)) return model as ModelId;
  const bySuffix = keys.find((id) => id.endsWith(`/${model}`));
  if (bySuffix) return bySuffix;
  const undated = model.replace(/-\d{8}$/, '');
  return keys.find((id) => id.endsWith(`/${undated}`)) ?? null;
}

/**
 * ggui#1524 — the largest cache-WRITE premium any registry model states (`cacheWritePer1M / inputPer1M`), never
 * below 1. A cost CAP errs toward over-counting, so a model that states no write rate is priced at this bound
 * times its input rate: a write costs a premium over input wherever one is charged, and pricing it at the bare
 * input rate would slip that premium under the cap. Derived from the registry, so it moves with it.
 */
export const CACHE_WRITE_PREMIUM_BOUND: number = Math.max(
  1,
  ...Object.values(MODEL_REGISTRY).flatMap(({ costs }) =>
    costs.cacheWritePer1M !== undefined && costs.inputPer1M > 0 ? [costs.cacheWritePer1M / costs.inputPer1M] : [],
  ),
);

/** Per-1K USD for each kind of token a call can spend. */
export interface PricePer1k {
  readonly input: number;
  readonly output: number;
  /** Cache reads: the model's stated rate, else its input rate — over-counts a read, the safe side for a cap. */
  readonly cacheRead: number;
  /** Cache writes: the model's stated rate, else its input rate × {@link CACHE_WRITE_PREMIUM_BOUND}. */
  readonly cacheWrite: number;
}

/** Fallback when a model has no registry entry — Sonnet-class rates. */
const FALLBACK_PER_1K: PricePer1k = {
  input: 0.003,
  output: 0.015,
  cacheRead: 0.003,
  cacheWrite: 0.003 * CACHE_WRITE_PREMIUM_BOUND,
};

/** Per-1K USD for a bare wire model id: input, output, and the two cache kinds. */
export function pricePer1k(model: string): PricePer1k {
  const id = resolveRegistryId(model);
  if (id === null) return FALLBACK_PER_1K;
  const { costs } = MODEL_REGISTRY[id];
  return {
    input: costs.inputPer1M / 1000,
    output: costs.outputPer1M / 1000,
    cacheRead: (costs.cacheReadPer1M ?? costs.inputPer1M) / 1000,
    cacheWrite: (costs.cacheWritePer1M ?? costs.inputPer1M * CACHE_WRITE_PREMIUM_BOUND) / 1000,
  };
}

/** ggui#1524 — the cache tokens a call spent, as its provider reported them; absent = unreported. */
export interface CacheSpend {
  readonly read?: number;
  readonly write?: number;
}

export class CostTracker {
  private totalCost = 0;

  constructor(private maxBudget: number | null) {}

  /**
   * Record one call. `inputTokens` is the provider's UNCACHED input; a call that read or wrote the prompt cache
   * passes those counts in `cache` (ggui#1524), priced at the cache rates — until then a turn with a long cached
   * prefix cost the cap almost nothing while the provider billed its reads and writes.
   */
  record(model: string, inputTokens: number, outputTokens: number, cache: CacheSpend = {}): number {
    const prices = pricePer1k(model);
    const cost =
      (inputTokens / 1000) * prices.input +
      (outputTokens / 1000) * prices.output +
      ((cache.read ?? 0) / 1000) * prices.cacheRead +
      ((cache.write ?? 0) / 1000) * prices.cacheWrite;
    this.totalCost += cost;
    return cost;
  }

  canContinue(): boolean {
    if (this.maxBudget === null) return true;
    return this.totalCost < this.maxBudget;
  }

  getTotal(): number {
    return this.totalCost;
  }

  getRemaining(): number | null {
    if (this.maxBudget === null) return null;
    return Math.max(0, this.maxBudget - this.totalCost);
  }
}
