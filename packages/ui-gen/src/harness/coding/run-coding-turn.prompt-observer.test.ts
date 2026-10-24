// The coding-turn prompt observer reports exactly what the turn sends and changes nothing it sends. Pinned on a real
// runCodingTurn with a recording agent: the (system, user) pair handed to `callTools` is byte-identical with the
// observer on and off, and the observer receives that same pair, tagged with the turn.

import { describe, it, expect } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import { LLMAgent } from '../llm-router.js';
import type { LLMResponse, LLMToolCallResponse, LLMWithToolsResponse } from '../llm-router.js';
import type { CodingTurnPrompt } from '../runtime.js';
import { createDupeBreakState } from './dupe-break.js';
import { runCodingTurn } from './run-coding-turn.js';
import type { CodingTurnContext, CodingTurnInput } from './run-coding-turn.js';

/** Records every (system, user) pair it is called with; answers with a tool call that ends nothing. */
class RecordingAgent extends LLMAgent {
  readonly provider = 'anthropic' as const;
  readonly calls: Array<{ system: string; user: string }> = [];
  protected resolveModel(model: string): string {
    return model;
  }
  protected createClient(): Promise<null> {
    return Promise.resolve(null);
  }
  callText(): Promise<LLMResponse> {
    return Promise.reject(new Error('callText is not scripted in this test'));
  }
  callTools(_model: string, system: string, user: string): Promise<LLMToolCallResponse> {
    this.calls.push({ system, user });
    return Promise.resolve({ toolCalls: [{ id: 'c1', name: 'get_available_icons', input: {} }], inputTokens: 10, outputTokens: 5 });
  }
  callWithTools(): Promise<LLMWithToolsResponse> {
    return Promise.reject(new Error('callWithTools is not scripted in this test'));
  }
}

const SYSTEM = 'SYSTEM PROMPT — the composed text the turn sends, with a non-ASCII dash.';

async function twoTurns(onPrompt: ((sent: CodingTurnPrompt) => void) | undefined): Promise<RecordingAgent> {
  const classification = { ...classifyAxes({ contract: {}, prompt: 'a card' }), riskTier: 'medium' as const };
  const harness = createHarness({ classification, contract: {}, prompt: 'a card' });
  const workspace = new AgentWorkspace();
  await workspace.init();
  workspace.write('export default function C() { return null; }\n');
  const agent = new RecordingAgent();
  const ctx: CodingTurnContext = {
    workspace,
    codingAgent: agent,
    codingModel: 'recorded',
    systemPrompt: SYSTEM,
    harness,
    contract: undefined,
    originalPrompt: 'a card',
    commitMeta: new Map(),
    originalProps: undefined,
    costTracker: null,
    dupeBreak: createDupeBreakState(),
    ...(onPrompt !== undefined ? { onPrompt } : {}),
  };
  let iconNamesCache: string | null = null;
  for (let n = 1; n <= 2; n++) {
    const input: CodingTurnInput = {
      turnsUsed: n,
      a1Phase: 'post',
      lastResultText: '',
      lastDiffFailed: false,
      isEvalFeedback: false,
      iconNamesCache,
      preWarmedContext: undefined,
      preWarmPromise: undefined,
    };
    const turn = await runCodingTurn(ctx, input);
    iconNamesCache = turn.iconNamesCache;
  }
  return agent;
}

describe('the coding-turn prompt observer', () => {
  it('reports, per turn, exactly the (system, user) pair the agent was called with', async () => {
    const seen: CodingTurnPrompt[] = [];
    const agent = await twoTurns((sent) => seen.push(sent));

    expect(seen.map((s) => s.turn)).toEqual([1, 2]);
    expect(seen.map((s) => ({ system: s.systemPrompt, user: s.userPrompt }))).toEqual(agent.calls);
    expect(seen[0]?.systemPrompt).toBe(SYSTEM);
    expect(seen.every((s) => s.userPrompt.length > 0)).toBe(true);
  });

  it('changes nothing sent: the calls are byte-identical with the observer on and off', async () => {
    const off = await twoTurns(undefined);
    const on = await twoTurns(() => undefined);

    expect(on.calls.length).toBe(2);
    expect(on.calls).toEqual(off.calls);
  });
});
