/**
 * Public display configuration for a ggui app.
 * Returned by the app config endpoint — no secrets, no auth required.
 */
import type { McpUiDisplayMode } from './host-context.js';

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
   * App-default display-mode hint stamped on every `ggui_push` from this
   * app via `_meta.ui.displayMode`. Honored by hosts as a PRESENTATION
   * preference — `'fullscreen'` says "render this as a main view,
   * replacing the previous iframe in the primary slot"; `'inline'` says
   * "stack vertically in the chat log"; `'pip'` says "render as
   * picture-in-picture overlay" (reserved).
   *
   * The wire mechanism is identical regardless of mode: every push
   * stamps its own `_meta.ui.resourceUri`, every iframe goes through
   * the same runtime mount path. Display mode controls ONLY how the
   * host arranges the iframes it mounts. Per-push agents can override
   * via `ggui_push.input.displayMode`.
   *
   * Absent ⇒ no per-push hint stamped (host falls back to its own
   * default, typically `'inline'`).
   */
  defaultDisplayMode?: McpUiDisplayMode;
}
