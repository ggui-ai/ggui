/**
 * ggui#1186, second site — the harness coding loop's per-turn usage comes
 * from `OpenAIAgent` (this file), not from the `adapters/openai/*` results
 * #1186 split. The Responses API reports `usage.input_tokens` INCLUDING the
 * cached prefix and the cached subset in `input_tokens_details.cached_tokens`;
 * the shared convention is `inputTokens` = NON-cached input and
 * `cacheReadTokens` = the cached subset (never both). Before this pin the
 * agent returned the cache-inclusive count as `inputTokens` and no
 * `cacheReadTokens` at all — so every openai generation double-counted its
 * cached prefix and reported zero cache reads to everything downstream.
 * RED before, GREEN after.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIAgent } from './llm-router';
import type { LLMToolDef } from './llm-router';

const createMock = vi.fn();
vi.mock('openai', () => ({
  default: class {
    responses = { create: createMock };
  },
}));

const applyChangesTool: LLMToolDef = {
  name: 'apply_changes',
  description: 'Apply code changes',
  parameters: { type: 'object', properties: { code: { type: 'string' } } },
};

function responseFixture(over: { id: string; output: unknown[]; usage: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens: number } } }) {
  return { id: over.id, output: over.output, usage: over.usage };
}

beforeEach(() => {
  createMock.mockReset();
});

describe('OpenAIAgent — prompt-cache accounting (ggui#1186, second site)', () => {
  it('callTools: inputTokens is the NON-cached input and cacheReadTokens the cached subset', async () => {
    createMock.mockResolvedValueOnce(
      responseFixture({
        id: 'resp_1',
        output: [{ type: 'function_call', call_id: 'c1', name: 'apply_changes', arguments: '{"code":"x"}' }],
        usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 600 } },
      }),
    );
    const agent = new OpenAIAgent();
    const r = await agent.callTools('gpt-5.6-luna', 'sys', 'user', [applyChangesTool], 'required');
    expect(r.inputTokens).toBe(400);
    expect(r.cacheReadTokens).toBe(600);
    expect(r.outputTokens).toBe(50);
    expect(r.toolCalls.map((t) => t.name)).toEqual(['apply_changes']);
  });

  it('callTools: a response without the breakdown reports inputTokens verbatim and cacheReadTokens 0 (reported, not absent)', async () => {
    createMock.mockResolvedValueOnce(
      responseFixture({ id: 'resp_2', output: [], usage: { input_tokens: 700, output_tokens: 10 } }),
    );
    const r = await new OpenAIAgent().callTools('gpt-5.6-luna', 'sys', 'user', [applyChangesTool], 'required');
    expect(r.inputTokens).toBe(700);
    expect(r.cacheReadTokens).toBe(0);
  });

  it('callText: inputTokens excludes the cached subset', async () => {
    createMock.mockResolvedValueOnce(
      responseFixture({
        id: 'resp_3',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
        usage: { input_tokens: 300, output_tokens: 5, input_tokens_details: { cached_tokens: 100 } },
      }),
    );
    const r = await new OpenAIAgent().callText('gpt-5.6-luna', 'sys', 'user');
    expect(r.text).toBe('hi');
    expect(r.inputTokens).toBe(200);
  });
});
