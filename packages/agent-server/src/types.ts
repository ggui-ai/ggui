/**
 * Public types for the brand-agnostic agent-server contract.
 *
 * The split that matters: the LIBRARY owns every ggui-coupled concern
 * (HTTP, SSE, MCP discovery, tool-result resource inlining, directive
 * synthesis); the per-SDK ADAPTER owns nothing but mapping the agent
 * loop to / from {@link NormalizedMessage}s. An adapter author never
 * needs to know about renderId, userAction, host-session, or any
 * `_meta.ui.*` key.
 *
 * One normalized envelope shape across every SDK keeps the frontend
 * hook (`useMcpAppsChat`) parsing one wire.
 */

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
 * `prompt` arrives ready to feed the LLM (directive synthesis has
 * already happened when `_meta["ai.ggui/userAction"]` was present on
 * the request).
 */
export interface AgentInput {
  /**
   * The user prompt to feed the LLM. When the client posted a
   * `_meta["ai.ggui/userAction"]` slice, the library has already
   * woven it into the prompt via {@link synthesizeUserActionPrompt} —
   * adapters see one string regardless.
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
   * System prompt the operator configured. Adapters MAY ignore (most
   * SDKs prefer an SDK-native instruction parameter) or thread
   * through. `null` means "operator asked for no system prompt"; the
   * canonical `GGUI_AGENT_SYSTEM_PROMPT` default is the library's
   * fallback when the operator left it unset.
   */
  readonly systemPrompt: string | null;
  /**
   * Fires when the client disconnects (SSE socket close, fetch abort).
   * Adapters MUST stop their in-flight LLM call when this signals;
   * the library aborts the SSE write loop on the same trigger.
   */
  readonly abortSignal: AbortSignal;
}

/**
 * Brand-agnostic adapter contract. ONE async-iterable method that
 * takes prompt + chatId + MCP config and yields normalized SDK
 * messages.
 *
 * Adapters MUST stay brand-agnostic: no imports of
 * `@ggui-ai/protocol/integrations/mcp-apps`, no awareness of
 * `renderId` / `userAction` / `host-session`. The library handles
 * every ggui-coupled concern around the adapter.
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
