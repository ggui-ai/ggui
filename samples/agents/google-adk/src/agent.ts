/**
 * Google ADK adapter for `@ggui-ai/agent-server`.
 *
 * Implements the `AgentAdapter` contract: receives prompt + chatId +
 * MCP server map per request and yields normalized SDK messages.
 * Every ggui-coupled concern (HTTP, SSE, MCP routing, tool-result
 * resource inlining, directive synthesis, auth, chat ownership)
 * lives in the library — this file only knows about ADK's native
 * runner event stream.
 *
 * Brand-agnostic: no imports from
 * `@ggui-ai/protocol/integrations/mcp-apps`. The library handles
 * every `_meta.ui.*` / `_meta.ai.ggui/*` slice.
 */
import {
  LlmAgent,
  MCPToolset,
  Runner,
  InMemorySessionService,
  InMemoryArtifactService,
} from '@google/adk';
import { GGUI_AGENT_SYSTEM_PROMPT } from '@ggui-ai/protocol';
import type {
  AgentAdapter,
  AgentInput,
  McpCallToolResult,
  NormalizedMessage,
} from '@ggui-ai/agent-server';

const APP_NAME = 'ggui-agent-google-adk';
const DEFAULT_USER_ID = 'sample-user';

export interface GoogleAdkAdapterOptions {
  /** Default `gemini-3.5-flash`. */
  readonly model?: string;
  /**
   * Default `process.env.GEMINI_API_KEY` (falls back to
   * `GOOGLE_API_KEY`).
   */
  readonly apiKey?: string;
}

/**
 * Module-scope agent state. ADK's Runner + LlmAgent + MCPToolset[]
 * each carry non-trivial setup cost (toolset alone does an MCP
 * tools/list round trip), and the `sessionService` is the
 * load-bearing piece for multi-turn — `runner.runAsync({sessionId})`
 * hydrates history by id, so reusing the same sessionService across
 * turns is the entire mechanism behind preserved context.
 *
 * Lazy singleton because the library passes mcpServers + system
 * prompt per request — we latch on the first call.
 */
interface SharedState {
  readonly sessionService: InMemorySessionService;
  readonly runner: Runner;
  readonly tools: MCPToolset[];
  readonly model: string;
  readonly instruction: string;
  readonly mcpServersKey: string;
  readonly bearer: string;
}

function serialiseMcpServers(
  mcpServers: AgentInput['mcpServers'],
): string {
  const sorted = Object.entries(mcpServers)
    .map(([name, cfg]) => [name, cfg.url] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(sorted);
}

export function createGoogleAdkAdapter(
  opts: GoogleAdkAdapterOptions = {},
): AgentAdapter {
  const apiKey =
    opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'createGoogleAdkAdapter: GEMINI_API_KEY required (env var, GOOGLE_API_KEY fallback, or apiKey option).',
    );
  }
  // ADK reads GOOGLE_API_KEY from env at model-client construction.
  if (!process.env.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = apiKey;
  const model = opts.model ?? 'gemini-3.5-flash';

  let sharedStateInit: Promise<SharedState> | null = null;

  function buildSharedState(input: AgentInput): SharedState {
    const instruction =
      input.systemPrompt === null
        ? ''
        : (input.systemPrompt ?? GGUI_AGENT_SYSTEM_PROMPT);

    // One MCPToolset per server. Bearer is the library-resolved one
    // per server entry — uniformly threaded as the auth header.
    const tools: MCPToolset[] = Object.values(input.mcpServers).map(
      (cfg) =>
        new MCPToolset({
          type: 'StreamableHTTPConnectionParams',
          url: cfg.url,
          header: {
            Authorization: `Bearer ${cfg.bearer}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
        }),
    );

    const agent = new LlmAgent({
      name: 'ggui_agent',
      model,
      description:
        'A ggui-aware agent that renders interactive UI via MCP tools.',
      instruction,
      tools,
    });

    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      artifactService,
      sessionService,
    });

    // Process-shutdown cleanup. ADK's MCPToolset owns HTTP keep-alive
    // sockets; closing on SIGTERM/SIGINT releases them cleanly.
    const onShutdown = async (): Promise<void> => {
      for (const tool of tools) {
        const maybeClose = (tool as { close?: () => Promise<void> | void })
          .close;
        if (typeof maybeClose === 'function') {
          try {
            await maybeClose.call(tool);
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    };
    process.once('SIGTERM', onShutdown);
    process.once('SIGINT', onShutdown);

    return {
      sessionService,
      runner,
      tools,
      model,
      instruction,
      mcpServersKey: serialiseMcpServers(input.mcpServers),
      bearer: Object.values(input.mcpServers)[0]?.bearer ?? '',
    };
  }

  function assertSharedStateMatches(
    state: SharedState,
    input: AgentInput,
  ): void {
    const expectInstruction =
      input.systemPrompt === null
        ? ''
        : (input.systemPrompt ?? GGUI_AGENT_SYSTEM_PROMPT);
    const expectMcpServersKey = serialiseMcpServers(input.mcpServers);
    const mismatches: string[] = [];
    if (state.mcpServersKey !== expectMcpServersKey) {
      mismatches.push(
        `mcpServers ${state.mcpServersKey} → ${expectMcpServersKey}`,
      );
    }
    if (state.instruction !== expectInstruction) {
      mismatches.push('systemPrompt');
    }
    if (mismatches.length > 0) {
      throw new Error(
        `google-adk adapter: per-call config differs from singleton init — ${mismatches.join(', ')}. ` +
          `Module-scoped agent state is one-shot per process; restart the process to reconfigure.`,
      );
    }
  }

  return {
    name: 'google-adk',
    run(input: AgentInput): AsyncIterable<NormalizedMessage> {
      return runOnce({
        input,
        getState: async () => {
          if (!sharedStateInit) {
            sharedStateInit = Promise.resolve().then(() =>
              buildSharedState(input),
            );
          }
          const state = await sharedStateInit;
          assertSharedStateMatches(state, input);
          return state;
        },
      });
    },
  };
}

async function* runOnce(args: {
  readonly input: AgentInput;
  readonly getState: () => Promise<SharedState>;
}): AsyncIterable<NormalizedMessage> {
  const { input, getState } = args;
  const state = await getState();

  // Get-or-create the ADK session keyed by chatId. The
  // sessionService stores conversation history by sessionId;
  // `runner.runAsync({sessionId})` hydrates that history before
  // invoking the model — the mechanism behind multi-turn context.
  let session = await state.sessionService.getSession({
    appName: APP_NAME,
    userId: DEFAULT_USER_ID,
    sessionId: input.chatId,
  });
  if (!session) {
    session = await state.sessionService.createSession({
      appName: APP_NAME,
      userId: DEFAULT_USER_ID,
      sessionId: input.chatId,
    });
  }

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

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  input.abortSignal.addEventListener('abort', onAbort);

  try {
    const stream = state.runner.runAsync({
      sessionId: session.id,
      userId: DEFAULT_USER_ID,
      newMessage: { role: 'user', parts: [{ text: input.prompt }] },
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
        if (typeof part.text === 'string' && part.text.length > 0) {
          if (ev.partial === true) {
            textBuf += part.text;
          } else {
            textBuf = part.text;
            const flushed = flushText();
            if (flushed) yield flushed;
          }
          continue;
        }

        if (part.functionCall && part.functionCall.name) {
          const flushed = flushText();
          if (flushed) yield flushed;
          const id = String(
            part.functionCall.id ??
              `adk-tool-${Date.now()}-${Math.random()}`,
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

        if (part.functionResponse && part.functionResponse.id) {
          // `functionResponse.response` is the FULL MCP
          // `CallToolResult` verbatim (ADK preserves
          // structuredContent + _meta). Lift onto `tool_use_result`
          // so the library's tool-result interceptor can read
          // `_meta.ui.resourceUri` and inline the resource.
          const fullResult = extractCallToolResult(
            part.functionResponse.response,
          );
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
            ...(fullResult ? { tool_use_result: fullResult } : {}),
          };
          continue;
        }
      }
    }

    const tail = flushText();
    if (tail) yield tail;
    yield { type: 'result', subtype: aborted ? 'aborted' : 'ok' };
  } finally {
    input.abortSignal.removeEventListener('abort', onAbort);
  }
}

function extractCallToolResult(
  response: unknown,
): McpCallToolResult | undefined {
  if (response === null || typeof response !== 'object') return undefined;
  return response as McpCallToolResult;
}

function stringifyToolOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
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
