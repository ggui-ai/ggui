/**
 * The one Anthropic structured call: a single `/v1/messages` request
 * that asks for one tool call and returns that tool's input.
 *
 * Every structured caller that speaks to Anthropic goes through
 * {@link anthropicToolCall}, so the request shape and the failure
 * names live in one place (ggui#1271): the negotiator's LLM seam in
 * `@ggui-ai/mcp-server` (rerank judge + contract synthesizer), the
 * judge the live match probes drive in `@ggui-ai/mcp-server-handlers`,
 * and the negotiator's dev benches.
 *
 * It is a standalone function rather than a {@link ProviderAdapter}
 * method on purpose. Adapters return a result union and never throw;
 * every structured caller here wants the throw, because its consumers
 * (the rerank judge, the synthesizer) already collapse a throw to
 * their null-decision fallback and carry the message into their
 * reason. A transport failure keeps its own type: a network failure
 * rejects with `fetch`'s `TypeError`, an abort with the signal's
 * `AbortError`, and a 2xx body that is not JSON with `SyntaxError`.
 *
 * Two request shapes, chosen by the shared model rule
 * (`@ggui-ai/protocol` `anthropicRejectsForcedToolChoice`, the same list
 * the generation router reads):
 *
 *   - A model that accepts a forced tool gets
 *     `tool_choice: {type: 'tool', name}` and the caller's budget.
 *   - A model that refuses one (the always-thinking family answers a
 *     forced tool with HTTP 400) gets `tool_choice: auto` with at most
 *     one call, an instruction naming the tool appended to the system
 *     prompt, and {@link ALWAYS_THINKING_HEADROOM_TOKENS} added to the
 *     caller's budget. `strict: true` is not sent: the callers' schemas
 *     carry keywords strict tool use rejects (`minimum`/`maximum`,
 *     map-shaped `additionalProperties`), and every caller validates
 *     the input it gets back.
 *
 * No `temperature` is sent: newer tool-use models reject it with
 * HTTP 400, so callers tolerate paraphrase in field values instead.
 */
import { anthropicRejectsForcedToolChoice, isRecord } from '@ggui-ai/protocol';

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_ANSWER_BUDGET = 1024;

/**
 * Thinking budget added to the caller's ANSWER budget when the model
 * refuses a forced tool. Those models always think, their thinking
 * counts against `max_tokens`, and it comes before the tool call, so a
 * small answer budget (the rerank judge asks for 512) would be spent
 * before the `tool_use` block exists. `max_tokens` is a ceiling, not
 * spend.
 */
export const ALWAYS_THINKING_HEADROOM_TOKENS = 16_000;

/** The one tool the call asks for, in the Messages API's tool shape. */
export interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  /** The tool's input JSON Schema, sent verbatim. */
  readonly input_schema: Readonly<Record<string, unknown>>;
}

export interface AnthropicToolCallRequest {
  readonly apiKey: string;
  /** The wire model id, sent verbatim. */
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly tool: AnthropicTool;
  /** The answer budget. Absent ⇒ 1024. Headroom is added on top where the model needs it. */
  readonly maxTokens?: number;
  /** Cancels the request. */
  readonly signal?: AbortSignal;
  /** Override for tests and instrumentation. Absent ⇒ the global `fetch` at call time. */
  readonly fetch?: typeof globalThis.fetch;
  /** Override for a proxy endpoint. */
  readonly endpoint?: string;
}

/** The tool input, with the response's token usage when it reported one. */
export interface AnthropicToolCallResult {
  readonly input: unknown;
  /**
   * `usage.input_tokens` / `usage.output_tokens` when both are numbers;
   * absent otherwise. An unmetered response reports no usage, never
   * zeros. No `cache_control` is sent, so there are no cache counts.
   */
  readonly usage?: { readonly input: number; readonly output: number };
}

/** How a structured call ended without the tool input it asked for. */
export type AnthropicStructuredCallFailureKind =
  /** The budget ran out (`stop_reason: max_tokens`) before the tool call. */
  | 'max_tokens'
  /** The model finished without calling the tool (possible under `auto`). */
  | 'no_tool_call'
  /** The model declined (`stop_reason: refusal`). */
  | 'refusal'
  /** The API answered non-2xx. */
  | 'http'
  /** The body was JSON but not a Messages response. */
  | 'malformed';

/**
 * A structured call that returned no tool input, NAMED by why. The kind
 * is in the message too (`[max_tokens]` …), so a consumer that only
 * surfaces the message (the rerank judge's `reason`) still reports
 * which failure it was.
 */
export class AnthropicStructuredCallError extends Error {
  readonly kind: AnthropicStructuredCallFailureKind;
  readonly status: number | undefined;
  readonly stopReason: string | undefined;
  constructor(
    kind: AnthropicStructuredCallFailureKind,
    detail: string,
    extra: { readonly status?: number; readonly stopReason?: string } = {},
  ) {
    super(`anthropic structured call [${kind}]: ${detail}`);
    this.name = 'AnthropicStructuredCallError';
    this.kind = kind;
    this.status = extra.status;
    this.stopReason = extra.stopReason;
  }
}

/**
 * Send one structured call and return the named tool's input. Every way
 * the turn ends without that input throws an
 * {@link AnthropicStructuredCallError} whose kind says which.
 */
export async function anthropicToolCall(
  request: AnthropicToolCallRequest,
): Promise<AnthropicToolCallResult> {
  const answerBudget = request.maxTokens ?? DEFAULT_ANSWER_BUDGET;
  const refusesForcedTool = anthropicRejectsForcedToolChoice(request.model);
  const maxTokens = refusesForcedTool
    ? answerBudget + ALWAYS_THINKING_HEADROOM_TOKENS
    : answerBudget;
  const toolName = request.tool.name;
  const body = {
    model: request.model,
    max_tokens: maxTokens,
    system: refusesForcedTool
      ? `${request.systemPrompt}\n\nAnswer by calling the \`${toolName}\` tool exactly once. Do not answer in text.`
      : request.systemPrompt,
    messages: [{ role: 'user', content: request.userPrompt }],
    tools: [
      {
        name: toolName,
        description: request.tool.description,
        input_schema: request.tool.input_schema,
      },
    ],
    tool_choice: refusesForcedTool
      ? { type: 'auto', disable_parallel_tool_use: true }
      : { type: 'tool', name: toolName },
  };
  const fetchImpl = request.fetch ?? globalThis.fetch;
  const response = await fetchImpl(request.endpoint ?? DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': request.apiKey,
      'anthropic-version': DEFAULT_API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new AnthropicStructuredCallError(
      'http',
      `HTTP ${response.status}: ${text.slice(0, 500)}`,
      { status: response.status },
    );
  }
  const json: unknown = await response.json();
  if (!isRecord(json) || !Array.isArray(json['content'])) {
    throw new AnthropicStructuredCallError(
      'malformed',
      'response body is not a Messages response',
    );
  }
  const stopReason =
    typeof json['stop_reason'] === 'string' ? json['stop_reason'] : undefined;
  const toolUse = json['content'].find(
    (block: unknown): block is Record<string, unknown> =>
      isRecord(block) && block['type'] === 'tool_use' && block['name'] === toolName,
  );
  if (toolUse !== undefined && toolUse['input'] !== undefined) {
    const usage = readUsage(json['usage']);
    return { input: toolUse['input'], ...(usage !== undefined ? { usage } : {}) };
  }
  if (stopReason === 'max_tokens') {
    throw new AnthropicStructuredCallError(
      'max_tokens',
      `stop_reason=max_tokens before the "${toolName}" tool_use block (max_tokens=${maxTokens})`,
      { stopReason },
    );
  }
  if (stopReason === 'refusal') {
    throw new AnthropicStructuredCallError(
      'refusal',
      'the model declined (stop_reason=refusal)',
      { stopReason },
    );
  }
  throw new AnthropicStructuredCallError(
    'no_tool_call',
    `the turn ended (stop_reason=${stopReason ?? 'absent'}) without a "${toolName}" tool_use block`,
    stopReason !== undefined ? { stopReason } : {},
  );
}

function readUsage(usage: unknown): AnthropicToolCallResult['usage'] {
  if (!isRecord(usage)) return undefined;
  const input = usage['input_tokens'];
  const output = usage['output_tokens'];
  return typeof input === 'number' && typeof output === 'number'
    ? { input, output }
    : undefined;
}
