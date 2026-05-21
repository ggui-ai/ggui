// packages/ui-gen/src/evaluation/cost-tracker.ts
//
// Per-generation cost tracker.
// Records LLM token usage across all calls in a generation pipeline
// and enforces an optional budget ceiling.

const PRICE_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'claude-haiku-4-5-20251001': { input: 0.0008, output: 0.004 },
  'gemini-3-flash-preview': { input: 0.0001, output: 0.0004 },
  'gpt-5.4-mini': { input: 0.0003, output: 0.0012 },
};

export class CostTracker {
  private totalCost = 0;

  constructor(private maxBudget: number | null) {}

  record(model: string, inputTokens: number, outputTokens: number): number {
    const prices = PRICE_PER_1K_TOKENS[model] ?? { input: 0.003, output: 0.015 };
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
