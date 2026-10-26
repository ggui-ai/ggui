// ggui#2010 — the eval round tells the visual leg whether this generation's prompt taught the offered-items choice
// fragment, so the no-truncate fix names the chip example only where the prompt carried it. Pinned at the seam: the
// context the round hands `runVisualFit` carries `offeredChoiceTaught` for an offered-items harness and not otherwise.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { CostTracker } from '../../evaluation/cost-tracker.js';
import { createHarness } from '../../create-harness.js';
import * as realLlmEvaluator from '../../evaluation/llm-evaluator.js';
import * as realVisualEvaluator from '../../evaluation/visual-evaluator.js';
import type { VisualEvalContext } from '../../evaluation/visual-evaluator.js';
import type { Classification } from '../../classifier/index.js';
import type { ChoiceShape } from '../../classifier/axes.js';
import type { AgentSpec } from '../runtime.js';
import type { EvalRoundContext, EvalRoundInput } from './run-eval-round.js';

const mockRunCheck = vi.fn();
vi.mock('../index.js', () => ({
  runCheck: (...args: unknown[]) => mockRunCheck(...args),
}));
const { runEvalRound } = await import('./run-eval-round.js');

function classification(choice: ChoiceShape): Classification {
  return {
    vector: { render: 'static', state: 'none', writes: 'submit', writeTrigger: 'click', realtime: 'none', fetch: 'none', layout: 'single', tooling: 'none', choice },
    provenance: { render: 'default', state: 'default', writes: 'default', writeTrigger: 'default', realtime: 'default', fetch: 'default', layout: 'default', tooling: 'default', choice: 'contract' },
    riskTier: 'medium',
  };
}

/** One eval round on a no-vision lane (the fit half alone), returning the context the round handed the visual leg. */
async function contextHandedToVisualLeg(choice: ChoiceShape): Promise<VisualEvalContext | undefined> {
  const seen: VisualEvalContext[] = [];
  const visualMod: typeof realVisualEvaluator = {
    ...realVisualEvaluator,
    runVisualFit: (context) => {
      seen.push(context);
      return Promise.resolve({ status: 'measured', issues: [], readings: [] });
    },
  };
  const c = classification(choice);
  const harness = createHarness({ classification: c, contract: {}, prompt: 'pick one' });
  const workspace = new AgentWorkspace();
  await workspace.init();
  const compiledCode = 'export default function C() { return null; }';
  workspace.write(compiledCode);
  const ctx: EvalRoundContext = {
    workspace,
    harness,
    contract: undefined,
    userPrompt: 'pick one',
    fixtureProps: {},
    classification: c,
    evaluationAgent: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    visualEvalAgent: { provider: 'openai', model: 'gpt-6-astra' } satisfies AgentSpec,
    visualEvaluation: { enabled: true, canvases: ['xs-chat-card'] },
    visualThreshold: 70,
    qualityMode: 'fast',
    maxEvalRounds: 3,
    costTracker: new CostTracker(null),
    llmEvalMod: { ...realLlmEvaluator, runLLMEvaluation: () => Promise.resolve({ issues: [], pass: [], inputTokens: 0, outputTokens: 0 }) },
    visualMod,
    preWarmPromise: undefined,
    probeOnly: false,
    probeRepairUsed: false,
  };
  const input: EvalRoundInput = { compiledCode, evalRoundsUsed: 0, preWarmedContext: undefined, prevModeSubcats: new Set(), prevFailFingerprints: new Set() };
  await runEvalRound(ctx, input);
  return seen[0];
}

describe('the eval round says whether the prompt taught the offered-items choice (ggui#2010)', () => {
  beforeEach(() => {
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ issues: [] });
  });

  it('an offered-items harness: the visual leg is told the chip example was taught', async () => {
    const context = await contextHandedToVisualLeg('offered-items');
    expect(context).toBeDefined();
    expect(context?.offeredChoiceTaught).toBe(true);
  });

  it('any other harness: no key, so the fix names no example', async () => {
    const context = await contextHandedToVisualLeg('none');
    expect(context).toBeDefined();
    expect(context).not.toHaveProperty('offeredChoiceTaught');
  });
});
