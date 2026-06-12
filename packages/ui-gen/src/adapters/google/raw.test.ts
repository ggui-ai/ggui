// packages/ui-gen/src/adapters/google/raw.test.ts
//
// Unit tests for GoogleRawAdapter against the Interactions API 'steps'
// schema (@google/genai >= 2.0.0). The SDK module is mocked; fixtures
// are typed against the REAL SDK types so any wire-shape drift in a
// future SDK bump fails compilation here, not in production.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Interactions } from '@google/genai';
import { GoogleRawAdapter } from './raw';
import type { ToolDefinition } from '../types';

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

const COMPILED = 'var Component = () => null;';

const compileTool: ToolDefinition = {
  name: 'compile_component',
  description: 'Compile a React component',
  inputSchema: z.object({ code: z.string() }),
  handler: async () => ({
    content: [
      { type: 'text', text: JSON.stringify({ success: true, compiledCode: COMPILED }) },
    ],
  }),
};

function adapterParams(tools: ToolDefinition[]) {
  return {
    systemPrompt: 'SYSTEM',
    userPrompt: 'USER',
    model: 'gemini-3.1-flash-lite',
    tools,
    maxTurns: 4,
  };
}

beforeEach(() => {
  createMock.mockReset();
});

describe('GoogleRawAdapter (steps schema)', () => {
  it('runs a tool round-trip: function_call step → handler → function_result input', async () => {
    createMock
      .mockResolvedValueOnce(
        interactionFixture({
          id: 'int-1',
          status: 'requires_action',
          // A `thought` step is present even at thinking_level 'minimal' —
          // the scan must skip it without misreading it as text output.
          steps: [
            { type: 'thought' },
            { type: 'model_output', content: [{ type: 'text', text: 'Compiling now.' }] },
            {
              type: 'function_call',
              id: 'call-1',
              name: 'compile_component',
              arguments: { code: 'export const C = () => null;' },
            },
          ],
          usage: { total_input_tokens: 100, total_output_tokens: 20 },
        }),
      )
      .mockResolvedValueOnce(
        interactionFixture({
          id: 'int-2',
          status: 'completed',
          steps: [
            { type: 'thought' },
            { type: 'model_output', content: [{ type: 'text', text: 'Done.' }] },
          ],
          usage: { total_input_tokens: 150, total_output_tokens: 30 },
        }),
      );

    const adapter = new GoogleRawAdapter({ apiKey: 'test-key' });
    const result = await adapter.generate(adapterParams([compileTool]));

    expect(result.compiledCode).toBe(COMPILED);
    expect(result.tokens).toEqual({ input: 250, output: 50, total: 300 });
    expect(result.turnsUsed).toBe(2);

    expect(createMock).toHaveBeenCalledTimes(2);

    // Turn 1: system instruction + tools + prompt, no generation_config
    // when no thinkingLevel is pinned.
    const turn1 = createMock.mock.calls[0][0];
    expect(turn1.model).toBe('gemini-3.1-flash-lite');
    expect(turn1.system_instruction).toBe('SYSTEM');
    expect(turn1.input).toBe('USER');
    expect(turn1.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'compile_component' }),
    ]);
    expect(turn1.generation_config).toBeUndefined();

    // Turn 2: chained via previous_interaction_id with function_result steps.
    const turn2 = createMock.mock.calls[1][0];
    expect(turn2.previous_interaction_id).toBe('int-1');
    expect(turn2.input).toEqual([
      {
        type: 'function_result',
        call_id: 'call-1',
        name: 'compile_component',
        result: JSON.stringify({ success: true, compiledCode: COMPILED }),
      },
    ]);
  });

  it('forwards thinking_level on every turn when pinned', async () => {
    createMock
      .mockResolvedValueOnce(
        interactionFixture({
          id: 'int-1',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'call-1',
              name: 'compile_component',
              arguments: { code: 'x' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        interactionFixture({ id: 'int-2', status: 'completed', steps: [] }),
      );

    const adapter = new GoogleRawAdapter({ apiKey: 'test-key', thinkingLevel: 'minimal' });
    await adapter.generate(adapterParams([compileTool]));

    expect(createMock.mock.calls[0][0].generation_config).toEqual({
      thinking_level: 'minimal',
    });
    expect(createMock.mock.calls[1][0].generation_config).toEqual({
      thinking_level: 'minimal',
    });
  });

  it('answers unknown tool calls with an is_error function_result', async () => {
    createMock
      .mockResolvedValueOnce(
        interactionFixture({
          id: 'int-1',
          status: 'requires_action',
          steps: [
            { type: 'function_call', id: 'call-9', name: 'nonexistent_tool', arguments: {} },
          ],
        }),
      )
      .mockResolvedValueOnce(
        interactionFixture({ id: 'int-2', status: 'completed', steps: [] }),
      );

    const adapter = new GoogleRawAdapter({ apiKey: 'test-key' });
    await expect(adapter.generate(adapterParams([compileTool]))).rejects.toThrow(
      'no compiled code produced',
    );

    expect(createMock.mock.calls[1][0].input).toEqual([
      {
        type: 'function_result',
        call_id: 'call-9',
        name: 'nonexistent_tool',
        result: JSON.stringify({ error: "Tool 'nonexistent_tool' not found" }),
        is_error: true,
      },
    ]);
  });
});
