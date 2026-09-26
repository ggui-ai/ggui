/**
 * `LLMCaller` — the negotiator's LLM dispatcher.
 *
 * Narrow abstraction over "call a chat model, optionally with a forced
 * tool-use schema for guaranteed-JSON structured output." Kept public
 * so OSS consumers of `@ggui-ai/negotiator` can bring their own LLM
 * provider (Anthropic direct, OpenAI, Google, a local model, a
 * community LiteLLM wrapper) without touching the synthesis / judge
 * source.
 *
 * **Why this lives in `@ggui-ai/negotiator`, not
 * `@ggui-ai/mcp-server-core`.** `mcp-server-core` contains the
 * storage + runtime seams an MCP server implementer binds against
 * (`VectorStore`, `EmbeddingProvider`, `KeyValueStore`,
 * `BlueprintProvider`). `LLMCaller` is an engine-internal
 * dispatcher — one level below the synthesis + judge primitives this
 * package exports — so lifting it to `mcp-server-core` would grow the
 * public seam count speculatively. If a second consumer outside the
 * negotiator surfaces later, the "where does `LLMCaller` live?"
 * question can be re-opened at that point.
 *
 * Normative semantics:
 * - `call(systemPrompt, userMessage, maxTokens?)` returns the raw
 *   model text. Implementations MUST NOT inject tool-use blocks when
 *   the caller didn't request them — the text path is used as a
 *   regex-JSON fallback.
 * - `callStructured?(...)` is OPTIONAL. When present, it MUST
 *   return the input of the supplied `ToolSchema`'s tool, as the model
 *   produced it (`unknown`: the caller parses it; ggui#1317), or THROW —
 *   never return anything else. It forces the tool
 *   where the model allows that; a model that refuses a forced tool
 *   (the always-thinking family) is asked for it without forcing, so
 *   the call can end with no tool input, and that ending is a throw.
 *   Consumers validate what they get back either way. Implementations
 *   that can't produce tool input at all simply omit this method;
 *   consumers fall back to `call` + regex JSON extraction. Absence is
 *   not an error.
 * - `callStructuredMetered?(...)` is OPTIONAL: `callStructured`'s contract
 *   (the tool input, or a throw), with the call's token usage beside it
 *   as the provider reported it. `usage` is ABSENT when the provider
 *   reported none, never zeros: a consumer reads absence as "unmetered".
 *   A consumer that has it prefers it to `callStructured`; an
 *   implementation that cannot read usage omits it, and every caller
 *   written without it keeps compiling. It is a method rather than a
 *   usage callback because judges run concurrently, and a result carries
 *   its own usage where a callback would need correlating to its call.
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

/** Tokens one provider call consumed, as the provider reported them. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
}

/** A call's result with the usage the provider reported for it; `usage` absent = unmetered. */
export interface Metered<T> {
  readonly value: T;
  readonly usage?: TokenUsage;
}

/** Chat-model dispatcher consumed by the negotiator's synthesis + judge primitives. */
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
   * Call for the supplied tool's input as structured JSON — forced
   * where the model allows it, requested otherwise; throws when the
   * turn ends without it (see the normative semantics above).
   * Implementations that can't produce tool input at all should omit
   * this method — consumers detect absence and fall back to regex JSON
   * extraction on the text path.
   */
  callStructured?(
    systemPrompt: string,
    userMessage: string,
    tool: ToolSchema,
    maxTokens?: number,
  ): Promise<unknown>;

  /**
   * {@link callStructured}, with the call's token usage beside the tool
   * input (see the normative semantics above). Omit it when the provider's
   * usage cannot be read; consumers then fall back to `callStructured` and
   * treat the call as unmetered.
   */
  callStructuredMetered?(
    systemPrompt: string,
    userMessage: string,
    tool: ToolSchema,
    maxTokens?: number,
  ): Promise<Metered<unknown>>;
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
