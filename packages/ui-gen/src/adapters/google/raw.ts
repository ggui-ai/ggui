// packages/ui-gen/src/adapters/google/raw.ts
//
// Google adapter using the Interactions API (@google/genai).
// Uses interactions.create() with previous_interaction_id for server-side
// state management. System prompt and tools sent on turn 1, subsequent turns
// only send function_result inputs — server remembers context.

import type { GoogleGenAI as GoogleGenAIType, Interactions } from '@google/genai';
import { GeneratorAdapter, hasCredentials } from '../base';
import type { AdapterConfig, GenerateParams } from '../base';
import type { AdapterResult, ToolDefinition, ProviderName, AdapterMode } from '../types';
import { zodToJsonSchema } from '../tool-bridge';
import { createCapture, captureSourceCode, captureCompiledCode, captureMarkers } from '../extract-code';
import type { JsonObject } from '@ggui-ai/protocol';

async function loadGoogleGenAI() {
  return import('@google/genai');
}

export class GoogleRawAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'google';
  readonly mode: AdapterMode = 'raw';
  readonly displayName = 'Google Gemini (Interactions API)';

  private client: GoogleGenAIType | null = null;

  constructor(config: AdapterConfig = {}) {
    super(config);
  }

  isAvailable(): boolean {
    return hasCredentials(this.config, 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
  }

  async generate(params: GenerateParams): Promise<AdapterResult> {
    const startTime = Date.now();

    if (!this.client) {
      const { GoogleGenAI } = await loadGoogleGenAI();
      this.client = new GoogleGenAI({
        apiKey: this.config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        httpOptions: { timeout: 300_000 }, // 5 min — Pro models can be slow
      });
    }

    const tools = params.tools.map(toInteractionTool);
    const capture = createCapture();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turnsUsed = 0;

    // Thinking control. Gemini 3.x Flash defaults thinking ON — the
    // dominant latency cost in UI generation, where the task is
    // contract-bounded code emission, not open-ended reasoning. The
    // Interactions API exposes this as `generation_config.thinking_level`
    // ('minimal' is the floor — there is no true off — then 'low' /
    // 'medium' / 'high'). When the caller pins a level we forward it on
    // every turn. Omitted → provider default (unchanged behavior).
    const thinkingLevel = this.config.thinkingLevel;
    const generationConfig = thinkingLevel
      ? { thinking_level: thinkingLevel }
      : undefined;

    // Turn 1: send system instruction + tools + user prompt
    let interaction = await this.client.interactions.create({
      model: params.model as Interactions.Model,
      system_instruction: params.systemPrompt,
      tools,
      input: params.userPrompt,
      ...(generationConfig ? { generation_config: generationConfig } : {}),
    });

    for (let turn = 0; turn < params.maxTurns; turn++) {
      turnsUsed = turn + 1;

      // Track tokens
      if (interaction.usage) {
        totalInputTokens += interaction.usage.total_input_tokens ?? 0;
        totalOutputTokens += interaction.usage.total_output_tokens ?? 0;
      }

      const outputs = interaction.outputs ?? [];

      // Scan text outputs for streamSpec/generatorMeta markers
      for (const output of outputs) {
        if (output.type === 'text' && 'text' in output) {
          captureMarkers(capture, (output as { text: string }).text);
        }
      }

      // Collect function calls
      const functionCalls = outputs.filter(
        (o): o is Interactions.FunctionCallContent => o.type === 'function_call',
      );

      if (functionCalls.length === 0) break;

      // Execute tools and build function_result inputs
      const results: Interactions.FunctionResultContent[] = [];

      for (const fc of functionCalls) {
        const toolDef = params.tools.find((t) => t.name === fc.name);
        if (!toolDef) {
          results.push({
            type: 'function_result',
            call_id: fc.id,
            name: fc.name,
            result: JSON.stringify({ error: `Tool '${fc.name}' not found` }),
            is_error: true,
          });
          continue;
        }

        const args = (fc.arguments ?? {}) as JsonObject;
        captureSourceCode(capture, fc.name, args);

        const result = await toolDef.handler(args);
        captureCompiledCode(capture, fc.name, result);

        results.push({
          type: 'function_result',
          call_id: fc.id,
          name: fc.name,
          result: result.content[0]?.text ?? '',
        });
      }

      // Next turn: only send function results — server has the history
      interaction = await this.client.interactions.create({
        model: params.model as Interactions.Model,
        previous_interaction_id: interaction.id,
        input: results,
        ...(generationConfig ? { generation_config: generationConfig } : {}),
      });
    }

    if (!capture.compiledCode) {
      throw new Error('Google raw adapter: no compiled code produced after all turns');
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

/** Convert ToolDefinition to Interactions API function tool format. */
function toInteractionTool(def: ToolDefinition): Interactions.Function {
  return {
    type: 'function',
    name: def.name,
    description: def.description,
    parameters: zodToJsonSchema(def.inputSchema),
  };
}
