// packages/ui-gen/src/harness/llm-router.ts
//
// Provider-agnostic LLM routing via LLMAgent class hierarchy.
// Each provider implements its own SDK interface with proper types.
//
// Key methods:
//   callText()       — plain text response
//   callStructured() — JSON structured output (for coding agent)
//   callWithTools()  — multi-turn agentic loop

import type Anthropic from '@anthropic-ai/sdk';
import type {
  TextBlock,
  TextBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';
import type OpenAI from 'openai';
import type {
  Response as OpenAIResponse,
  ResponseFunctionToolCall,
} from 'openai/resources/responses/responses';
import type {
  GoogleGenAI,
  Interactions,
} from '@google/genai';
import type { JsonObject } from '@ggui-ai/protocol';
import type { LLMToolDef } from '../llm.js';
import type { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { createAnthropicClient } from '../adapters/claude/client.js';
import { getBedrockModelId } from '../adapters/provider-router.js';
import {
  emitLlmTraceEvent,
  newLlmTraceId,
  summarizeTools,
} from './llm-trace-sink.js';

// `LLMToolDef` lives in `@ggui-ai/ui-gen/llm`. This file re-exports it
// so `../harness/llm-router.js` importers (evaluator.ts,
// llm-evaluator.ts, run-coding-turn.ts) can reach it here.
export type { LLMToolDef };

// =============================================================================
// Shared Types
// =============================================================================

export interface AgentConfig {
  provider: 'anthropic' | 'openai' | 'google' | 'openrouter';
  model: string;
}

export interface LLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: JsonObject;
  handler: (
    args: JsonObject,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

export interface LLMWithToolsResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  turnsUsed: number;
}

export interface LLMToolCall {
  /** Provider-specific call ID (for sendToolResult) */
  id?: string;
  name: string;
  input: JsonObject;
}

export interface LLMToolCallResponse {
  toolCalls: LLMToolCall[];
  inputTokens: number;
  outputTokens: number;
}

// Backward compat alias
export type LLMSingleTurnResponse = LLMToolCallResponse;

/** Result of executing a tool — passed to sendToolResult to close the API contract. */
export interface LLMToolResult {
  /** Tool call ID from the response (for providers that need it) */
  callId?: string;
  /** Tool name */
  name: string;
  /** Text result of executing the tool */
  result: string;
  /** Whether the tool execution failed */
  isError?: boolean;
}

// =============================================================================
// Schema helpers
// =============================================================================

/**
 * Add `additionalProperties: false` to all object schemas and ensure all
 * properties are in `required`. Required by OpenAI strict mode.
 * Recursively processes nested objects and array items.
 */
function addStrictSchemaConstraints(schema: JsonObject): JsonObject {
  const result = { ...schema };

  if (result.type === 'object' && result.properties) {
    result.additionalProperties = false;
    // All properties must be required for strict mode
    const propKeys = Object.keys(result.properties as JsonObject);
    if (!result.required || (result.required as string[]).length < propKeys.length) {
      result.required = propKeys;
    }
    // Recurse into nested properties
    const props = { ...(result.properties as JsonObject) };
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === 'object' && value !== null) {
        props[key] = addStrictSchemaConstraints(value as JsonObject);
      }
    }
    result.properties = props;
  }

  // Recurse into array items
  if (result.type === 'array' && result.items && typeof result.items === 'object') {
    result.items = addStrictSchemaConstraints(result.items as JsonObject);
  }

  return result;
}

// =============================================================================
// Error helpers
// =============================================================================

/** One-line error summary for logging — includes HTTP status, error code, and response body excerpt. */
function errorSummary(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const status = 'status' in e ? ` (${(e as { status: number }).status})` : '';
  const code = 'code' in e ? ` [${(e as { code: string }).code}]` : '';
  // Extract error body if available (Google/OpenAI SDKs attach it)
  let body = '';
  if ('error' in e && typeof (e as { error: unknown }).error === 'object') {
    const errObj = (e as { error: { message?: string } }).error;
    if (errObj?.message) body = ` body="${errObj.message.slice(0, 200)}"`;
  }
  return `${e.constructor.name}${status}${code}: ${e.message.slice(0, 120)}${body}`;
}

// =============================================================================
// LLMAgent — abstract base
// =============================================================================

export abstract class LLMAgent {
  abstract readonly provider: AgentConfig['provider'];
  private client: unknown = null;

  // ── Session state for server-side chaining ──────────────
  // Google: previous_interaction_id, OpenAI: previous_response_id
  // Enables turn 2+ to skip re-sending system prompt + history.
  // Call resetSession() between independent generation runs.
  protected lastSessionId: string | undefined;


  protected abstract resolveModel(model: string): string;
  protected abstract createClient(): Promise<unknown>;

  protected async getClient<T>(): Promise<T> {
    if (!this.client) {
      this.client = await this.createClient();
    }
    return this.client as T;
  }

  /** Text-only call — no tools */
  abstract callText(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<LLMResponse>;

  /**
   * Single-turn function calling — returns tool calls without executing them.
   * Each provider uses its native function/tool calling:
   *   - Anthropic: tool_use blocks
   *   - OpenAI: function_call output items
   *   - Google: functionCall parts
   * SDK handles JSON escaping — safe for code, diffs, and other content.
   */
  abstract callTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMToolDef[],
    toolChoice?: 'required' | 'auto',
    /**
     * Optional scoped fallback tools. If the primary tools fail with a
     * transport-class error (e.g. `malformed_tool_call` on Gemini after
     * retry exhaustion), the provider may retry once with these narrower
     * tools before throwing. Universal signal — not provider-gated.
     */
    scopedTools?: LLMToolDef[],
  ): Promise<LLMToolCallResponse>;

  /** Multi-turn agentic loop — executes tools internally */
  abstract callWithTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMTool[],
    maxTurns: number,
  ): Promise<LLMWithToolsResponse>;

  /**
   * Pre-warm cache for repeated callTools() calls with the same system prompt + tools.
   * Override in providers that support server-side context caching (e.g., Google).
   * No-op by default (Anthropic/OpenAI handle caching automatically per-request).
   */
  async warmCache(
    _model: string,
    _systemPrompt: string,
    _tools: LLMToolDef[],
    _toolChoice?: 'required' | 'auto',
  ): Promise<void> {}

  /** Cleanup any cached resources. Call after generation completes. No-op by default. */
  async cleanup(): Promise<void> {}

  /** Reset session state between independent generation runs. */
  resetSession(): void {
    this.lastSessionId = undefined;
  }

  /**
   * Send tool execution results back to the provider to close the API contract.
   * Call this after executing tools from callTools() and before the next callTools().
   *
   * For providers with server-side state (Google, OpenAI), this sends the
   * function results so the next callTools() can chain properly.
   * For stateless providers (Anthropic), this is a no-op.
   *
   * Override in providers that need it.
   */
  async sendToolResult(_results: LLMToolResult[]): Promise<void> {
    // No-op by default — Anthropic doesn't need this (stateless + auto prompt cache)
  }

  /**
   * Retry an API call with circuit breaker.
   *
   * Per-call: up to 2 retries with exponential backoff + jitter.
   * Cross-call: tracks consecutive transient failures across the agent session.
   * After 3 consecutive failures, the circuit opens — all subsequent calls
   * throw immediately without hitting the API. Since each generation session
   * creates a fresh agent (createAgent), the circuit resets naturally.
   *
   * Retries on:
   * - Network errors: fetch failed, ECONNRESET, ETIMEDOUT, UND_ERR_HEADERS_TIMEOUT
   * - Rate limits: HTTP 429
   * - Server errors: HTTP 500, 502, 503, 529 (overloaded)
   *
   * Does NOT retry on:
   * - Client errors: HTTP 400, 401, 403, 404 (bad request, wrong key, etc.)
   * - Content policy: HTTP 400 with safety/content filter
   */
  /**
   * Execute an API call. No retry — if it fails, it fails.
   * Logs the error with provider context and re-throws.
   */
  protected async apiCall<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } catch (e: unknown) {
      const ms = Date.now() - start;
      console.error(`[${this.provider}] API error after ${ms}ms: ${errorSummary(e)}`);
      throw e;
    }
  }

}

// =============================================================================
// AnthropicAgent
// =============================================================================

export class AnthropicAgent extends LLMAgent {
  readonly provider = 'anthropic' as const;

  protected resolveModel(model: string): string {
    // Bedrock IAM path — the upstream model id must be the cross-region
    // inference-profile form (`us.anthropic.*`), not the bare API id.
    if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
      return getBedrockModelId(model);
    }
    return model.startsWith('anthropic/')
      ? model.slice('anthropic/'.length)
      : model;
  }

  protected async createClient(): Promise<Anthropic | AnthropicBedrock> {
    // Bedrock IAM path: `resolveRoute` (provider-router) sets
    // CLAUDE_CODE_USE_BEDROCK=1 and clears ANTHROPIC_API_KEY for the
    // pool-funded cloud pod. Auth is the pod's IRSA role — no API key.
    // `AnthropicBedrock` is wire-compatible with `Anthropic` for the
    // `.messages` API this agent uses.
    if (process.env.CLAUDE_CODE_USE_BEDROCK === '1') {
      const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk');
      return new AnthropicBedrock({
        awsRegion:
          process.env.AWS_REGION ??
          process.env.AWS_DEFAULT_REGION ??
          'us-east-1',
      });
    }
    // SDK construction lives in `adapters/claude/client.ts`. The BYOK
    // resolver writes the raw key into `process.env.ANTHROPIC_API_KEY`
    // before this runs (see `applyRouteToEnv` in provider-router).
    return createAnthropicClient(process.env.ANTHROPIC_API_KEY);
  }

  async callText(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<LLMResponse> {
    const client = await this.getClient<Anthropic>();
    const traceId = newLlmTraceId();
    const startedAt = Date.now();
    const resolvedModel = this.resolveModel(model);

    // Use prompt caching beta API (90% discount on cached reads)
    const system: TextBlockParam[] = [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];

    try {
      const response = await this.apiCall(() =>
        client.messages.create({
          model: resolvedModel,
          max_tokens: maxTokens ?? 4096,
          system,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      );

      const usage = response.usage as typeof response.usage & {
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
      const cacheCreated = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      if (cacheCreated || cacheRead) {
        console.log(`[anthropic] callText cache: created=${cacheCreated} read=${cacheRead} input=${usage.input_tokens} output=${usage.output_tokens}`);
      }

      const text = response.content
        .filter((block): block is TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const endedAt = Date.now();
      emitLlmTraceEvent({
        id: traceId,
        at: startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        provider: 'anthropic',
        model: resolvedModel,
        kind: 'callText',
        systemPrompt,
        userPrompt,
        result: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreated,
          cacheRead,
          text,
        },
      });

      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (e) {
      const endedAt = Date.now();
      emitLlmTraceEvent({
        id: traceId,
        at: startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        provider: 'anthropic',
        model: resolvedModel,
        kind: 'callText',
        systemPrompt,
        userPrompt,
        error: { message: e instanceof Error ? e.message : String(e) },
      });
      throw e;
    }
  }

  async callTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMToolDef[],
    toolChoice: 'required' | 'auto' = 'required',
    _scopedTools?: LLMToolDef[],
  ): Promise<LLMToolCallResponse> {
    const client = await this.getClient<Anthropic>();
    const traceId = newLlmTraceId();
    const startedAt = Date.now();
    const resolvedModel = this.resolveModel(model);

    // Cache system prompt + tools via prompt caching beta (90% discount)
    const system: TextBlockParam[] = [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];

    const cachedTools: Anthropic.Tool[] = tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
      // Mark last tool to cache the entire tool list
      ...(i === tools.length - 1
        ? { cache_control: { type: 'ephemeral' as const } }
        : {}),
    }));

    try {
      // `max_tokens >= 21_334` mandates streaming on the
      // @anthropic-ai/sdk >=0.40 path (the API rejects non-streamed
      // long-form generation with `Streaming is required for
      // operations that may take longer than 10 minutes`). We still
      // want the final-message shape downstream, so use the stream
      // helper's `finalMessage()` which folds the events back to the
      // same `Message` Type the non-streaming path returned.
      const response = await this.apiCall(() =>
        client.messages
          .stream({
            model: resolvedModel,
            max_tokens: 32768,
            system,
            messages: [{ role: 'user', content: userPrompt }],
            tools: cachedTools,
            tool_choice: { type: toolChoice === 'required' ? 'any' : 'auto' },
          })
          .finalMessage(),
      );

      const usage = response.usage as typeof response.usage & {
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
      const cacheCreated = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      if (cacheCreated || cacheRead) {
        console.log(`[anthropic] callTools cache: created=${cacheCreated} read=${cacheRead} input=${usage.input_tokens} output=${usage.output_tokens}`);
      }

      const toolUses = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use',
      );

      const toolCalls = toolUses.map((tu) => ({
        id: tu.id,
        name: tu.name,
        input: (tu.input ?? {}) as JsonObject,
      }));

      const endedAt = Date.now();
      emitLlmTraceEvent({
        id: traceId,
        at: startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        provider: 'anthropic',
        model: resolvedModel,
        kind: 'callTools',
        systemPrompt,
        userPrompt,
        tools: summarizeTools(tools),
        result: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreated,
          cacheRead,
          toolCalls: toolCalls.map((c) => ({ name: c.name, input: c.input })),
        },
      });

      return {
        toolCalls,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (e) {
      const endedAt = Date.now();
      emitLlmTraceEvent({
        id: traceId,
        at: startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        provider: 'anthropic',
        model: resolvedModel,
        kind: 'callTools',
        systemPrompt,
        userPrompt,
        tools: summarizeTools(tools),
        error: { message: e instanceof Error ? e.message : String(e) },
      });
      throw e;
    }
  }

  async callWithTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMTool[],
    maxTurns: number,
  ): Promise<LLMWithToolsResponse> {
    const client = await this.getClient<Anthropic>();
    const resolvedModel = this.resolveModel(model);
    const traceId = newLlmTraceId();
    const startedAt = Date.now();

    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userPrompt },
    ];
    let totalIn = 0;
    let totalOut = 0;
    let allText = '';

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        // Same streaming requirement as callTools — see comment there.
        const response = await this.apiCall(() =>
          client.messages
            .stream({
              model: resolvedModel,
              max_tokens: 32768,
              system: systemPrompt,
              messages,
              tools: anthropicTools,
            })
            .finalMessage(),
        );
        totalIn += response.usage.input_tokens;
        totalOut += response.usage.output_tokens;

        for (const block of response.content) {
          if (block.type === 'text') allText += block.text;
        }

        const toolUses = response.content.filter(
          (b): b is ToolUseBlock => b.type === 'tool_use',
        );
        if (toolUses.length === 0) break;

        messages.push({ role: 'assistant', content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          const tool = tools.find((t) => t.name === tu.name);
          if (!tool) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: `Tool '${tu.name}' not found`,
            });
            continue;
          }
          const result = await tool.handler(
            (tu.input ?? {}) as JsonObject,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: result.content[0]?.text ?? '',
          });
        }
        messages.push({ role: 'user', content: toolResults });
      }

      const endedAt = Date.now();
      emitLlmTraceEvent({
        id: traceId,
        at: startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        provider: 'anthropic',
        model: resolvedModel,
        kind: 'callWithTools',
        systemPrompt,
        userPrompt,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        result: {
          inputTokens: totalIn,
          outputTokens: totalOut,
          text: allText,
          turnsUsed: messages.length,
        },
      });

      return {
        text: allText,
        inputTokens: totalIn,
        outputTokens: totalOut,
        turnsUsed: messages.length,
      };
    } catch (e) {
      const endedAt = Date.now();
      emitLlmTraceEvent({
        id: traceId,
        at: startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        provider: 'anthropic',
        model: resolvedModel,
        kind: 'callWithTools',
        systemPrompt,
        userPrompt,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        error: { message: e instanceof Error ? e.message : String(e) },
      });
      throw e;
    }
  }
}

// =============================================================================
// OpenAIAgent
// =============================================================================

export class OpenAIAgent extends LLMAgent {
  readonly provider = 'openai' as const;

  protected resolveModel(model: string): string {
    return model.startsWith('openai/')
      ? model.slice('openai/'.length)
      : model;
  }

  protected async createClient(): Promise<OpenAI> {
    const { default: OpenAISDK } = await import('openai');
    return new OpenAISDK({ apiKey: process.env.OPENAI_API_KEY });
  }

  async callText(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<LLMResponse> {
    const client = await this.getClient<OpenAI>();
    const response: OpenAIResponse = await this.apiCall(() =>
      client.responses.create({
        model: this.resolveModel(model),
        instructions: systemPrompt,
        input: [{ role: 'user', content: userPrompt }],
        ...(maxTokens && { max_output_tokens: maxTokens }),
      }),
    );

    let text = '';
    for (const item of response.output) {
      if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'output_text') text += part.text;
        }
      }
    }

    return {
      text,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  }

  async callTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMToolDef[],
    toolChoice: 'required' | 'auto' = 'required',
    _scopedTools?: LLMToolDef[],
  ): Promise<LLMToolCallResponse> {
    const client = await this.getClient<OpenAI>();
    // strict: true enables constrained decoding — guarantees valid JSON matching the schema.
    // Requires additionalProperties: false on all objects and all fields in required.
    const openaiTools = tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: addStrictSchemaConstraints(t.parameters),
      strict: true,
    }));

    // Consume pending tool results — prepend to input for proper contract
    const pending = this.pendingToolResults;
    this.pendingToolResults = [];
    const input = pending.length > 0
      ? [...pending, { role: 'user' as const, content: userPrompt }]
      : [{ role: 'user' as const, content: userPrompt }];

    const response: OpenAIResponse = await this.apiCall(() =>
      client.responses.create({
        model: this.resolveModel(model),
        instructions: systemPrompt,
        input,
        tools: openaiTools,
        tool_choice: toolChoice,
        store: true, // Enable response storage + server-side chaining
        ...(this.lastSessionId && { previous_response_id: this.lastSessionId }),
      }),
    );

    // Save session ID for chaining subsequent calls
    this.lastSessionId = response.id;

    // Log cache utilization
    const usage = response.usage;
    if (usage) {
      const cached = (usage as unknown as Record<string, unknown>).input_tokens_details as { cached_tokens?: number } | undefined;
      if (cached?.cached_tokens) {
        console.log(`[openai] session ${this.lastSessionId ? 'chained' : 'new'}: ${cached.cached_tokens} cached of ${usage.input_tokens} input`);
      }
    }

    const functionCalls = response.output.filter(
      (o): o is ResponseFunctionToolCall => o.type === 'function_call',
    );

    return {
      toolCalls: functionCalls.map((fc) => ({
        id: fc.call_id,
        name: fc.name,
        input: JSON.parse(fc.arguments ?? '{}') as JsonObject,
      })),
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  }

  // Pending tool results — stored by sendToolResult, consumed by next callTools
  private pendingToolResults: OpenAI.Responses.ResponseInputItem[] = [];

  override async sendToolResult(results: LLMToolResult[]): Promise<void> {
    // Store results locally — they'll be prepended to the next callTools input.
    // No API call here! Saves a round-trip.
    this.pendingToolResults = results.map((r) => ({
      type: 'function_call_output',
      call_id: r.callId ?? '',
      output: r.result,
    }));
  }

  async callWithTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMTool[],
    maxTurns: number,
  ): Promise<LLMWithToolsResponse> {
    const client = await this.getClient<OpenAI>();
    const resolvedModel = this.resolveModel(model);
    const openaiTools = tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));

    let input: OpenAI.Responses.ResponseInputItem[] = [
      { role: 'user', content: userPrompt },
    ];
    let totalIn = 0;
    let totalOut = 0;
    let allText = '';

    for (let turn = 0; turn < maxTurns; turn++) {
      const response: OpenAIResponse = await this.apiCall(() =>
        client.responses.create({
          model: resolvedModel,
          instructions: systemPrompt,
          input,
          tools: openaiTools,
        }),
      );
      totalIn += response.usage?.input_tokens ?? 0;
      totalOut += response.usage?.output_tokens ?? 0;

      const functionCalls = response.output.filter(
        (o): o is ResponseFunctionToolCall => o.type === 'function_call',
      );
      for (const item of response.output) {
        if (item.type === 'message') {
          for (const part of item.content) {
            if (part.type === 'output_text') allText += part.text;
          }
        }
      }

      if (functionCalls.length === 0) break;

      input = [
        ...(response.output as OpenAI.Responses.ResponseInputItem[]),
      ];
      for (const fc of functionCalls) {
        const tool = tools.find((t) => t.name === fc.name);
        const result = tool
          ? await tool.handler(
              JSON.parse(fc.arguments ?? '{}') as JsonObject,
            )
          : { content: [{ text: `Tool '${fc.name}' not found` }] };
        input.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: result.content[0]?.text ?? '',
        });
      }
    }

    return {
      text: allText,
      inputTokens: totalIn,
      outputTokens: totalOut,
      turnsUsed: input.length,
    };
  }
}

// =============================================================================
// GoogleAgent — uses Interactions API (server-side state, automatic caching)
// =============================================================================

export class GoogleAgent extends LLMAgent {
  readonly provider = 'google' as const;

  protected resolveModel(model: string): string {
    // Strip the LiteLLM transport prefix `gemini/` (Google AI Studio
    // route) so the GenAI SDK receives the bare model id it expects.
    // Pre-slice-#43 close-out this stripped `google/` instead — which
    // (a) doesn't match LiteLLM's `gemini/` convention and (b) silently
    // no-op'd against canonical `gemini/...` strings, then passed
    // them to the GenAI SDK which 4xx's on the prefixed form. Fixed
    // as part of the slice #43 audit. Bare ids pass through verbatim
    // (typed `LlmRoute` already guarantees wire-canonical at every
    // OSS call site).
    return model.startsWith('gemini/')
      ? model.slice('gemini/'.length)
      : model;
  }

  protected async createClient(): Promise<GoogleGenAI> {
    const { GoogleGenAI: GoogleGenAISDK } = await import('@google/genai');
    return new GoogleGenAISDK({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      httpOptions: { timeout: 300_000 }, // 5 min — Pro models can be slow
    });
  }

  async callText(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<LLMResponse> {
    const client = await this.getClient<GoogleGenAI>();


    const interaction = await this.apiCall(() =>
      client.interactions.create({
        model: this.resolveModel(model) as Interactions.Model,
        system_instruction: systemPrompt,
        input: userPrompt,
        generation_config: maxTokens ? { max_output_tokens: maxTokens } : undefined,
      }),
    );

    // Extract text from outputs
    let text = '';
    for (const output of interaction.outputs ?? []) {
      if (output.type === 'text' && 'text' in output) {
        text += (output as { text: string }).text;
      }
    }

    return {
      text,
      inputTokens: interaction.usage?.total_input_tokens ?? 0,
      outputTokens: interaction.usage?.total_output_tokens ?? 0,
    };
  }

  async callTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMToolDef[],
    _toolChoice: 'required' | 'auto' = 'required',
    scopedTools?: LLMToolDef[],
  ): Promise<LLMToolCallResponse> {
    const client = await this.getClient<GoogleGenAI>();


    const interactionTools: Interactions.Function[] = tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    const scopedInteractionTools: Interactions.Function[] | undefined = scopedTools?.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // Chain off previous interaction if available — server has system prompt + tools
    const resolvedModel = this.resolveModel(model) as Interactions.Model;

    // Consume pending tool results — prepend them to the input so the API
    // sees function_result + new prompt in one call (saves a round-trip)
    const pending = this.pendingToolResults;
    this.pendingToolResults = [];
    const input: Interactions.Interaction['input'] = pending.length > 0
      ? [...pending, { type: 'text' as const, text: userPrompt }]
      : userPrompt;

    const createInteraction = () =>
      this.lastSessionId
        ? client.interactions.create({
            model: resolvedModel,
            previous_interaction_id: this.lastSessionId,
            input,
            tools: interactionTools,
            generation_config: { max_output_tokens: 16384 },
          })
        : client.interactions.create({
            model: resolvedModel,
            system_instruction: systemPrompt,
            tools: interactionTools,
            input: userPrompt,
            generation_config: { max_output_tokens: 16384 },
          });

    // Retry up to 3 attempts for malformed_tool_call (model generates invalid JSON).
    // If all 3 fail AND scopedTools were provided, one final attempt with the
    // narrower scoped tool schema. Universal runtime-signal fallback — the
    // signal is the transport error, not the provider identity.
    let interaction!: Interactions.Interaction;
    const MAX_MALFORMED_RETRIES = 3;
    let succeeded = false;
    for (let attempt = 0; attempt < MAX_MALFORMED_RETRIES; attempt++) {
      try {
        if (attempt === 0) {
          interaction = await this.apiCall(createInteraction);
        } else {
          const jsonHint = '\n\nIMPORTANT: Your previous response had invalid JSON. Produce valid JSON in your tool call arguments.';
          const retryPrompt = userPrompt + jsonHint;
          interaction = await this.apiCall(() =>
            this.lastSessionId
              ? client.interactions.create({
                  model: resolvedModel,
                  previous_interaction_id: this.lastSessionId,
                  input: pending.length > 0
                    ? [...pending, { type: 'text' as const, text: retryPrompt }]
                    : retryPrompt,
                  tools: interactionTools,
                  generation_config: { max_output_tokens: 16384 },
                })
              : client.interactions.create({
                  model: resolvedModel,
                  system_instruction: systemPrompt,
                  tools: interactionTools,
                  input: retryPrompt,
                  generation_config: { max_output_tokens: 16384 },
                }),
          );
        }
        succeeded = true;
        break;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('malformed_tool_call') && attempt < MAX_MALFORMED_RETRIES - 1) {
          console.warn(`[google] malformed_tool_call (attempt ${attempt + 1}/${MAX_MALFORMED_RETRIES}) — retrying`);
          continue;
        }
        if (msg.includes('malformed_tool_call') && scopedInteractionTools) {
          // Exhausted primary retries — try once more with the scoped
          // tool schema. The narrower tool forces a smaller payload
          // that's less likely to trip JSON emission.
          console.warn('[google] malformed_tool_call exhausted — retrying with scoped tool schema');
          const scopedHint = '\n\nYour previous response exceeded the tool-call payload budget. Produce a SINGLE small change (≤20 lines) using the narrowed tool schema.';
          const scopedPrompt = userPrompt + scopedHint;
          try {
            interaction = await this.apiCall(() =>
              this.lastSessionId
                ? client.interactions.create({
                    model: resolvedModel,
                    previous_interaction_id: this.lastSessionId,
                    input: pending.length > 0
                      ? [...pending, { type: 'text' as const, text: scopedPrompt }]
                      : scopedPrompt,
                    tools: scopedInteractionTools,
                    generation_config: { max_output_tokens: 16384 },
                  })
                : client.interactions.create({
                    model: resolvedModel,
                    system_instruction: systemPrompt,
                    tools: scopedInteractionTools,
                    input: scopedPrompt,
                    generation_config: { max_output_tokens: 16384 },
                  }),
            );
            succeeded = true;
            break;
          } catch (e2: unknown) {
            const msg2 = e2 instanceof Error ? e2.message : String(e2);
            console.error(`[google] scoped retry FAILED: ${msg2.slice(0, 300)}`);
            throw e2;
          }
        }
        console.error(`[google] callTools FAILED: ${msg.slice(0, 300)}`);
        throw e;
      }
    }
    if (!succeeded) throw new Error('[google] callTools: exhausted retries without success');

    // Save session ID for chaining subsequent calls
    this.lastSessionId = interaction.id;

    const toolCalls = (interaction.outputs ?? [])
      .filter((o): o is Interactions.FunctionCallContent => o.type === 'function_call')
      .map((fc) => ({
        id: fc.id,
        name: fc.name,
        input: (fc.arguments ?? {}) as JsonObject,
      }));

    return {
      toolCalls,
      inputTokens: interaction.usage?.total_input_tokens ?? 0,
      outputTokens: interaction.usage?.total_output_tokens ?? 0,
    };
  }

  // Pending tool results — stored by sendToolResult, consumed by next callTools
  private pendingToolResults: Interactions.FunctionResultContent[] = [];

  override async sendToolResult(results: LLMToolResult[]): Promise<void> {
    // Store results locally — they'll be prepended to the next callTools input.
    // No API call here! Saves ~5.8s per turn.
    this.pendingToolResults = results.map((r) => ({
      type: 'function_result' as const,
      call_id: r.callId ?? '',
      name: r.name,
      result: r.result,
      is_error: r.isError,
    }));
  }

  async callWithTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMTool[],
    maxTurns: number,
  ): Promise<LLMWithToolsResponse> {
    const client = await this.getClient<GoogleGenAI>();


    const interactionTools: Interactions.Function[] = tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    let totalIn = 0;
    let totalOut = 0;
    let allText = '';
    let turnsUsed = 0;

    // Turn 1: system instruction + tools + user prompt
    let interaction = await this.apiCall(() =>
      client.interactions.create({
        model: this.resolveModel(model) as Interactions.Model,
        system_instruction: systemPrompt,
        tools: interactionTools,
        input: userPrompt,
      }),
    );

    for (let turn = 0; turn < maxTurns; turn++) {
      turnsUsed = turn + 1;

      if (interaction.usage) {
        totalIn += interaction.usage.total_input_tokens ?? 0;
        totalOut += interaction.usage.total_output_tokens ?? 0;
      }

      const outputs = interaction.outputs ?? [];

      // Collect text
      for (const output of outputs) {
        if (output.type === 'text' && 'text' in output) {
          allText += (output as { text: string }).text;
        }
      }

      // Collect function calls
      const fnCalls = outputs.filter(
        (o): o is Interactions.FunctionCallContent => o.type === 'function_call',
      );

      if (fnCalls.length === 0) break;

      // Execute tools and build function_result inputs
      const results: Interactions.FunctionResultContent[] = [];
      for (const fc of fnCalls) {
        const tool = tools.find((t) => t.name === fc.name);
        if (!tool) {
          results.push({
            type: 'function_result',
            call_id: fc.id,
            name: fc.name,
            result: JSON.stringify({ error: `Tool '${fc.name}' not found` }),
            is_error: true,
          });
          continue;
        }
        const result = await tool.handler(fc.arguments as JsonObject);
        results.push({
          type: 'function_result',
          call_id: fc.id,
          name: fc.name,
          result: result.content.map((c) => c.text).join('\n'),
        });
      }

      // Next turn: only send function results — server has the history
      interaction = await this.apiCall(() =>
        client.interactions.create({
          model: this.resolveModel(model) as Interactions.Model,
          previous_interaction_id: interaction.id,
          input: results,
        }),
      );
    }

    return {
      text: allText,
      inputTokens: totalIn,
      outputTokens: totalOut,
      turnsUsed,
    };
  }
}

// =============================================================================
// OpenRouterAgent
// =============================================================================

export class OpenRouterAgent extends LLMAgent {
  readonly provider = 'openrouter' as const;

  // Client-side session history — system prompt sent once, subsequent
  // callTools() calls append to the conversation without re-sending it.
  private sessionMessages: import('../adapters/openrouter/types').OpenRouterMessage[] = [];

  protected resolveModel(model: string): string {
    // Strip 'openrouter/' prefix — OpenRouter API expects 'provider/model'
    // e.g., 'openrouter/anthropic/claude-3.5-sonnet' → 'anthropic/claude-3.5-sonnet'
    return model.startsWith('openrouter/')
      ? model.slice('openrouter/'.length)
      : model;
  }

  override resetSession(): void {
    super.resetSession();
    this.sessionMessages = [];
  }

  protected async createClient(): Promise<unknown> {
    const { OpenRouterClient } = await import('../adapters/openrouter/client');
    return new OpenRouterClient({
      apiKey: process.env.OPENROUTER_API_KEY!,
    });
  }

  async callText(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    maxTokens?: number,
  ): Promise<LLMResponse> {
    type Client = import('../adapters/openrouter/client').OpenRouterClient;
    const client = await this.getClient<Client>();
    const resolved = this.resolveModel(model);

    const response = await this.apiCall(() =>
      client.chatCompletion({
        model: resolved,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens ?? 4096,
      }),
    );

    const text = response.choices[0]?.message.content ?? '';
    return {
      text,
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    };
  }

  async callTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMToolDef[],
    toolChoice?: 'required' | 'auto',
    _scopedTools?: LLMToolDef[],
  ): Promise<LLMToolCallResponse> {
    type Client = import('../adapters/openrouter/client').OpenRouterClient;
    const client = await this.getClient<Client>();
    const resolved = this.resolveModel(model);

    const orTools = tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Build messages — first call sends system prompt, subsequent calls reuse session
    if (this.sessionMessages.length === 0) {
      this.sessionMessages.push({ role: 'system', content: systemPrompt });
    }
    this.sessionMessages.push({ role: 'user', content: userPrompt });

    const response = await this.apiCall(() =>
      client.chatCompletion({
        model: resolved,
        messages: this.sessionMessages,
        tools: orTools,
        tool_choice: toolChoice ?? 'auto',
      }),
    );

    // Append assistant response to session history
    const choice = response.choices[0];
    if (choice?.message) {
      this.sessionMessages.push({
        role: 'assistant',
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
      });
    }

    const toolCalls = (choice?.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}') as JsonObject,
    }));

    return {
      toolCalls,
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    };
  }

  override async sendToolResult(results: LLMToolResult[]): Promise<void> {
    // Append tool results to session history — proper chat contract
    for (const r of results) {
      this.sessionMessages.push({
        role: 'tool',
        tool_call_id: r.callId,
        content: r.result,
      });
    }
  }

  async callWithTools(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    tools: LLMTool[],
    maxTurns: number,
  ): Promise<LLMWithToolsResponse> {
    type Client = import('../adapters/openrouter/client').OpenRouterClient;
    const client = await this.getClient<Client>();
    const resolved = this.resolveModel(model);

    const orTools = tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    type ORMessage = import('../adapters/openrouter/types').OpenRouterMessage;
    const messages: ORMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    let totalInput = 0;
    let totalOutput = 0;
    let turnsUsed = 0;
    let finalText = '';

    for (let turn = 0; turn < maxTurns; turn++) {
      turnsUsed = turn + 1;

      const response = await this.apiCall(() =>
        client.chatCompletion({
          model: resolved,
          messages: messages as import('../adapters/openrouter/types').OpenRouterMessage[],
          tools: orTools,
          tool_choice: 'auto',
        }),
      );

      totalInput += response.usage.prompt_tokens;
      totalOutput += response.usage.completion_tokens;

      const choice = response.choices[0];
      if (!choice) break;

      if (choice.message.content) {
        finalText = choice.message.content;
      }

      const toolCalls = choice.message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) break;

      messages.push({
        role: 'assistant',
        content: choice.message.content,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const toolDef = tools.find((t) => t.name === tc.function.name);
        let resultText: string;
        if (!toolDef) {
          resultText = JSON.stringify({ error: `Tool '${tc.function.name}' not found` });
        } else {
          const args = JSON.parse(tc.function.arguments || '{}') as JsonObject;
          const result = await toolDef.handler(args);
          resultText = result.content.map((c) => c.text).join('\n');
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
      }
    }

    return { text: finalText, inputTokens: totalInput, outputTokens: totalOutput, turnsUsed };
  }
}

// =============================================================================
// Agent Registry
// =============================================================================

/**
 * Create a fresh agent instance for the given provider.
 * Each call returns a new instance — no shared state between callers.
 */
export function createAgent(provider: AgentConfig['provider']): LLMAgent {
  switch (provider) {
    case 'anthropic':
      return new AnthropicAgent();
    case 'openai':
      return new OpenAIAgent();
    case 'google':
      return new GoogleAgent();
    case 'openrouter':
      return new OpenRouterAgent();
  }
}

// =============================================================================
// Backward-compatible free functions
// =============================================================================

export async function callLLM(
  config: AgentConfig,
  systemPrompt: string,
  userPrompt: string,
  maxTokens?: number,
): Promise<LLMResponse> {
  const start = Date.now();
  const agent = createAgent(config.provider);
  const result = await agent.callText(
    config.model,
    systemPrompt,
    userPrompt,
    maxTokens,
  );
  console.log(
    `[llm-router] ${config.provider}/${config.model} | ${Date.now() - start}ms | in=${result.inputTokens} out=${result.outputTokens}`,
  );
  return result;
}

export async function callLLMWithTools(
  config: AgentConfig,
  systemPrompt: string,
  userPrompt: string,
  tools: LLMTool[],
  maxTurns: number = 10,
): Promise<LLMWithToolsResponse> {
  const start = Date.now();
  const agent = createAgent(config.provider);
  const result = await agent.callWithTools(
    config.model,
    systemPrompt,
    userPrompt,
    tools,
    maxTurns,
  );
  console.log(
    `[llm-router] agentic ${config.provider}/${config.model} | ${Date.now() - start}ms | turns=${result.turnsUsed} | in=${result.inputTokens} out=${result.outputTokens}`,
  );
  return result;
}

