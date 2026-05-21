// packages/ui-gen/src/adapters/claude/raw.ts
//
// Claude adapter using the raw Anthropic SDK (@anthropic-ai/sdk).
// Manual tool-use loop: messages.create() -> tool_use -> handler -> repeat.
//
// SDK client construction is centralized in `./client.ts`. Do NOT
// inline `new Anthropic(...)` here.

import type Anthropic from '@anthropic-ai/sdk';
import { GeneratorAdapter, hasCredentials } from '../base';
import type { AdapterConfig, GenerateParams } from '../base';
import type { AdapterResult, ToolDefinition, ProviderName, AdapterMode } from '../types';
import { zodToJsonSchema } from '../tool-bridge';
import { createCapture, captureSourceCode, captureCompiledCode, captureMarkers } from '../extract-code';
import type { JsonObject } from '@ggui-ai/protocol';
import { createAnthropicClient } from './client';

export class ClaudeRawAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'claude';
  readonly mode: AdapterMode = 'raw';
  readonly displayName = 'Claude (Raw API)';

  private client: Anthropic | null = null;

  constructor(config: AdapterConfig = {}) {
    super(config);
  }

  isAvailable(): boolean {
    return hasCredentials(this.config, 'ANTHROPIC_API_KEY');
  }

  async generate(params: GenerateParams): Promise<AdapterResult> {
    const startTime = Date.now();

    if (!this.client) {
      // Bedrock path: SDK reads AWS creds from the env / role chain;
      // skip the `apiKey` set entirely — `createAnthropicClient(undefined)`
      // gives us a constructed client and the SDK does the rest.
      if (this.config.useBedrock) {
        this.client = createAnthropicClient(undefined);
      } else {
        const rawKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;
        this.client = createAnthropicClient(rawKey);
      }
    }

    const anthropicTools = params.tools.map(toAnthropicTool);
    const capture = createCapture();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turnsUsed = 0;

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: params.userPrompt },
    ];

    for (let turn = 0; turn < params.maxTurns; turn++) {
      turnsUsed = turn + 1;

      const response = await this.client.messages.create({
        model: params.model,
        max_tokens: 16384,
        system: params.systemPrompt,
        messages,
        tools: anthropicTools,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      // Scan text blocks for streamSpec/generatorMeta markers
      for (const block of response.content) {
        if (block.type === 'text') captureMarkers(capture, block.text);
      }

      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        break;
      }

      messages.push({
        role: 'assistant',
        content: response.content.map((block) => {
          if (block.type === 'text') {
            return { type: 'text' as const, text: block.text };
          }
          return {
            type: 'tool_use' as const,
            id: (block as Anthropic.ToolUseBlock).id,
            name: (block as Anthropic.ToolUseBlock).name,
            input: (block as Anthropic.ToolUseBlock).input,
          };
        }),
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolBlock of toolUseBlocks) {
        const toolDef = params.tools.find((t) => t.name === toolBlock.name);
        if (!toolDef) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: `Tool '${toolBlock.name}' not found`,
            is_error: true,
          });
          continue;
        }

        const args = (toolBlock.input as JsonObject) ?? {};
        captureSourceCode(capture, toolBlock.name, args);

        const result = await toolDef.handler(args);
        captureCompiledCode(capture, toolBlock.name, result);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: result.content.map((c) => ({ type: 'text' as const, text: c.text })),
          is_error: result.isError,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    if (!capture.compiledCode) {
      throw new Error('Claude raw adapter: no compiled code produced after all turns');
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

function toAnthropicTool(def: ToolDefinition): Anthropic.Tool {
  return {
    name: def.name,
    description: def.description,
    input_schema: zodToJsonSchema(def.inputSchema) as Anthropic.Tool.InputSchema,
  };
}
