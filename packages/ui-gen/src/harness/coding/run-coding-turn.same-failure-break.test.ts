// ggui#1791 — the same-failure guard. The patch fingerprint keys on the PATCH,
// so a model that rewords a comment every turn while the same self-check keeps
// failing never reads as stuck, and the run goes to the turn cap (survey-form
// on a contract whose fields are contextSpec slots: 8 turns at a cap of 8).
// This guard keys on the FAILURE: each failing check is counted across the
// failed writes since the last pass, whatever failed in between, so a nudge
// comes at its third report and the run ends at its fifth.
//
// RED before the guard, GREEN after.

import { describe, it, expect } from 'vitest';
import { AgentWorkspace } from '../../coding-agent/workspace.js';
import { classifyAxes } from '../../classifier/classifier.js';
import { createHarness } from '../../create-harness.js';
import { LLMAgent } from '../llm-router.js';
import type { LLMResponse, LLMToolCallResponse, LLMWithToolsResponse } from '../llm-router.js';
import {
  clearWriteFailures,
  createDupeBreakState,
  failureSignatures,
  recordWriteFailure,
  SAME_FAILURE_BREAK_AT,
  SAME_FAILURE_NUDGE,
} from './dupe-break.js';
import { runCodingTurn } from './run-coding-turn.js';
import type { CodingTurnContext, CodingTurnInput, CodingTurnResult } from './run-coding-turn.js';

const SOURCE = 'export default function C() { return null; }\n';

/** A different patch every turn (the comment and the message change); the same failure every turn. */
class RewordingAgent extends LLMAgent {
  readonly provider = 'anthropic' as const;
  private turn = 0;
  /** When set, every even turn sends a patch whose range does not exist — a different failure in between. */
  constructor(private readonly interleave = false) {
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
    this.turn += 1;
    if (this.interleave && this.turn % 2 === 0) {
      return Promise.resolve({
        toolCalls: [{
          id: `c${this.turn}`,
          name: 'apply_changes',
          input: { changes: [{ startLine: 900 + this.turn, endLine: 900 + this.turn, code: [`// stray ${this.turn}`] }], commit_message: `stray ${this.turn}` },
        }],
        inputTokens: 10,
        outputTokens: 5,
      });
    }
    const code = [
      `// attempt ${this.turn}: tidy the markup`,
      // No Props interface, so self-check fails the same way on every turn.
      'export default function C() { return <div />; }',
    ];
    return Promise.resolve({
      toolCalls: [{
        id: `c${this.turn}`,
        name: 'apply_changes',
        input: { changes: [{ startLine: 1, endLine: this.turn === 1 ? 1 : 2, code }], commit_message: `reword ${this.turn}` },
      }],
      inputTokens: 10,
      outputTokens: 5,
    });
  }
  callWithTools(): Promise<LLMWithToolsResponse> {
    return Promise.reject(new Error('callWithTools is not scripted in this test'));
  }
}

async function runTurns(count: number, interleave = false): Promise<CodingTurnResult[]> {
  const classification = { ...classifyAxes({ contract: {}, prompt: 'a card' }), riskTier: 'medium' as const };
  const harness = createHarness({ classification, contract: {}, prompt: 'a card' });
  const workspace = new AgentWorkspace();
  await workspace.init();
  workspace.write(SOURCE);
  const ctx: CodingTurnContext = {
    workspace,
    codingAgent: new RewordingAgent(interleave),
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
  for (let n = 1; n <= count; n++) {
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
    if (turn.control === 'break') break;
  }
  return turns;
}

describe('the same-failure guard (ggui#1791)', () => {
  it('a different patch every turn, the same failure every turn: nudged on the third, ended on the fifth', async () => {
    const turns = await runTurns(8);

    expect(turns.map((t) => t.control)).toEqual(['continue', 'continue', 'continue', 'continue', 'break']);
    expect(turns.slice(0, 4).every((t) => t.outcome === 'SELF_CHECK_FAIL')).toBe(true);
    expect(turns[2]?.lastResultText.endsWith(SAME_FAILURE_NUDGE)).toBe(true);
    expect(turns[1]?.lastResultText).not.toContain(SAME_FAILURE_NUDGE);
    expect(turns[4]?.sameFailureBreak?.repeats).toBe(SAME_FAILURE_BREAK_AT);
    expect(turns[4]?.sameFailureBreak?.signature.length).toBeGreaterThan(0);
    expect(turns.slice(0, 4).every((t) => !('sameFailureBreak' in t)), 'no key on a turn the guard did not end').toBe(true);
    expect(turns.every((t) => !('sameExchangeBreak' in t)), 'the patches differ, so the same-exchange guard never fires').toBe(true);
  });
});

it('a different failure in between does not hide the repeat: the run ends at the fifth report of the check', async () => {
  const turns = await runTurns(12, true);
  // Odd turns fail self-check the same way; even turns send a patch with no such line.
  expect(turns.length).toBe(9);
  expect(turns[8]?.control).toBe('break');
  expect(turns[8]?.sameFailureBreak?.repeats).toBe(SAME_FAILURE_BREAK_AT);
  expect(turns[8]?.sameFailureBreak?.signature).toContain('No Props interface');
  expect(turns[4]?.lastResultText.endsWith(SAME_FAILURE_NUDGE)).toBe(true);
  expect(turns.slice(0, 8).every((t) => t.control !== 'break')).toBe(true);
});

describe('failureSignatures / recordWriteFailure', () => {
  const fail = (oid: string, msg: string, line: number, extra = ''): string =>
    `Committed ${oid}: "${msg}"\nSelf-check violations:\n[mode] state does not cover: name (line ${line})\n  Fix: add a slot${extra}\nFix the issues.`;

  it('one signature per failing check, ignoring the commit line and every number', () => {
    expect(failureSignatures(fail('abc1234', 'reword 1', 3))).toEqual(failureSignatures(fail('def5678', 'reword 2', 41)));
    expect(failureSignatures(fail('a', 'm', 3, '\n[mode] no integer step state'))).toHaveLength(2);
    expect(failureSignatures('Committed a: "x"\nBuild errors:\nUnexpected "}" at 4:2\nFix the issues.')).toEqual([
      'Build errors: Unexpected "}" at #:# Fix the issues.',
    ]);
  });

  it('counts a check across failed writes whatever fails beside it or between, and a pass starts every count over', () => {
    const s = createDupeBreakState();
    expect(recordWriteFailure(s, fail('a', 'm', 1))?.repeats).toBe(1);
    expect(recordWriteFailure(s, 'Committed b: "n"\nBuild errors:\nUnexpected "}"\nFix the issues.')?.repeats).toBe(1);
    const third = recordWriteFailure(s, fail('c', 'o', 2, '\n[mode] no integer step state'));
    expect(third?.repeats).toBe(2);
    expect(third?.signature).toContain('state does not cover');
    clearWriteFailures(s);
    expect(recordWriteFailure(s, fail('d', 'p', 4))?.repeats).toBe(1);
  });

  it('a result with no recognisable failure counts nothing', () => {
    const s = createDupeBreakState();
    expect(recordWriteFailure(s, 'Committed z: "q"\n')).toBeUndefined();
    expect(s.failureCounts.size).toBe(0);
  });
});
