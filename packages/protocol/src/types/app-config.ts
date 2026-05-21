/**
 * How a ggui app surfaces in MCP-Apps-capable hosts (Claude Desktop,
 * claude.ai, future spec-compliant clients).
 *
 *   - `'inline'` (default): each `ggui_push` returns its own `ui://`
 *     resource; the host mounts one iframe per push as a chat-message
 *     widget. Today's behavior.
 *   - `'canvas'`: `ggui_new_session` mints a single session-scoped
 *     iframe (`ui://ggui/session/<sessionId>`) that persists for the
 *     session; `ggui_push` delivers state via WebSocket to that
 *     canvas. The canvas owns its own navigation stack + animator
 *     chrome.
 *
 * Selecting `'canvas'` does NOT guarantee canvas rendering — the host
 * may not support fullscreen / pip display modes. The canvas degrades
 * gracefully to inline-style rendering when host capability is
 * missing.
 *
 * Distinct from `defaultShellType`. `defaultShellType` controls how
 * the LLM-generated UI adapts to its chrome (chat-card / fullscreen
 * swipe / spatial floating). `defaultMcpAppsMode` controls how the
 * MCP host presents ggui's iframe (one-per-push card / one-per-session
 * canvas). Same app may set `defaultShellType: 'fullscreen'` AND
 * `defaultMcpAppsMode: 'canvas'` — they're orthogonal concerns.
 *
 * 
 */
export type McpAppsMode = 'inline' | 'canvas';

/**
 * Public display configuration for a ggui app.
 * Returned by the app config endpoint — no secrets, no auth required.
 */
export interface AppDisplayConfig {
  appId: string;
  name: string;
  defaultShellType: 'chat' | 'fullscreen' | 'spatial';
  themeId: string;
  defaultScreenPrompt?: string;
  designSystemPreset?: string;
  userAuthMode: string;
  /**
   * Agent invoke endpoint URL.
   *
   * Consumed by the `useInvoke` hook in `@ggui-ai/ggui-react` /
   * `@ggui-ai/ggui-react-native` — the hook POSTs the user's message +
   * history to `{endpointUrl}/invoke` and streams back the agent's
   * response (Streamable Invoke Protocol). NOT used by the
   * `ggui_handshake` → `ggui_push` mint path, which flows through MCP.
   *
   * Absent for apps without a deployed agent endpoint; `useInvoke`
   * surfaces a clear error in that case.
   */
  endpointUrl?: string;
  /**
   * How this app surfaces in MCP-Apps-capable hosts. Absent ⇒
   * `'inline'` (100% backward-compatible default). See {@link McpAppsMode}.
   * 
   */
  defaultMcpAppsMode?: McpAppsMode;
}
