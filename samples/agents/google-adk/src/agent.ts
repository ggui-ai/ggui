/**
 * Google ADK (TypeScript) loop wired to a ggui MCP server.
 *
 * The agent has no built-in tools; the only tools it can call are the
 * ggui_* MCP tools exposed by the server it's pointed at. ADK's
 * `MCPToolset` discovers them via the standard MCP `tools/list`
 * handshake at agent construction time.
 *
 * This is "Zero Agent Code" with Gemini as the driver. The only
 * ggui-specific configuration is the MCP server URL + the shared
 * `GGUI_AGENT_SYSTEM_PROMPT` (posture-only; the tool descriptions and
 * MCP `initialize` instructions carry the actual wire-flow teaching).
 *
 * ADK runner events are normalized into the same SDKMessage-like
 * envelope the Claude sample emits, so the shared chat UI
 * (`src-ui/useChat.ts`) parses one shape across all sample agents.
 */
import {
  LlmAgent,
  MCPToolset,
  Runner,
  InMemorySessionService,
  InMemoryArtifactService,
} from '@google/adk';
import { GGUI_AGENT_SYSTEM_PROMPT } from '@ggui-ai/protocol';

const APP_NAME = 'ggui-agent-google-adk';

/**
 * Workaround for an upstream `@google/adk` bug — `toGeminiType` in
 * `utils/gemini_schema_util.js` calls `.toLowerCase()` on the schema's
 * `type` without checking for undefined. JSON Schema legitimately omits
 * `type` when other keywords (`oneOf` / `enum` / `anyOf`) make it
 * redundant, so any nested sub-schema that does so crashes the agent
 * on first tool-call. Sanitize each MCP tool's `inputSchema` and
 * `outputSchema` after fetch by defaulting missing `type` fields.
 *
 * Tracking: https://github.com/google/adk-js/issues/367
 * Remove this workaround once that issue ships.
 */
function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const node = schema as Record<string, unknown>;
  const out: Record<string, unknown> = { ...node };
  if (typeof out.type !== 'string') {
    // Object-shaped sub-schema (has `properties`) → 'object'; otherwise
    // 'string' is the safest passthrough for Gemini's converter.
    out.type =
      typeof out.properties === 'object' && out.properties !== null
        ? 'object'
        : 'string';
  }
  if (out.properties && typeof out.properties === 'object') {
    const props = out.properties as Record<string, unknown>;
    const sanitizedProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      sanitizedProps[k] = sanitizeSchemaForGemini(v);
    }
    out.properties = sanitizedProps;
  }
  if (out.items !== undefined) {
    out.items = sanitizeSchemaForGemini(out.items);
  }
  return out;
}

/**
 * `MCPToolset` subclass that sanitizes each fetched MCP tool's
 * `inputSchema` in place before ADK's Gemini converter sees it.
 * See {@link sanitizeSchemaForGemini}.
 */
class SanitizedMCPToolset extends MCPToolset {
  override async getTools(
    ...args: Parameters<MCPToolset['getTools']>
  ): Promise<Awaited<ReturnType<MCPToolset['getTools']>>> {
    const tools = await super.getTools(...args);
    for (const tool of tools) {
      // The MCPTool wrapper stores the raw `Tool` from
      // `@modelcontextprotocol/sdk` on a private `mcpTool` field.
      // ADK's `_getDeclaration()` reads BOTH `inputSchema` and
      // `outputSchema` and converts via `toGeminiSchema()` — sanitize
      // both before the first call. Mutating the raw fields propagates
      // the fix everywhere downstream because every read goes through
      // the same `this.mcpTool` reference.
      const internal = (
        tool as unknown as {
          mcpTool?: { inputSchema?: unknown; outputSchema?: unknown };
        }
      ).mcpTool;
      if (!internal) continue;
      if (internal.inputSchema !== undefined) {
        internal.inputSchema = sanitizeSchemaForGemini(internal.inputSchema);
      }
      if (internal.outputSchema !== undefined) {
        internal.outputSchema = sanitizeSchemaForGemini(internal.outputSchema);
      }
    }
    return tools;
  }
}

export interface RunAgentOptions {
  readonly prompt: string;
  readonly mcpUrl: string;
  readonly todoMcpUrl?: string;
  /** Default `gemini-3.5-flash`. Override via `GEMINI_MODEL`. */
  readonly model?: string;
  /** Default `process.env.GEMINI_API_KEY` (falls back to `GOOGLE_API_KEY`). */
  readonly apiKey?: string;
  /** Bearer token sent on every MCP request. Defaults to `process.env.GGUI_MCP_BEARER ?? 'dev'`. */
  readonly bearer?: string;
  /** Pass `null` to disable; omit to use canonical `GGUI_AGENT_SYSTEM_PROMPT`. */
  readonly systemPrompt?: string | null;
  /** Cancellation surface — closed-tab teardown propagates here. */
  readonly abortController?: AbortController;
  /** Userid for ADK's session bookkeeping. Default `'sample-user'`. */
  readonly userId?: string;
}

export const DEFAULT_SYSTEM_PROMPT = GGUI_AGENT_SYSTEM_PROMPT;

/**
 * Normalized message shape — mirrors the relevant subset of Anthropic's
 * SDKMessage so the shared chat UI doesn't have to know which SDK is
 * upstream.
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
  const apiKey =
    opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'runAgent: GEMINI_API_KEY required (env var, GOOGLE_API_KEY fallback, or apiKey option).',
    );
  }
  // ADK reads GOOGLE_API_KEY from the env when constructing model
  // clients; thread the resolved key through so a user with only
  // GEMINI_API_KEY set still authenticates.
  if (!process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = apiKey;

  const bearer = opts.bearer ?? process.env.GGUI_MCP_BEARER ?? 'dev';
  const model = opts.model ?? 'gemini-3.5-flash';
  const instruction =
    opts.systemPrompt === null
      ? ''
      : (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
  const userId = opts.userId ?? 'sample-user';

  // StreamableHTTPConnectionParams handles Streamable HTTP MCP
  // endpoints — the `Accept: application/json, text/event-stream`
  // header is the same content-negotiation the Streamable HTTP
  // transport uses, so the same class connects whether the server
  // speaks SSE or unary JSON responses. Bearer header carries ggui's
  // dev-mode auth. (Renamed from `SseConnectionParams` in
  // `@google/adk` 0.1.x — the streamable-HTTP transport subsumed the
  // SSE-only path.)
  const tools: MCPToolset[] = [
    new SanitizedMCPToolset({
      type: 'StreamableHTTPConnectionParams',
      url: opts.mcpUrl,
      header: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
    }),
  ];
  if (opts.todoMcpUrl) {
    tools.push(
      new SanitizedMCPToolset({
        type: 'StreamableHTTPConnectionParams',
        url: opts.todoMcpUrl,
        header: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      }),
    );
  }

  const agent = new LlmAgent({
    name: 'ggui_agent',
    model,
    description: 'A ggui-aware agent that renders interactive UI via MCP tools.',
    instruction,
    tools,
  });

  const sessionService = new InMemorySessionService();
  const artifactService = new InMemoryArtifactService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId,
  });

  const runner = new Runner({
    appName: APP_NAME,
    agent,
    artifactService,
    sessionService,
  });

  // Per-turn buffer for streamed text deltas — ADK emits incremental
  // text on partial events and the final consolidated text on the
  // completed event. We flush whenever a non-text event arrives and at
  // the end of the run, so the chat UI sees one assistant bubble per
  // assistant turn rather than a flood of partials.
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

  const abortSignal = opts.abortController?.signal;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  abortSignal?.addEventListener('abort', onAbort);

  try {
    const stream = runner.runAsync({
      sessionId: session.id,
      userId,
      newMessage: { role: 'user', parts: [{ text: opts.prompt }] },
    });

    for await (const event of stream) {
      if (aborted) break;
      const ev = event as {
        readonly content?: {
          readonly parts?: ReadonlyArray<{
            readonly text?: string;
            readonly functionCall?: {
              readonly id?: string;
              readonly name?: string;
              readonly args?: unknown;
            };
            readonly functionResponse?: {
              readonly id?: string;
              readonly name?: string;
              readonly response?: unknown;
            };
          }>;
        };
        readonly partial?: boolean;
      };

      const parts = ev.content?.parts ?? [];
      for (const part of parts) {
        // Text — buffer deltas; on a non-partial final event the
        // consolidated text replaces any partial buffer we accumulated.
        if (typeof part.text === 'string' && part.text.length > 0) {
          if (ev.partial === true) {
            textBuf += part.text;
          } else {
            // Final consolidated text. Use it as-is rather than
            // appending (avoids double-counting if the SDK emits both
            // deltas AND a final consolidated text in some configs).
            textBuf = part.text;
            const flushed = flushText();
            if (flushed) yield flushed;
          }
          continue;
        }

        // Function call → tool_use.
        if (part.functionCall && part.functionCall.name) {
          const flushed = flushText();
          if (flushed) yield flushed;
          const id = String(
            part.functionCall.id ?? `adk-tool-${Date.now()}-${Math.random()}`,
          );
          yield {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id,
                  name: String(part.functionCall.name),
                  input: part.functionCall.args ?? {},
                },
              ],
            },
          };
          continue;
        }

        // Function response → tool_result. ADK pairs the response id
        // with the matching call id; we reuse it as tool_use_id so the
        // chat UI's call-result patcher matches them.
        if (part.functionResponse && part.functionResponse.id) {
          const text = stringifyToolOutput(part.functionResponse.response);
          yield {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: String(part.functionResponse.id),
                  content: [{ type: 'text', text }],
                },
              ],
            },
          };
          continue;
        }
      }
    }

    const tail = flushText();
    if (tail) yield tail;
    yield { type: 'result', subtype: aborted ? 'aborted' : 'ok' };
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    // Best-effort close of MCP transports. ADK's MCPToolset owns the
    // underlying MCP client lifecycle; calling `close` if present
    // releases the HTTP keep-alive.
    for (const tool of tools) {
      const maybeClose = (tool as { close?: () => Promise<void> | void }).close;
      if (typeof maybeClose === 'function') {
        try {
          await maybeClose.call(tool);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }
}

function stringifyToolOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  // MCP tools commonly return `{ content: [{type:'text', text}] }`;
  // unwrap one level for a cleaner string.
  if (typeof output === 'object') {
    const obj = output as { readonly content?: unknown };
    if (Array.isArray(obj.content)) {
      const parts: string[] = [];
      for (const item of obj.content as Array<{
        readonly type?: string;
        readonly text?: unknown;
      }>) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          parts.push(item.text);
        } else {
          parts.push(JSON.stringify(item));
        }
      }
      return parts.join('\n');
    }
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
