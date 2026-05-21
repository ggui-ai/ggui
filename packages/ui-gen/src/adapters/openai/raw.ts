// packages/ui-gen/src/adapters/openai/raw.ts
//
// OpenAI adapter using the raw OpenAI SDK (openai).
// Uses the Responses API (responses.create) with previous_response_id
// for multi-turn tool-calling loops.

import type OpenAI from 'openai';
import type { Responses } from 'openai/resources/responses/responses';
import { GeneratorAdapter, hasCredentials } from '../base';
import type { AdapterConfig, GenerateParams } from '../base';
import type { AdapterResult, ToolDefinition, ProviderName, AdapterMode } from '../types';
import { zodToJsonSchema } from '../tool-bridge';
import {
  createCapture,
  captureSourceCode,
  captureCompiledCode,
  captureMarkers,
  extractCodeFromText,
  compileLastResort,
} from '../extract-code';
import type { JsonObject } from '@ggui-ai/protocol';

/** Lazy-load the OpenAI SDK to avoid top-level import crashes in Lambda bundles. */
async function loadOpenAI(): Promise<typeof import('openai')> {
  return import('openai');
}

export class OpenAiRawAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'openai';
  readonly mode: AdapterMode = 'raw';
  readonly displayName = 'OpenAI (Raw API)';

  private client: OpenAI | null = null;

  constructor(config: AdapterConfig = {}) {
    super(config);
  }

  isAvailable(): boolean {
    return hasCredentials(this.config, 'OPENAI_API_KEY');
  }

  async generate(params: GenerateParams): Promise<AdapterResult> {
    const startTime = Date.now();

    if (!this.client) {
      const { default: OpenAIClient } = await loadOpenAI();
      this.client = new OpenAIClient({
        apiKey: this.config.apiKey || process.env.OPENAI_API_KEY,
      });
    }

    const tools = params.tools.map(toResponsesTool);
    const capture = createCapture();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turnsUsed = 0;
    let allTextOutput = '';

    // First request — user prompt + instructions
    let response: Responses.Response = await this.client.responses.create({
      model: params.model,
      instructions: params.systemPrompt,
      input: [{ role: 'user', content: params.userPrompt }],
      tools,
      store: true, // Required for previous_response_id to work on subsequent turns
    });

    // Agentic loop
    for (let turn = 0; turn < params.maxTurns; turn++) {
      turnsUsed = turn + 1;

      // Track tokens
      if (response.usage) {
        totalInputTokens += response.usage.input_tokens ?? 0;
        totalOutputTokens += response.usage.output_tokens ?? 0;
      }

      // Process output items
      const output = response.output ?? [];
      const functionCalls = output.filter(
        (item): item is Responses.ResponseFunctionToolCall => item.type === 'function_call',
      );

      // Collect text output for markers and code extraction fallback
      for (const item of output) {
        if (item.type === 'message' && 'content' in item && item.content) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) {
              allTextOutput += part.text + '\n';
              captureMarkers(capture, part.text);
            }
          }
        }
      }

      if (functionCalls.length === 0) break;

      // Only send function_call_output items — previous_response_id carries context
      const nextInput: Responses.ResponseInputItem.FunctionCallOutput[] = [];

      for (const fc of functionCalls) {
        const toolDef = params.tools.find((t) => t.name === fc.name);
        if (!toolDef) {
          nextInput.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output: JSON.stringify({ error: `Tool '${fc.name}' not found` }),
          });
          continue;
        }

        let args: JsonObject = {};
        try { args = JSON.parse(fc.arguments || '{}') as JsonObject; } catch { /* empty */ }

        captureSourceCode(capture, fc.name, args);

        const result = await toolDef.handler(args);
        captureCompiledCode(capture, fc.name, result);

        nextInput.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: result.content[0]?.text ?? '',
        });
      }

      // Next turn — use previous_response_id for context continuity
      response = await this.client.responses.create({
        model: params.model,
        instructions: params.systemPrompt,
        input: nextInput,
        tools,
        previous_response_id: response.id,
        store: true,
      });
    }

    // Fallback: extract code from text output if no tool produced compiled code
    if (!capture.compiledCode && allTextOutput) {
      captureMarkers(capture, allTextOutput);
      await extractCodeFromText(allTextOutput, params.tools, capture);
    }

    // Last resort: compile sourceCode directly with esbuild, bypassing self-checks
    if (!capture.compiledCode) {
      await compileLastResort(capture, allTextOutput);
    }

    if (!capture.compiledCode) {
      throw new Error('OpenAI raw adapter: no compiled code produced after all turns');
    }

    return {
      compiledCode: capture.compiledCode,
      sourceCode: capture.sourceCode,
      stream: capture.stream,
      generatorMeta: capture.generatorMeta,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        total: totalInputTokens + totalOutputTokens,
      },
      generationTimeMs: Date.now() - startTime,
      turnsUsed,
    };
  }
}

/**
 * Convert a ToolDefinition to OpenAI Responses API FunctionTool format.
 */
function toResponsesTool(def: ToolDefinition): { type: 'function'; name: string; description: string; parameters: JsonObject; strict: boolean } {
  return {
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: zodToJsonSchema(def.inputSchema) as JsonObject,
    strict: false,
  };
}
