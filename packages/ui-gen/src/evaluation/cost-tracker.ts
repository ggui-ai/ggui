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

/** Fallback when a model has no registry entry — Sonnet-class rates. */
const FALLBACK_PER_1K = { input: 0.003, output: 0.015 };

/** Per-1K input/output USD for a bare wire model id. */
export function pricePer1k(model: string): { input: number; output: number } {
  const id = resolveRegistryId(model);
  if (id === null) return FALLBACK_PER_1K;
  const { costs } = MODEL_REGISTRY[id];
  return { input: costs.inputPer1M / 1000, output: costs.outputPer1M / 1000 };
}

export class CostTracker {
  private totalCost = 0;

  constructor(private maxBudget: number | null) {}

  record(model: string, inputTokens: number, outputTokens: number): number {
    const prices = pricePer1k(model);
    const cost = (inputTokens / 1000) * prices.input + (outputTokens / 1000) * prices.output;
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
