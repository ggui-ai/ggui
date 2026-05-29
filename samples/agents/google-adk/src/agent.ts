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
 * envelope the Claude sample emits, so any MCP-Apps-spec chat UI (the
 * reference frontend at `oss/samples/apps/ggui-basic-web/` uses
 * `useMcpAppsChat` from `@ggui-ai/react/chat-helpers`) parses one shape
 * across all sample agents.
 */
import { randomUUID } from 'node:crypto';
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
 * One MCP endpoint the agent's LLM is allowed to call into. Sample-only —
 * `transport` is omitted because every ggui MCP server speaks Streamable
 * HTTP and every supported SDK's MCP client defaults to it for `http(s)://`
 * URLs. Production code with mixed transports should grow a `transport`
 * field here.
 */
export interface McpServerConfig {
  readonly url: string;
}

export interface RunAgentOptions {
  readonly prompt: string;
  /**
   * MCP endpoints the LLM can discover + call. Keys are user-chosen names
   * (`ggui`, `todo`, …); each becomes its own `MCPToolset`. `ggui` is the
   * conventional name for the primary ggui MCP server; additional keys add
   * domain MCPs alongside it.
   */
  readonly mcpServers: Record<string, McpServerConfig>;
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
  /**
   * Per-tab chat identifier from the browser's
   * `X-Chat-Id` header (auto-minted server-side when absent).
   * Keys per-chat agent state — conversation history, resume tokens,
   * ggui renderId continuity — so multi-turn flows preserve context
   * across `/chat` POSTs. Threaded through today; consumed by the
   * multi-turn-resume slice that hoists `sessionService` + `Runner`
   * to module scope and keys ADK sessions by this id.
   */
  readonly chatId?: string;
}

export const DEFAULT_SYSTEM_PROMPT = GGUI_AGENT_SYSTEM_PROMPT;

/**
 * Normalized message shape — mirrors the relevant subset of Anthropic's
 * SDKMessage so the shared chat UI doesn't have to know which SDK is
 * upstream.
 *
 * `tool_use_result` (on the `user`/`tool_result` variant) is the
 * spec-canonical channel for MCP-Apps extension metadata — it carries
 * the FULL MCP `CallToolResult` (including `structuredContent` and
 * `_meta`), letting the frontend hook (`useMcpAppsChat`) extract
 * `_meta.ui.resourceUri` to mount iframes. Anthropic's SDKMessage
 * preserves this as a sibling of `message` on each tool-result frame;
 * we mirror the shape so a single normalizer parses every SDK.
 *
 * Without `tool_use_result`, the chat panel still renders but no iframe
 * mounts — `_meta` is gone, the hook has nothing to pick up.
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
      /**
       * Full MCP `CallToolResult` from the underlying MCP client — kept
       * verbatim alongside the LLM-facing `message.content` strip so the
       * frontend hook can read `structuredContent` and `_meta.ui.*`.
       * Mirrors Anthropic SDKMessage's `tool_use_result` sibling field.
       */
      readonly tool_use_result?: McpCallToolResult;
    }
  | { readonly type: 'result'; readonly subtype: string };

/**
 * Subset of MCP `CallToolResult` the frontend hook cares about. Index
 * signature kept for forward-compat with extension fields that may land
 * on future MCP spec revisions — the hook does its own runtime
 * narrowing per `_meta.ui.*` SEP rules.
 */
export interface McpCallToolResult {
  readonly content?: ReadonlyArray<unknown>;
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

/**
 * Module-scope agent state — singletons constructed lazily on the
 * first `runAgent` call and reused across every subsequent call in
 * this process. The Runner + LlmAgent + MCPToolset[] each carry
 * non-trivial setup cost (the toolset alone does an MCP `tools/list`
 * round trip), and the `sessionService` is the
 * load-bearing piece for multi-turn — `runner.runAsync({sessionId,
 * ...})` looks history up by id, so reusing the same sessionService
 * across turns is the entire mechanism behind preserved context.
 *
 * Per-process singleton (not per-instance) is safe because each
 * sample-agent boot is its own node process: the workspace's
 * wire-scenarios e2e spawns a fresh `pnpm --filter @ggui-samples/agent-google-adk start`
 * subprocess per matrix row, and chat-server users boot one process
 * per port. A process never legitimately needs to talk to two
 * different ggui MCPs at two different URLs.
 */
interface SharedState {
  readonly sessionService: InMemorySessionService;
  readonly runner: Runner;
  readonly tools: MCPToolset[];
  readonly userId: string;
  /** Serialised form of `opts.mcpServers` — used for singleton-mismatch
   * detection on subsequent runAgent calls. */
  readonly mcpServersKey: string;
  readonly bearer: string;
  readonly model: string;
  readonly instruction: string;
}

/**
 * Order-independent stable serialisation of an mcpServers map so two
 * `runAgent` calls with the same servers (regardless of insertion order)
 * compare equal under `assertSharedStateMatches`.
 */
function serialiseMcpServers(
  mcpServers: Record<string, McpServerConfig>,
): string {
  const sorted = Object.entries(mcpServers)
    .map(([name, cfg]) => [name, cfg.url] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(sorted);
}

let sharedStateInit: Promise<SharedState> | null = null;

function buildSharedState(opts: RunAgentOptions): SharedState {
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
  // Host-session metadata (the `ai.ggui/host-session` slice on each
  // tools/call's request `_meta`) is the spec-canonical channel for
  // chat-grouping continuity — Google ADK's MCPToolset transport
  // doesn't currently expose a per-call `_meta` hook for it, so the
  // sample's `/chat/restore` (server.ts) uses the server-side
  // `ggui_list_renders` tool to rehydrate renders by `chatId`.
  // The LLM never needs to thread the host-session itself.
  const instruction =
    opts.systemPrompt === null
      ? ''
      : (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
  const userId = opts.userId ?? 'sample-user';

  // Translate the brand-agnostic `mcpServers` map into one ADK MCPToolset
  // per entry. StreamableHTTPConnectionParams handles Streamable HTTP MCP
  // endpoints — the `Accept: application/json, text/event-stream` header
  // is the same content-negotiation the Streamable HTTP transport uses,
  // so the same class connects whether the server speaks SSE or unary
  // JSON responses. Bearer header carries ggui's dev-mode auth. (Renamed
  // from `SseConnectionParams` in earlier `@google/adk` releases — the
  // streamable-HTTP transport subsumed the SSE-only path.)
  const tools: MCPToolset[] = Object.values(opts.mcpServers).map(
    (cfg) =>
      new MCPToolset({
        type: 'StreamableHTTPConnectionParams',
        url: cfg.url,
        header: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      }),
  );

  const agent = new LlmAgent({
    name: 'ggui_agent',
    model,
    description: 'A ggui-aware agent that renders interactive UI via MCP tools.',
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
  // sockets; closing on SIGTERM/SIGINT releases them cleanly so the
  // ggui MCP doesn't see lingering half-open connections after a
  // sample agent reboot. Per-call close (the pre-singleton pattern)
  // was wrong: it tore down keep-alive every turn AND re-ran
  // `tools/list` on every reconnect.
  const onShutdown = async (): Promise<void> => {
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
  };
  process.once('SIGTERM', onShutdown);
  process.once('SIGINT', onShutdown);

  return {
    sessionService,
    runner,
    tools,
    userId,
    mcpServersKey: serialiseMcpServers(opts.mcpServers),
    bearer,
    model,
    instruction,
  };
}

/**
 * Verify subsequent `runAgent` calls aren't trying to reconfigure the
 * latched singleton. Distinct URLs / models / bearers / system
 * prompts would silently route prompts at the previously-initialised
 * agent — surface loudly instead of pretending to honour the new
 * config.
 */
function assertSharedStateMatches(
  state: SharedState,
  opts: RunAgentOptions,
): void {
  const expectModel = opts.model ?? 'gemini-3.5-flash';
  const expectBearer =
    opts.bearer ?? process.env.GGUI_MCP_BEARER ?? 'dev';
  const expectInstruction =
    opts.systemPrompt === null
      ? ''
      : (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
  const expectMcpServersKey = serialiseMcpServers(opts.mcpServers);
  const mismatches: string[] = [];
  if (state.mcpServersKey !== expectMcpServersKey)
    mismatches.push(`mcpServers ${state.mcpServersKey} → ${expectMcpServersKey}`);
  if (state.bearer !== expectBearer)
    mismatches.push('bearer');
  if (state.model !== expectModel)
    mismatches.push(`model ${state.model} → ${expectModel}`);
  if (state.instruction !== expectInstruction)
    mismatches.push('systemPrompt');
  if (mismatches.length > 0) {
    throw new Error(
      `runAgent: per-call config differs from singleton init — ${mismatches.join(', ')}. ` +
        `Module-scoped agent state is one-shot per process; restart the process to reconfigure.`,
    );
  }
}

export async function* runAgent(
  opts: RunAgentOptions,
): AsyncIterable<NormalizedMessage> {
  // Lazy singleton init. `sharedStateInit` guards against concurrent
  // first-call races: two `/chat` POSTs that land before init
  // finishes share the same promise and resolve to the same state.
  if (!sharedStateInit) {
    sharedStateInit = Promise.resolve().then(() => buildSharedState(opts));
  }
  const state = await sharedStateInit;
  assertSharedStateMatches(state, opts);

  // Per-tab chat session id from the browser; auto-mint if absent so
  // direct (non-browser) callers still get a session — they just
  // won't share history across calls.
  const chatId = opts.chatId ?? randomUUID();

  // Get-or-create the ADK session under our chatId. The
  // sessionService stores conversation history keyed by sessionId;
  // `runner.runAsync({sessionId})` hydrates that history before
  // invoking the model, which is the entire mechanism behind
  // multi-turn context preservation.
  let session = await state.sessionService.getSession({
    appName: APP_NAME,
    userId: state.userId,
    sessionId: chatId,
  });
  if (!session) {
    session = await state.sessionService.createSession({
      appName: APP_NAME,
      userId: state.userId,
      sessionId: chatId,
    });
  }

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

  // Rehydrated-iframe click handling lives on the FRONTEND now —
  // `@ggui-ai/react/chat-helpers` synthesizes the
  // `[GGUI_USER_ACTION]` directive prompt client-side before POSTing
  // to `/chat`, so this backend stays brand-agnostic and never sees
  // the MCP-Apps `_meta["ai.ggui/userAction"]` slice itself. The
  // prompt arrives ready to feed the LLM.
  try {
    const stream = state.runner.runAsync({
      sessionId: session.id,
      userId: state.userId,
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
        //
        // `functionResponse.response` is the FULL MCP `CallToolResult`
        // verbatim (ADK's MCPTool.runAsync returns the @modelcontextprotocol/sdk
        // Client's callTool response unmodified, and ADK's
        // `buildResponseEvent` parks it on `response` as-is when it's
        // already an object). Lift it onto `tool_use_result` (sibling
        // of `message`) so the frontend hook reads `structuredContent`
        // and `_meta.ui.resourceUri` — the spec-canonical channel for
        // MCP-Apps iframe-mount metadata. Matches Anthropic SDK's
        // SDKMessage shape; one frontend normalizer for every SDK.
        if (part.functionResponse && part.functionResponse.id) {
          const fullResult = extractCallToolResult(part.functionResponse.response);
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
    abortSignal?.removeEventListener('abort', onAbort);
    // NOTE: do NOT close MCPToolset here. The toolset is a process-
    // lifetime singleton shared across every `/chat` POST — closing
    // per-call would tear down HTTP keep-alive + force an MCP
    // `tools/list` round trip on every turn. Shutdown is registered
    // as a SIGTERM/SIGINT handler inside `buildSharedState`.
  }
}

/**
 * Narrow ADK's untyped `functionResponse.response` into our
 * `McpCallToolResult` shape. Returns the original object (preserving
 * `structuredContent` + `_meta`) when it looks like an MCP CallToolResult,
 * `undefined` otherwise (primitive or no usable shape).
 *
 * We deliberately don't validate field-by-field — the MCP spec allows
 * extension fields on `_meta`, and ADK's `buildResponseEvent` wraps
 * non-object responses in `{result: <value>}` which is a separate shape
 * the chat UI doesn't need to render as an iframe-mount anyway.
 */
function extractCallToolResult(response: unknown): McpCallToolResult | undefined {
  if (response === null || typeof response !== 'object') return undefined;
  return response as McpCallToolResult;
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
