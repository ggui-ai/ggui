/**
 * `LLMCaller` — the decision engine's LLM dispatcher.
 *
 * Narrow abstraction over "call a chat model, optionally with a forced
 * tool-use schema for guaranteed-JSON structured output." Kept public
 * so OSS consumers of `@ggui-ai/negotiator` can bring their own LLM
 * provider (Anthropic direct, OpenAI, Google, a local model, a
 * community LiteLLM wrapper) without touching the decision-engine
 * source.
 *
 * **Why this lives in `@ggui-ai/negotiator`, not
 * `@ggui-ai/mcp-server-core`.** `mcp-server-core` contains the
 * storage + runtime seams an MCP server implementer binds against
 * (`VectorStore`, `EmbeddingProvider`, `KeyValueStore`,
 * `BlueprintProvider`, `Negotiator`). `LLMCaller` is an
 * engine-internal dispatcher — one level below `Negotiator` — so
 * lifting it to `mcp-server-core` would grow the public seam count
 * speculatively. If a second consumer outside the negotiator
 * surfaces later, the "where does `LLMCaller` live?" question can be
 * re-opened at that point.
 *
 * Normative semantics:
 * - `call(systemPrompt, userMessage, maxTokens?)` returns the raw
 *   model text. Implementations MUST NOT inject tool-use blocks when
 *   the caller didn't request them — the text path is used as a
 *   regex-JSON fallback.
 * - `callStructured?<T>(...)` is OPTIONAL. When present, it MUST
 *   force tool use against the supplied `ToolSchema` and return the
 *   tool input, parsed as `T`. Implementations that don't support
 *   forced structured output simply omit this method; consumers
 *   fall back to `call` + regex JSON extraction. Absence is not an
 *   error.
 * - `ToolSchema.input_schema` follows the OpenAI tool-use JSON
 *   Schema convention. Implementations that use a different
 *   tool-use protocol (e.g., Anthropic's variant) MUST translate at
 *   the adapter boundary.
 */

/** Tool schema for structured output via forced tool use. */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Chat-model dispatcher consumed by the negotiator decision engine. */
export interface LLMCaller {
  /**
   * Call the model in plain-text mode. `maxTokens` defaults to
   * something implementation-appropriate (usually 2048).
   */
  call(
    systemPrompt: string,
    userMessage: string,
    maxTokens?: number,
  ): Promise<string>;

  /**
   * Call with forced tool use for guaranteed structured JSON output.
   * Implementations that can't force tool use should omit this
   * method — consumers detect absence and fall back to regex JSON
   * extraction on the text path.
   */
  callStructured?<T>(
    systemPrompt: string,
    userMessage: string,
    tool: ToolSchema,
    maxTokens?: number,
  ): Promise<T>;
}

/**
 * Provider + model selector for factory-style LLM caller
 * construction. The `provider` enum stays narrow to the ones
 * ggui supports today; community adapters can extend by widening
 * the union at their own boundary.
 */
export interface LLMCallerConfig {
  provider: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'bedrock';
  model: string;
  apiKey?: string;
}
