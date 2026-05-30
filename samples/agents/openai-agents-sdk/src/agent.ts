/**
 * OpenAI Agents SDK adapter for `@ggui-ai/agent-server`.
 *
 * Implements the `AgentAdapter` contract: receives prompt + chatId +
 * MCP server map per request and yields normalized SDK messages.
 * Every ggui-coupled concern (HTTP, SSE, MCP routing, tool-result
 * resource inlining, directive synthesis, auth, chat ownership)
 * lives in the library — this file only knows about the OpenAI
 * SDK's native event stream.
 *
 * Brand-agnostic: no imports from
 * `@ggui-ai/protocol/integrations/mcp-apps`. The library handles
 * every `_meta.ui.*` / `_meta.ai.ggui/*` slice.
 */
import { Agent, MCPServerStreamableHttp, run } from '@openai/agents';
import { GGUI_AGENT_SYSTEM_PROMPT } from '@ggui-ai/protocol';
import type {
  AgentAdapter,
  AgentInput,
  NormalizedMessage,
} from '@ggui-ai/agent-server';
import {
  FullResultMcpServerStreamableHttp,
  dequeueFullResult,
} from './mcp-server-with-full-result.js';

export interface OpenAiAgentAdapterOptions {
  /** Default `gpt-5.5`. Override per-process via env. */
  readonly model?: string;
  /** Default `process.env.OPENAI_API_KEY`. */
  readonly apiKey?: string;
}

/**
 * Per-process map of chat id → the last response id the OpenAI
 * Responses API minted. Passed as `previousResponseId` on subsequent
 * turns so the model sees the full conversation history
 * (server-side state lives on OpenAI's infrastructure; the SDK
 * doesn't persist anything itself — we just track the cursor).
 */
const knownResponseIds = new Map<string, string>();

export function createOpenAiAgentAdapter(
  opts: OpenAiAgentAdapterOptions = {},
): AgentAdapter {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'createOpenAiAgentAdapter: OPENAI_API_KEY required (env var or apiKey option).',
    );
  }
  // The SDK reads OPENAI_API_KEY from the env at request time.
  if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = apiKey;
  const model = opts.model ?? 'gpt-5.5';

  return {
    name: 'openai-agents-sdk',
    run(input: AgentInput): AsyncIterable<NormalizedMessage> {
      return runOnce({ input, model });
    },
  };
}

async function* runOnce(args: {
  readonly input: AgentInput;
  readonly model: string;
}): AsyncIterable<NormalizedMessage> {
  const { input, model } = args;

  // Translate the library's brand-agnostic mcpServers map into the
  // SDK's native `MCPServerStreamableHttp[]` shape. Map keys
  // become each server's `name` so the SDK can prefix tool calls.
  //
  // `FullResultMcpServerStreamableHttp` captures the FULL MCP
  // CallToolResult (including `structuredContent` + `_meta`) on
  // a per-server FIFO queue — needed because the SDK's default
  // `callTool` strips to `parsed.content`. The normalizer below
  // lifts the captured result onto `tool_use_result`.
  const mcpServers: MCPServerStreamableHttp[] = [];
  for (const [name, cfg] of Object.entries(input.mcpServers)) {
    mcpServers.push(
      new FullResultMcpServerStreamableHttp({
        url: cfg.url,
        name,
        bearer: cfg.bearer,
      }),
    );
  }

  // Library passes the OS-level system prompt verbatim — `null`
  // means "operator asked for no instruction"; absent means "use
  // the canonical GGUI_AGENT_SYSTEM_PROMPT default". The SDK's
  // `instructions` field is the SDK-native equivalent of a system
  // prompt for the Responses API.
  const instructions =
    input.systemPrompt === null
      ? undefined
      : (input.systemPrompt ?? GGUI_AGENT_SYSTEM_PROMPT);

  const agent = new Agent({
    name: 'ggui-agent',
    model,
    ...(instructions ? { instructions } : {}),
    mcpServers,
  });

  try {
    for (const server of mcpServers) await server.connect();
    const toolNameToServer = new Map<string, string>();
    for (const server of mcpServers) {
      const tools = await server.listTools();
      for (const tool of tools) {
        toolNameToServer.set(tool.name, server.name);
      }
    }

    const previousResponseId = knownResponseIds.get(input.chatId);
    // We deliberately do NOT forward `input.abortSignal` to the SDK.
    // `@openai/agents-core` reacts to an aborted signal by calling
    // `ReadableStream.cancel()` on its result stream — but the `for await`
    // below holds the reader lock, so that cancel throws
    // `ERR_INVALID_STATE: ReadableStream is locked`. That throw fires inside
    // the SDK's own AbortSignal listener (via process.nextTick), so it is
    // UNCAUGHT and crashes the whole agent process on the first client
    // disconnect / page reload. Instead we honor abort cooperatively: break
    // the loop (below) and let the for-await's `iterator.return()` tear the
    // stream down cleanly from the lock-holder side.
    const stream = await run(agent, input.prompt, {
      stream: true,
      ...(previousResponseId ? { previousResponseId } : {}),
    });

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
      // Cooperative abort: agent-server aborts `input.abortSignal` when the
      // SSE client disconnects (reload). Stop consuming so the for-await's
      // `iterator.return()` releases the reader and cancels the stream
      // cleanly — instead of the SDK cancelling a reader-locked stream.
      if (input.abortSignal.aborted) break;

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

      const inner = ev.data?.event;
      if (
        inner?.type === 'response.output_text.delta' &&
        typeof inner.delta === 'string'
      ) {
        textBuf += inner.delta;
        continue;
      }

      if (
        ev.type === 'run_item_stream_event' &&
        typeof ev.name === 'string' &&
        (ev.name === 'tool_called' || ev.name === 'mcp_tool_called')
      ) {
        const flushed = flushText();
        if (flushed) yield flushed;
        const item = ev.item as
          | {
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
        const llmInput = raw?.arguments ?? raw?.input ?? {};
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id, name, input: llmInput }],
          },
        };
        continue;
      }

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
                readonly name?: string;
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
        const toolName = typeof raw?.name === 'string' ? raw.name : undefined;
        const serverName =
          toolName !== undefined ? toolNameToServer.get(toolName) : undefined;
        const fullResult =
          serverName !== undefined ? dequeueFullResult(serverName) : undefined;
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
          ...(fullResult ? { tool_use_result: fullResult } : {}),
        };
        continue;
      }
    }

    const tail = flushText();
    if (tail) yield tail;
    if (stream.lastResponseId) {
      knownResponseIds.set(input.chatId, stream.lastResponseId);
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

function stringifyToolOutput(output: unknown, depth: number = 0): string {
  if (depth > 5) return typeof output === 'string' ? output : JSON.stringify(output);
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') {
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
        return stringifyToolOutput(
          (parsed as { text: string }).text,
          depth + 1,
        );
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
    for (const item of output as Array<{
      readonly type?: string;
      readonly text?: unknown;
    }>) {
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
