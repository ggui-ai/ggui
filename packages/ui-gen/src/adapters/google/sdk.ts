// packages/ui-gen/src/adapters/google/sdk.ts
//
// Google adapter using @google/adk (Agent Development Kit).
// Uses LlmAgent + InMemoryRunner + FunctionTool for agent-managed tool execution.

import { GeneratorAdapter, hasCredentials } from '../base';
import type { AdapterConfig, GenerateParams } from '../base';
import type { AdapterResult, ProviderName, AdapterMode } from '../types';
import { createCapture, captureSourceCode, captureCompiledCode, captureMarkers } from '../extract-code';
import type { Content, Part } from '@google/genai';
import type { JsonObject } from '@ggui-ai/protocol';
import type { ToolInputParameters } from '@google/adk';

export class GoogleSdkAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'google';
  readonly mode: AdapterMode = 'sdk';
  readonly displayName = 'Google Gemini (ADK)';

  constructor(config: AdapterConfig = {}) {
    super(config);
  }

  isAvailable(): boolean {
    return hasCredentials(this.config, 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
  }

  async generate(params: GenerateParams): Promise<AdapterResult> {
    const apiKey = this.config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

    return runAdkLoop({
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      model: params.model,
      tools: params.tools,
      apiKey,
    });
  }
}

// =============================================================================
// Core agentic loop — Google ADK (LlmAgent + InMemoryRunner)
// =============================================================================

import type { ToolDefinition } from '../types';

export interface AdkLoopParams {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  tools: ToolDefinition[];
  apiKey?: string;
}

/**
 * Run a single agentic loop using Google ADK.
 *
 * Uses InMemoryRunner.runAsync() which returns an async iterator of events.
 * FunctionTool wraps our ToolDefinition handlers with capture logic.
 */
export async function runAdkLoop(
  params: AdkLoopParams,
): Promise<AdapterResult> {
  const startTime = Date.now();

  const { FunctionTool, LlmAgent, InMemoryRunner, isFinalResponse } = await import('@google/adk');

  const capture = createCapture();

  // Ensure ADK can find the API key
  if (params.apiKey && !process.env.GOOGLE_GENAI_API_KEY) {
    process.env.GOOGLE_GENAI_API_KEY = params.apiKey;
  }

  // Build tools with capture wrappers
  const adkTools = params.tools.map((def) =>
    new FunctionTool({
      name: def.name,
      description: def.description,
      // Pass Zod schema directly — ADK accepts ZodObject natively
      parameters: def.inputSchema as ToolInputParameters,
      execute: async (args: unknown) => {
        const typedArgs = (args ?? {}) as JsonObject;
        captureSourceCode(capture, def.name, typedArgs);
        const result = await def.handler(typedArgs);
        captureCompiledCode(capture, def.name, result);
        return result.content[0]?.text ?? '';
      },
    }),
  );

  const agent = new LlmAgent({
    name: 'ui_generator',
    model: params.model,
    instruction: params.systemPrompt,
    tools: adkTools,
  });

  const runner = new InMemoryRunner({ agent, appName: 'ggui_generator' });
  const session = await runner.sessionService.createSession({
    appName: 'ggui_generator',
    userId: 'benchmark',
  });

  const userMessage: Content = {
    role: 'user',
    parts: [{ text: params.userPrompt }],
  };

  let finalText = '';
  let turnCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for await (const event of runner.runAsync({
    userId: 'benchmark',
    sessionId: session.id,
    newMessage: userMessage,
  })) {
    turnCount++;

    // Extract token usage from event's underlying LLM response
    const usage = event.usageMetadata;
    if (usage) {
      totalInputTokens += usage.promptTokenCount ?? 0;
      totalOutputTokens += usage.candidatesTokenCount ?? 0;
    }

    // Scan every event's content for markers and code
    if (event.content?.parts) {
      const text = event.content.parts.map((p: Part) => p.text ?? '').join('');
      if (text) captureMarkers(capture, text);
    }

    if (isFinalResponse(event)) {
      const parts = event.content?.parts;
      finalText = parts?.map((p: Part) => p.text ?? '').join('') ?? '';
    }
  }

  // Final scan of accumulated text
  if (finalText) captureMarkers(capture, finalText);

  if (!capture.compiledCode) {
    throw new Error('Google ADK adapter: no compiled code produced after all turns');
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
    turnsUsed: turnCount,
  };
}
