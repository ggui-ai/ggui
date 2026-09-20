/**
 * ggui#1186, third site — the Google agent read `total_input_tokens` /
 * `promptTokenCount` (both INCLUDE the cached part of the prompt, per the
 * SDK's own docs: `total_cached_tokens` = "the cached part of the prompt")
 * and reported no cache reads at all, so a Google generation double-counted
 * its cached prefix as input and its cached share read 0 downstream. Same
 * convention as OpenAI's split: `inputTokens` = the non-cached prompt,
 * `cacheReadTokens` = the cached subset. RED before, GREEN after.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Interactions } from '@google/genai';
import { GoogleAgent } from './llm-router';
import type { LLMToolDef } from './llm-router';

const createMock = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    interactions = { create: createMock };
  },
}));

function interactionFixture(over: { id: string; status: Interactions.Interaction['status']; steps: Interactions.Step[]; usage?: Interactions.Usage }): Interactions.Interaction {
  return { id: over.id, created: '2026-06-12T00:00:00Z', updated: '2026-06-12T00:00:00Z', status: over.status, steps: over.steps, usage: over.usage };
}

const applyChangesTool: LLMToolDef = {
  name: 'apply_changes',
  description: 'Apply code changes',
  parameters: { type: 'object', properties: { code: { type: 'string' } } },
};

beforeEach(() => {
  createMock.mockReset();
});

describe('GoogleAgent — prompt-cache accounting (ggui#1186, third site)', () => {
  it('callTools: inputTokens is the NON-cached prompt and cacheReadTokens the cached subset', async () => {
    createMock.mockResolvedValueOnce(
      interactionFixture({
        id: 'i1',
        status: 'completed',
        steps: [{ type: 'function_call', id: 'call-1', name: 'apply_changes', arguments: { code: 'x' } }],
        usage: { total_input_tokens: 1000, total_output_tokens: 50, total_cached_tokens: 600 },
      }),
    );
    const r = await new GoogleAgent().callTools('gemini-3.1-flash-lite', 'SYSTEM', 'USER', [applyChangesTool], 'required');
    expect(r.inputTokens).toBe(400);
    expect(r.cacheReadTokens).toBe(600);
    expect(r.outputTokens).toBe(50);
    expect(r.toolCalls.map((t) => t.name)).toEqual(['apply_changes']);
  });

  it('callTools: no cached field ⇒ inputTokens verbatim and cacheReadTokens 0 (reported, not absent)', async () => {
    createMock.mockResolvedValueOnce(
      interactionFixture({ id: 'i2', status: 'completed', steps: [], usage: { total_input_tokens: 700, total_output_tokens: 10 } }),
    );
    const r = await new GoogleAgent().callTools('gemini-3.1-flash-lite', 'SYSTEM', 'USER', [applyChangesTool], 'required');
    expect(r.inputTokens).toBe(700);
    expect(r.cacheReadTokens).toBe(0);
  });

  it('callText: inputTokens excludes the cached subset', async () => {
    createMock.mockResolvedValueOnce(
      interactionFixture({
        id: 'i3',
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }],
        usage: { total_input_tokens: 300, total_output_tokens: 5, total_cached_tokens: 100 },
      }),
    );
    const r = await new GoogleAgent().callText('gemini-3.1-flash-lite', 'SYSTEM', 'USER');
    expect(r.text).toBe('hi');
    expect(r.inputTokens).toBe(200);
  });
});
