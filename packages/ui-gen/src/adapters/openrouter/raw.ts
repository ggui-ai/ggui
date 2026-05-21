// packages/ui-gen/src/adapters/openrouter/raw.ts
//
// OpenRouter adapter using direct fetch() — no OpenAI SDK dependency.
// Uses OpenAI-compatible chat completions API with OpenRouter extensions
// for caching and extended thinking.

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
import { OpenRouterClient } from './client';
import type { OpenRouterMessage, OpenRouterTool, OpenRouterChatResponse } from './types';

export class OpenRouterRawAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'openrouter';
  readonly mode: AdapterMode = 'raw';
  readonly displayName = 'OpenRouter (Raw API)';

  private client: OpenRouterClient | null = null;

  constructor(config: AdapterConfig = {}) {
    super(config);
  }

  isAvailable(): boolean {
    return hasCredentials(this.config, 'OPENROUTER_API_KEY');
  }

  async generate(params: GenerateParams): Promise<AdapterResult> {
    const startTime = Date.now();

    if (!this.client) {
      this.client = new OpenRouterClient({
        apiKey: this.config.apiKey || process.env.OPENROUTER_API_KEY!,
      });
    }

    const tools = params.tools.map(toOpenRouterTool);
    const capture = createCapture();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheCreationTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let turnsUsed = 0;
    let allTextOutput = '';

    // Detect model capabilities for cache/thinking support
    const modelId = params.model;
    const isAnthropicModel = modelId.includes('anthropic/') || modelId.includes('claude');

    // Build initial messages with optional cache_control
    const systemMessage: OpenRouterMessage = isAnthropicModel
      ? {
          role: 'system',
          content: [{ type: 'text', text: params.systemPrompt, cache_control: { type: 'ephemeral' } }],
        }
      : { role: 'system', content: params.systemPrompt };

    const messages: OpenRouterMessage[] = [
      systemMessage,
      { role: 'user', content: params.userPrompt },
    ];

    // Agentic loop
    for (let turn = 0; turn < params.maxTurns; turn++) {
      turnsUsed = turn + 1;

      const response: OpenRouterChatResponse = await this.client.chatCompletion({
        model: modelId,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        max_tokens: 16384,
      });

      // Track tokens
      if (response.usage) {
        totalInputTokens += response.usage.prompt_tokens;
        totalOutputTokens += response.usage.completion_tokens;
        if (response.usage.cache_creation_input_tokens) {
          cacheCreationTokens = (cacheCreationTokens ?? 0) + response.usage.cache_creation_input_tokens;
        }
        if (response.usage.cache_read_input_tokens) {
          cacheReadTokens = (cacheReadTokens ?? 0) + response.usage.cache_read_input_tokens;
        }
      }

      const choice = response.choices[0];
      if (!choice) break;

      // Collect text output
      if (choice.message.content) {
        allTextOutput += choice.message.content + '\n';
        captureMarkers(capture, choice.message.content);
      }

      const toolCalls = choice.message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) break;

      // Add assistant message with tool_calls to conversation
      messages.push({
        role: 'assistant',
        content: choice.message.content,
        tool_calls: toolCalls,
      });

      // Execute tools and add results
      for (const tc of toolCalls) {
        const toolDef = params.tools.find((t) => t.name === tc.function.name);
        if (!toolDef) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `Tool '${tc.function.name}' not found` }),
          });
          continue;
        }

        let args: JsonObject = {};
        try { args = JSON.parse(tc.function.arguments || '{}') as JsonObject; } catch { /* empty */ }

        captureSourceCode(capture, tc.function.name, args);

        const result = await toolDef.handler(args);
        captureCompiledCode(capture, tc.function.name, result);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.content[0]?.text ?? '',
        });
      }
    }

    // Fallback: extract code from text output
    if (!capture.compiledCode && allTextOutput) {
      captureMarkers(capture, allTextOutput);
      await extractCodeFromText(allTextOutput, params.tools, capture);
    }

    // Last resort: compile sourceCode directly
    if (!capture.compiledCode) {
      await compileLastResort(capture, allTextOutput);
    }

    if (!capture.compiledCode) {
      throw new Error('OpenRouter raw adapter: no compiled code produced after all turns');
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
      cacheCreationTokens,
      cacheReadTokens,
    };
  }
}

/** Convert ToolDefinition to OpenRouter tool format (OpenAI-compatible). */
function toOpenRouterTool(def: ToolDefinition): OpenRouterTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: zodToJsonSchema(def.inputSchema) as JsonObject,
    },
  };
}
