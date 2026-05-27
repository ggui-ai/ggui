/**
 * OpenAI Agents SDK loop wired to a ggui MCP server.
 *
 * The agent has no built-in tools; the only tools it can call are the
 * ggui_* MCP tools exposed by the server it's pointed at. The LLM
 * decides when to call them on its own based on the tool descriptions
 * returned by MCP `tools/list`.
 *
 * This is "Zero Agent Code" with OpenAI as the driver — the only
 * ggui-specific configuration is the MCP server URL + the shared
 * GGUI_AGENT_SYSTEM_PROMPT (posture-only; the tool descriptions and
 * server `instructions` carry the actual wire-flow teaching).
 *
 * Stream events from the OpenAI SDK are normalized into the same
 * SDKMessage-like shape the Claude sample emits, so the shared chat
 * UI (`src-ui/useChat.ts`) parses one envelope shape across all
 * sample agents:
 *
 *   { type: 'assistant', message: { content: [{type:'text', text}] } }
 *   { type: 'assistant', message: { content: [{type:'tool_use', id, name, input}] } }
 *   { type: 'user',      message: { content: [{type:'tool_result', tool_use_id, content, is_error?}] } }
 *   { type: 'result',    subtype: 'ok' | 'error' | 'aborted' }
 */
import { Agent, MCPServerStreamableHttp, run } from '@openai/agents';
import { GGUI_AGENT_SYSTEM_PROMPT } from '@ggui-ai/protocol';

export interface RunAgentOptions {
  readonly prompt: string;
  readonly mcpUrl: string;
  readonly todoMcpUrl?: string;
  /** Default `gpt-5.5-2026-04-23`. Override via `OPENAI_MODEL`. */
  readonly model?: string;
  /** Default `process.env.OPENAI_API_KEY`. */
  readonly apiKey?: string;
  /** Bearer token sent on every MCP request. Defaults to `process.env.GGUI_MCP_BEARER ?? 'dev'`. */
  readonly bearer?: string;
  /**
   * System prompt nudging the model to always reach for ggui_* tools.
   * Pass `null` to disable; omit to use the canonical `GGUI_AGENT_SYSTEM_PROMPT`.
   */
  readonly systemPrompt?: string | null;
  /** Cancellation surface — closed-tab teardown propagates here. */
  readonly abortController?: AbortController;
  /**
   * Per-tab chat-session identifier from the browser's
   * `X-Chat-Session-Id` header (auto-minted server-side when absent).
   * Keys per-chat agent state — conversation history, resume tokens,
   * ggui renderId continuity — so multi-turn flows preserve context
   * across `/chat` POSTs. Threaded through today; consumed by the
   * multi-turn-resume slice that hoists agent state to module scope.
   */
  readonly chatSessionId?: string;
}

export const DEFAULT_SYSTEM_PROMPT = GGUI_AGENT_SYSTEM_PROMPT;

/**
 * Per-process map of chat-session id → the last response id the
 * OpenAI Responses API minted for that session. Passed as
 * `previousResponseId` on subsequent calls so the model sees the
 * full conversation history (server-side state lives on OpenAI's
 * infrastructure, keyed by response id; the SDK doesn't persist
 * anything itself — we just track the cursor). After a process
 * restart the map is empty and the next call starts a fresh
 * conversation, identical to a fresh tab.
 */
const knownResponseIds = new Map<string, string>();

/**
 * Normalized message shape — mirrors the relevant subset of Anthropic's
 * SDKMessage so the shared chat UI doesn't have to know which SDK is
 * upstream. Each per-SDK sample produces these shapes from its own
 * native event stream.
 */
export type NormalizedMessage =
  | {
      readonly type: 'assistant';
      readonly message: {
        readonly content: ReadonlyArray<
          | { readonly type: 'text'; readonly text: string }
          | {
              readonly type: 'tool_use';
              readonly id: string;
              readonly name: string;
              readonly input: unknown;
            }
        >;
      };
    }
  | {
      readonly type: 'user';
      readonly message: {
        readonly content: ReadonlyArray<{
          readonly type: 'tool_result';
          readonly tool_use_id: string;
          readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
          readonly is_error?: boolean;
        }>;
      };
    }
  | { readonly type: 'result'; readonly subtype: string };

export async function* runAgent(
  opts: RunAgentOptions,
): AsyncIterable<NormalizedMessage> {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'runAgent: OPENAI_API_KEY required (env var or apiKey option).',
    );
  }
  // The SDK reads OPENAI_API_KEY from the env at request time; ensure
  // it's set even if the caller passed a literal apiKey option.
  if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = apiKey;

  const bearer = opts.bearer ?? process.env.GGUI_MCP_BEARER ?? 'dev';
  const model = opts.model ?? 'gpt-5.5-2026-04-23';
  const instructions =
    opts.systemPrompt === null
      ? undefined
      : (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);

  // Streamable HTTP transport for ggui MCP. The SDK's underlying client
  // ultimately delegates to @modelcontextprotocol/sdk; the bearer header
  // is plumbed via `requestInit` so every request carries
  // `Authorization: Bearer <token>` for ggui's dev-mode auth.
  const gguiMcp = new MCPServerStreamableHttp({
    url: opts.mcpUrl,
    name: 'ggui',
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });

  const mcpServers: Array<MCPServerStreamableHttp> = [gguiMcp];
  if (opts.todoMcpUrl) {
    mcpServers.push(
      new MCPServerStreamableHttp({
        url: opts.todoMcpUrl,
        name: 'todo',
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      }),
    );
  }

  const agent = new Agent({
    name: 'ggui-agent',
    model,
    ...(instructions ? { instructions } : {}),
    mcpServers,
  });

  try {
    for (const server of mcpServers) await server.connect();
    // Multi-turn session continuity. The OpenAI Responses API stores
    // conversation state server-side, keyed by response id; passing
    // `previousResponseId` on the next turn loads that history before
    // the model is invoked. We track {chatSessionId → lastResponseId}
    // in `knownResponseIds` and look up the cursor here. Absent →
    // fresh conversation (first turn, or non-browser caller with no
    // chatSessionId).
    const previousResponseId = opts.chatSessionId
      ? knownResponseIds.get(opts.chatSessionId)
      : undefined;
    const stream = await run(agent, opts.prompt, {
      stream: true,
      ...(previousResponseId ? { previousResponseId } : {}),
      ...(opts.abortController ? { signal: opts.abortController.signal } : {}),
    });

    // Per-turn assistant-text buffer. The OpenAI stream emits text
    // deltas; we accumulate them and emit one normalized assistant
    // text message per completed response so the chat UI doesn't see
    // a flood of partial-character bubbles.
    let textBuf = '';
    const flushText = (): NormalizedMessage | null => {
      if (textBuf.length === 0) return null;
      const out: NormalizedMessage = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: textBuf }] },
      };
      textBuf = '';
      return out;
    };

    for await (const event of stream) {
      // The SDK exposes raw model events plus higher-level run events.
      // We inspect a small set of shapes by duck-typing. Unknown event
      // types are no-ops — they're SDK telemetry, not user-visible.
      const ev = event as {
        readonly type?: string;
        readonly data?: {
          readonly event?: {
            readonly type?: string;
            readonly delta?: string;
            readonly item?: unknown;
          };
        };
        readonly name?: string;
        readonly item?: unknown;
      };

      // Text deltas (Responses API): `data.event.type === 'response.output_text.delta'`.
      const inner = ev.data?.event;
      if (
        inner?.type === 'response.output_text.delta' &&
        typeof inner.delta === 'string'
      ) {
        textBuf += inner.delta;
        continue;
      }

      // Tool calls — emitted when the model invokes an MCP tool. The
      // SDK surfaces them as run-item events; the underlying item
      // carries the tool name + arguments + a callId we reuse as
      // tool_use_id. Per `@openai/agents-core` `FunctionCallItem`
      // docs, `callId` is "the ID of the tool call. Required to match
      // up the respective tool call result." The peer `id` field is a
      // separate per-item internal id (e.g. `fc_*`) that does NOT
      // match the result's callId (e.g. `call_*`); using it here was
      // the bug that left every tool result orphaned at "(awaiting)"
      // in the chat UI.
      if (
        ev.type === 'run_item_stream_event' &&
        typeof ev.name === 'string' &&
        (ev.name === 'tool_called' || ev.name === 'mcp_tool_called')
      ) {
        const flushed = flushText();
        if (flushed) yield flushed;
        const item = ev.item as
          | {
              readonly type?: string;
              readonly rawItem?: {
                readonly callId?: string;
                readonly id?: string;
                readonly name?: string;
                readonly arguments?: unknown;
                readonly input?: unknown;
              };
            }
          | undefined;
        const raw = item?.rawItem;
        const id = String(
          raw?.callId ?? raw?.id ?? `oa-tool-${Date.now()}-${Math.random()}`,
        );
        const name = String(raw?.name ?? 'unknown');
        const input = raw?.arguments ?? raw?.input ?? {};
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id, name, input }] },
        };
        continue;
      }

      // Tool outputs — the matching result for an earlier tool_called.
      if (
        ev.type === 'run_item_stream_event' &&
        typeof ev.name === 'string' &&
        (ev.name === 'tool_output' || ev.name === 'mcp_tool_output')
      ) {
        const item = ev.item as
          | {
              readonly rawItem?: {
                readonly callId?: string;
                readonly tool_call_id?: string;
                readonly id?: string;
                readonly output?: unknown;
                readonly content?: unknown;
                readonly isError?: boolean;
              };
            }
          | undefined;
        const raw = item?.rawItem;
        const toolUseId = String(
          raw?.callId ?? raw?.tool_call_id ?? raw?.id ?? 'unknown',
        );
        const text = stringifyToolOutput(raw?.output ?? raw?.content);
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: [{ type: 'text', text }],
                ...(raw?.isError === true ? { is_error: true } : {}),
              },
            ],
          },
        };
        continue;
      }
    }

    const tail = flushText();
    if (tail) yield tail;
    // Capture the response-id cursor so the next turn for this chat
    // session resumes the conversation. `lastResponseId` populates
    // only after the stream completes; reading it before the
    // for-await drains yields undefined. Skip the write when there's
    // no chatSessionId — the caller is single-shot, no history to
    // chain forward.
    if (opts.chatSessionId && stream.lastResponseId) {
      knownResponseIds.set(opts.chatSessionId, stream.lastResponseId);
    }
    yield { type: 'result', subtype: 'ok' };
  } finally {
    for (const server of mcpServers) {
      try {
        await server.close();
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/**
 * Tool outputs come in a variety of shapes — sometimes a plain string,
 * sometimes an MCP `content: [{type:'text', text}]` array, sometimes a
 * structured object. Reduce all of them to a single string the chat UI
 * can JSON-parse downstream (matching Claude sample's tool_result
 * handling, which expects each block to be a text string).
 *
 * `FunctionCallResultItem.output` (per @openai/agents-core protocol) is
 * a `{type:'text', text}` envelope, NOT a bare string — and OpenAI's
 * MCP adapter then nests the underlying MCP `content[0]` inside that
 * envelope's `text` as a JSON-encoded `{type:'text', text:'<payload>'}`,
 * so the actual ggui payload sits TWO wraps deep. Without recursive
 * unwrap the chat UI saw `{"type":"text","text":"…"}` and never
 * recognized the inner ggui_render envelope (no iframe mounted). Peel
 * every `{type:'text', text}` layer until the payload surfaces, with a
 * depth bound that defends against pathological inputs.
 */
function stringifyToolOutput(output: unknown, depth: number = 0): string {
  if (depth > 5) return typeof output === 'string' ? output : JSON.stringify(output);
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') {
    // Strings can themselves be JSON-encoded `{type:'text', text}`
    // envelopes — that's exactly what OpenAI's MCP adapter ships as
    // the inner `text` field. Peel one more layer when we recognize
    // the shape; otherwise return the string verbatim so non-envelope
    // payloads (the actual ggui_render JSON, for example) pass through.
    try {
      const parsed: unknown = JSON.parse(output);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        (parsed as { type: unknown }).type === 'text' &&
        'text' in parsed &&
        typeof (parsed as { text: unknown }).text === 'string'
      ) {
        return stringifyToolOutput((parsed as { text: string }).text, depth + 1);
      }
    } catch {
      /* not JSON — return string as-is */
    }
    return output;
  }
  if (
    typeof output === 'object' &&
    'type' in output &&
    (output as { type: unknown }).type === 'text' &&
    'text' in output &&
    typeof (output as { text: unknown }).text === 'string'
  ) {
    return stringifyToolOutput((output as { text: string }).text, depth + 1);
  }
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output as Array<{ readonly type?: string; readonly text?: unknown }>) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        parts.push(stringifyToolOutput(item.text, depth + 1));
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join('\n');
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
