// packages/ui-gen/src/harness/llm-router.google.test.ts
//
// Unit tests for GoogleAgent against the Interactions API 'steps' schema
// (@google/genai >= 2.0.0). The SDK module is mocked; fixtures are typed
// against the REAL SDK types so wire-shape drift in a future SDK bump
// fails compilation here.
//
// The load-bearing seam: pending function_result steps + the next user
// prompt go up in ONE input array, with the prompt wrapped as a
// `user_input` step (bare `{type:'text'}` content is not a Step in 2.x).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Interactions } from '@google/genai';
import { GoogleAgent } from './llm-router';
import type { LLMToolDef } from './llm-router';

const { createMock } = vi.hoisted(() => ({
  createMock:
    vi.fn<
      (
        params: Interactions.CreateModelInteractionParamsNonStreaming,
      ) => Promise<Interactions.Interaction>
    >(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    interactions = { create: createMock };
  },
}));

function interactionFixture(over: {
  id: string;
  status: Interactions.Interaction['status'];
  steps: Interactions.Step[];
  usage?: Interactions.Usage;
}): Interactions.Interaction {
  return {
    id: over.id,
    created: '2026-06-12T00:00:00Z',
    updated: '2026-06-12T00:00:00Z',
    status: over.status,
    steps: over.steps,
    usage: over.usage,
  };
}

const applyChangesTool: LLMToolDef = {
  name: 'apply_changes',
  description: 'Apply code changes',
  parameters: { type: 'object', properties: { code: { type: 'string' } } },
};

beforeEach(() => {
  createMock.mockReset();
});

describe('GoogleAgent (steps schema)', () => {
  it('callText concatenates model_output text and skips thought steps', async () => {
    createMock.mockResolvedValueOnce(
      interactionFixture({
        id: 'int-1',
        status: 'completed',
        steps: [
          { type: 'thought', summary: [{ type: 'text', text: 'planning' }] },
          {
            type: 'model_output',
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'world' },
            ],
          },
        ],
        usage: { total_input_tokens: 11, total_output_tokens: 7 },
      }),
    );

    const agent = new GoogleAgent();
    const res = await agent.callText('gemini/gemini-3.1-flash-lite', 'SYSTEM', 'USER');

    expect(res).toEqual({ text: 'Hello world', inputTokens: 11, outputTokens: 7 });
    // `gemini/` transport prefix stripped before the wire.
    expect(createMock.mock.calls[0][0].model).toBe('gemini-3.1-flash-lite');
    expect(createMock.mock.calls[0][0].system_instruction).toBe('SYSTEM');
    expect(createMock.mock.calls[0][0].input).toBe('USER');
  });

  it('callTools extracts function_call steps with validated JSON arguments', async () => {
    createMock.mockResolvedValueOnce(
      interactionFixture({
        id: 'int-1',
        status: 'requires_action',
        steps: [
          { type: 'thought' },
          {
            type: 'function_call',
            id: 'call-1',
            name: 'apply_changes',
            arguments: { code: 'const a = 1;' },
          },
        ],
        usage: { total_input_tokens: 40, total_output_tokens: 9 },
      }),
    );

    const agent = new GoogleAgent();
    const res = await agent.callTools('gemini-3.1-flash-lite', 'SYSTEM', 'USER', [
      applyChangesTool,
    ]);

    expect(res.toolCalls).toEqual([
      { id: 'call-1', name: 'apply_changes', input: { code: 'const a = 1;' } },
    ]);
    expect(res.inputTokens).toBe(40);
    expect(res.outputTokens).toBe(9);

    const params = createMock.mock.calls[0][0];
    expect(params.system_instruction).toBe('SYSTEM');
    expect(params.input).toBe('USER');
    expect(params.tools).toEqual([
      { type: 'function', name: 'apply_changes', description: 'Apply code changes', parameters: applyChangesTool.parameters },
    ]);
  });

  it('chained callTools sends pending function_result steps + user_input-wrapped prompt', async () => {
    createMock
      .mockResolvedValueOnce(
        interactionFixture({
          id: 'int-1',
          status: 'requires_action',
          steps: [
            { type: 'function_call', id: 'call-1', name: 'apply_changes', arguments: { code: 'x' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        interactionFixture({
          id: 'int-2',
          status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }],
        }),
      );

    const agent = new GoogleAgent();
    await agent.callTools('gemini-3.1-flash-lite', 'SYSTEM', 'TURN 1', [applyChangesTool]);
    await agent.sendToolResult([
      { callId: 'call-1', name: 'apply_changes', result: 'applied', isError: false },
    ]);
    await agent.callTools('gemini-3.1-flash-lite', 'SYSTEM', 'TURN 2', [applyChangesTool]);

    const chained = createMock.mock.calls[1][0];
    expect(chained.previous_interaction_id).toBe('int-1');
    // Mixed input array = Array<Step>: function_result steps first, then
    // the new prompt wrapped as a user_input step.
    expect(chained.input).toEqual([
      {
        type: 'function_result',
        call_id: 'call-1',
        name: 'apply_changes',
        result: 'applied',
        is_error: false,
      },
      { type: 'user_input', content: [{ type: 'text', text: 'TURN 2' }] },
    ]);
    // Tools are re-sent on every chained call so they stay available
    // mid-chain for the production turn loop.
    expect(chained.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'apply_changes' }),
    ]);
  });
});
