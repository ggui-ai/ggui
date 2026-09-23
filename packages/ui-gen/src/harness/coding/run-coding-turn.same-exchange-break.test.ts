// ggui#404's same-exchange guard names itself when it ends the run. Both break
// sites — the `get_available_icons` branch and the executed-tool branch —
// returned a bare `control: "break"`, a value at least eight exits share, so
// nothing downstream could tell this guard ended a generation (a reader could
// only guess it from "0 B compiled after a few turns"). Pinned here: the third
// identical exchange returns `sameExchangeBreak: { tool, repeats }` at each
// site, and no turn that the guard did not end carries the key.
//
// RED before the record, GREEN after.

import { describe, it, expect } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import { LLMAgent } from '../llm-router.js';
import type { LLMResponse, LLMToolCall, LLMToolCallResponse, LLMWithToolsResponse } from '../llm-router.js';
import { createDupeBreakState } from './dupe-break.js';
import { runCodingTurn } from './run-coding-turn.js';
import type { CodingTurnContext, CodingTurnInput, CodingTurnResult } from './run-coding-turn.js';

/** A coding agent that answers every turn with the same scripted tool call. */
class ScriptedAgent extends LLMAgent {
  readonly provider = 'anthropic' as const;
  constructor(private readonly call: LLMToolCall) {
    super();
  }
  protected resolveModel(model: string): string {
    return model;
  }
  protected createClient(): Promise<null> {
    return Promise.resolve(null);
  }
  callText(): Promise<LLMResponse> {
    return Promise.reject(new Error('callText is not scripted in this test'));
  }
  callTools(): Promise<LLMToolCallResponse> {
    return Promise.resolve({ toolCalls: [this.call], inputTokens: 10, outputTokens: 5 });
  }
  callWithTools(): Promise<LLMWithToolsResponse> {
    return Promise.reject(new Error('callWithTools is not scripted in this test'));
  }
}

const SOURCE = 'export default function C() { return null; }\n';

async function threeIdenticalTurns(call: LLMToolCall): Promise<CodingTurnResult[]> {
  const classification = { ...classifyAxes({ contract: {}, prompt: 'a card' }), riskTier: 'medium' as const };
  const harness = createHarness({ classification, contract: {}, prompt: 'a card' });
  const workspace = new AgentWorkspace();
  await workspace.init();
  workspace.write(SOURCE);
  const ctx: CodingTurnContext = {
    workspace,
    codingAgent: new ScriptedAgent(call),
    codingModel: 'scripted',
    systemPrompt: '',
    harness,
    contract: undefined,
    originalPrompt: 'a card',
    commitMeta: new Map(),
    originalProps: undefined,
    costTracker: null,
    dupeBreak: createDupeBreakState(),
  };
  const turns: CodingTurnResult[] = [];
  let iconNamesCache: string | null = null;
  for (let n = 1; n <= 3; n++) {
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
    turns.push(turn);
  }
  return turns;
}

describe('the same-exchange guard names itself when it ends the run (ggui#404)', () => {
  it('the get_available_icons site: the third identical exchange breaks WITH { tool, repeats }', async () => {
    const turns = await threeIdenticalTurns({ id: 'c1', name: 'get_available_icons', input: {} });

    expect(turns.map((t) => t.control)).toEqual(['continue', 'continue', 'break']);
    expect(turns[2]?.sameExchangeBreak).toEqual({ tool: 'get_available_icons', repeats: 3 });
    expect(turns.slice(0, 2).every((t) => !('sameExchangeBreak' in t)), 'no key on a turn the guard did not end').toBe(true);
  });

  it('the executed-tool site: three identical `cat` exchanges break WITH { tool, repeats }', async () => {
    const turns = await threeIdenticalTurns({ id: 'c1', name: 'cat', input: {} });

    expect(turns[2]?.control).toBe('break');
    expect(turns[2]?.sameExchangeBreak).toEqual({ tool: 'cat', repeats: 3 });
    expect(turns.slice(0, 2).every((t) => !('sameExchangeBreak' in t)), 'no key on a turn the guard did not end').toBe(true);
  });
});
