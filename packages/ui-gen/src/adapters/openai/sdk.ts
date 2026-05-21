// packages/ui-gen/src/adapters/openai/sdk.ts
//
// OpenAI adapter using @openai/agents SDK.
// Creates an Agent with function tools and runs it via run().

import { GeneratorAdapter, hasCredentials } from '../base';
import type { AdapterConfig, GenerateParams } from '../base';
import type { AdapterResult, ProviderName, AdapterMode } from '../types';
import {
  createCapture,
  captureSourceCode,
  captureCompiledCode,
  captureMarkers,
  extractCodeFromText,
} from '../extract-code';
import type { JsonObject } from '@ggui-ai/protocol';

async function loadOpenAIAgents() {
  return import('@openai/agents');
}

export class OpenAiSdkAdapter extends GeneratorAdapter {
  readonly provider: ProviderName = 'openai';
  readonly mode: AdapterMode = 'sdk';
  readonly displayName = 'OpenAI (Agents SDK)';

  constructor(config: AdapterConfig = {}) {
    super(config);
  }

  isAvailable(): boolean {
    return hasCredentials(this.config, 'OPENAI_API_KEY');
  }

  async generate(params: GenerateParams): Promise<AdapterResult> {
    const startTime = Date.now();

    const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;
    if (apiKey) process.env.OPENAI_API_KEY = apiKey;

    const capture = createCapture();

    // Build tools that call our handlers and capture compile results
    const { Agent, run, tool } = await loadOpenAIAgents();

    const wiredTools = params.tools.map((def) =>
      tool({
        name: def.name,
        description: def.description,
        parameters: def.inputSchema,
        execute: async (args) => {
          const typedArgs = (args ?? {}) as JsonObject;
          captureSourceCode(capture, def.name, typedArgs);

          const result = await def.handler(typedArgs);
          captureCompiledCode(capture, def.name, result);

          return result.content[0]?.text ?? '';
        },
      }),
    );

    const agent = new Agent({
      name: 'ui-generator',
      instructions: params.systemPrompt,
      model: params.model,
      tools: wiredTools,
    });

    const result = await run(agent, params.userPrompt, {
      maxTurns: params.maxTurns,
    });

    const finalOutput = String(result.finalOutput ?? '');

    // Scan final output for streamSpec/generatorMeta markers
    if (finalOutput) captureMarkers(capture, finalOutput);

    // Fallback: extract code from text output if no tool call produced it
    if (!capture.compiledCode) {
      await extractCodeFromText(finalOutput, params.tools, capture);

      if (!capture.compiledCode) {
        throw new Error('OpenAI SDK adapter: no compiled code produced after all turns');
      }
    }
    const usage = result.state.usage;
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;

    return {
      compiledCode: capture.compiledCode,
      sourceCode: capture.sourceCode,
      stream: capture.stream,
      generatorMeta: capture.generatorMeta,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens,
      },
      generationTimeMs: Date.now() - startTime,
      turnsUsed: result.rawResponses?.length ?? 0,
    };
  }
}
