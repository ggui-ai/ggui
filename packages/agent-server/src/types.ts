/**
 * Public types for the brand-agnostic agent-server contract.
 *
 * The split that matters: the LIBRARY owns the host plumbing (HTTP,
 * SSE, MCP discovery, tool-result resource inlining, server-allocated
 * chat ids, auth); the per-SDK ADAPTER owns nothing but mapping the
 * agent loop to / from {@link NormalizedMessage}s. Neither knows about
 * sessionId, host-session, or any `_meta.ui.*` key — the prompt is
 * forwarded verbatim, so guest-gesture directives (authored in the
 * iframe's `ui/message` text) pass straight through.
 *
 * One normalized envelope shape across every SDK keeps the frontend
 * hook (`useMcpAppsChat`) parsing one wire.
 */
import type { AgentToolEntry } from '@ggui-ai/protocol';

/**
 * One MCP endpoint the agent's LLM is allowed to call into.
 *
 * Sample-only — `transport` is omitted because every ggui MCP server
 * speaks Streamable HTTP and every supported SDK's MCP client defaults
 * to it for `http(s)://` URLs. Production code with mixed transports
 * should grow a `transport` field here.
 */
export interface McpServerConfig {
  readonly url: string;
}

/**
 * Subset of the MCP `CallToolResult` shape this library reads from /
 * writes to. Adapters yield this as `tool_use_result` on user-role
 * messages; the tool-result interceptor mutates the `_meta.ui` slice
 * to inline a `resource` block when the server stamped a
 * `_meta.ui.resourceUri` the host should pre-resolve.
 *
 * Index signature kept for forward-compat — the MCP spec allows
 * extension fields on `_meta` we don't need to model strictly here.
 */
export interface McpCallToolResult {
  readonly content?: ReadonlyArray<unknown>;
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

/**
 * Normalized SDK-message envelope. Mirrors the relevant subset of
 * Anthropic's `SDKMessage` so the shared frontend hook
 * (`useMcpAppsChat` in `@ggui-ai/react/chat-helpers`) parses one shape
 * regardless of which SDK is upstream.
 *
 * Each per-SDK adapter is responsible for translating its native event
 * stream into this envelope.
 *
 * `tool_use_result` (on the `user`/`tool_result` variant) is the
 * spec-canonical channel for MCP-Apps extension metadata — it carries
 * the FULL MCP `CallToolResult` (including `structuredContent` and
 * `_meta`), letting the frontend hook extract `_meta.ui.resourceUri`
 * to mount iframes. The library's tool-result interceptor also reads
 * this field on the way out to inline the resource HTML.
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
          readonly content: ReadonlyArray<{
            readonly type: 'text';
            readonly text: string;
          }>;
          readonly is_error?: boolean;
        }>;
      };
      readonly tool_use_result?: McpCallToolResult;
    }
  | { readonly type: 'result'; readonly subtype: string };

/**
 * Per-adapter call payload. Threaded into {@link AgentAdapter.run} on
 * every `POST /agent` request.
 *
 * The library populates every field — adapter authors don't have to
 * mint chat ids, resolve env vars, or thread cancellation. The
 * `prompt` is the client-supplied prompt verbatim; the library is a
 * pure forwarder with no ggui-protocol awareness.
 */
export interface AgentInput {
  /**
   * The user prompt to feed the LLM, forwarded verbatim from the
   * `POST /agent` body. When a guest gesture needs to wake the agent,
   * the "call ggui_consume…" directive already lives in the
   * iframe-authored `ui/message` text the client posts as the prompt —
   * the library never rewrites it.
   */
  readonly prompt: string;
  /**
   * Server-allocated stable chat id. Lives for the lifetime of the
   * conversation; the same value rides on every POST for this chat
   * and is returned to the client on the first SSE event so the
   * browser can pin it into its URL / localStorage. Adapters use this
   * to key per-chat resume / session state inside their SDK.
   */
  readonly chatId: string;
  /**
   * MCP servers the LLM is allowed to call into. Keys are operator-
   * chosen names; `ggui` is conventional for the primary ggui MCP.
   * Each entry carries the URL + the bearer the library resolved
   * (`process.env.GGUI_MCP_BEARER` or the adapter-provided default).
   */
  readonly mcpServers: Record<
    string,
    { readonly url: string; readonly bearer: string }
  >;
  /**
   * System prompt the operator configured, as a three-way the adapter
   * MUST honor:
   *   - `undefined` → operator left it unset; the adapter applies its
   *     OWN default (e.g. the sample's `GGUI_AGENT_SYSTEM_PROMPT`).
   *   - `null` → operator explicitly asked for NO system prompt.
   *   - string → custom override.
   * Adapters MAY still ignore it when their SDK prefers a native
   * instruction parameter. The library MUST NOT collapse `undefined` to
   * `null` — doing so silently kills the adapter's default.
   */
  readonly systemPrompt: string | null | undefined;
  /**
   * Fires when the client disconnects (SSE socket close, fetch abort).
   * Adapters MUST stop their in-flight LLM call when this signals;
   * the library aborts the SSE write loop on the same trigger.
   */
  readonly abortSignal: AbortSignal;
  /**
   * Canonical agent-tool catalog the library built from the LIVE MCP
   * connection (`initialize` → serverInfo, `tools/list` → tools),
   * keyed by bare tool name. This is the tools MAP only — to stamp it
   * into `blueprintDraft.contract.agentCapabilities` the adapter MUST
   * wrap it as `{ tools: agentCapabilities }`, because
   * `DataContract.agentCapabilities` is the `AgentCapabilitiesSpec`
   * shape (`{ tools: Record<string, AgentToolEntry> }`), not the bare
   * map. Stamping it lets blueprint reuse match on the canonical
   * `(serverInfo.name, toolName)` identity + schema. ABSENT when the
   * catalog couldn't be built (e.g. an MCP server was down at boot) —
   * the agent's host then degrades to bare / within-host reuse.
   */
  readonly agentCapabilities?: Record<string, AgentToolEntry>;
}

/**
 * Brand-agnostic adapter contract. ONE async-iterable method that
 * takes prompt + chatId + MCP config and yields normalized SDK
 * messages.
 *
 * Adapters MUST stay brand-agnostic: no imports of
 * `@ggui-ai/protocol/integrations/mcp-apps`, no awareness of
 * `sessionId` / `host-session`. The library is a pure prompt-forwarder
 * + host plumbing around the adapter — the adapter/prompt path has no
 * ggui-protocol knowledge. (The library's own ggui coupling — render-
 * resource inlining, tool-identity catalog declaration — lives outside
 * this contract; it never leaks into the adapter.)
 */
export interface AgentAdapter {
  /**
   * Short name for logs / error messages. Matches the SDK identity
   * (`claude-agent-sdk`, `openai-agents-sdk`, `google-adk`).
   */
  readonly name: string;
  /**
   * Drive the agent loop for one user prompt. Yield each normalized
   * SDK message as it arrives; the library forwards them through SSE
   * + records them in the per-chat snapshot for rehydration.
   *
   * Throwing or returning early both signal end-of-stream cleanly.
   */
  run(input: AgentInput): AsyncIterable<NormalizedMessage>;
}

/**
 * Per-chat in-memory snapshot of the adapter's normalized message
 * stream. The library exposes this as the GET `/agent?chatId=X`
 * response body — the frontend hook (`useMcpAppsChat`) replays
 * `messages[]` through the same handler the live SSE stream uses so
 * iframe mounting + chat-panel rebuild are one code path.
 *
 * In-memory + non-durable on purpose: this slice mirrors how a chat
 * shell stores its current session's artifacts; cross-restart
 * persistence is a separate concern.
 */
export interface ChatStateSnapshot {
  readonly chatId: string;
  readonly messages: NormalizedMessage[];
}
