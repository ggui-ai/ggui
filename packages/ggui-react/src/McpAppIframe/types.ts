/**
 * Public props + imperative-ref shape for `<McpAppIframe>` — the generic
 * MCP Apps iframe host exported from `@ggui-ai/react`.
 *
 * Any React or RN app can use this to host a ggui (or any MCP Apps-
 * conformant) session. The host itself is pure MCP Apps: zero ggui-
 * specific coupling — the only side channels are the caller-provided
 * `onToolCall` callback + the renderer-emitted typed postMessage events
 * surfaced via `onError` / `onUpgradeRequired` / `onObserve`.
 */

import type { ResourceContents } from '@modelcontextprotocol/sdk/types.js';
import type {
  ObservabilityEvent,
  ProtocolError,
} from '@ggui-ai/iframe-runtime';
import type {
  GguiBootstrapMeta,
  McpAppLifecycleEvent,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { UiMessageEvent } from './dispatch.js';

/**
 * Container-dimensions hint forwarded verbatim to the iframe via
 * `ui/initialize`'s `containerDimensions` field. Every field optional —
 * absent = iframe chooses its own sensible default.
 */
export interface McpAppIframeDimensions {
  readonly width?: number;
  readonly height?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

/**
 * Permissions-Policy hint forwarded to the iframe's `allow` attribute
 * (web) / WebView permissions (RN). Spec-canonical field names — match
 * the `_meta.ui.permissions` shape MCP Apps resources declare.
 */
export interface McpAppIframePermissions {
  readonly camera?: boolean;
  readonly microphone?: boolean;
  readonly geolocation?: boolean;
  readonly clipboardWrite?: boolean;
}

/**
 * Props for `<McpAppIframe>`.
 *
 * Host obligations:
 *   - Host MUST mount iframe (web) / WebView (RN) with `src` derived
 *     from `resource`. `srcdoc` is used when `resource.text` is
 *     present (inline HTML); otherwise `src={resource.uri}`.
 *   - `ui/initialize` responses carry ONLY `{theme, containerDimensions,
 *     locale}` by default — the adapter-boundary rule, no outer-app
 *     state leaks. The optional `bootstrap` prop opens a narrow
 *     exception scoped to `_meta.ggui.bootstrap` for first-party ggui
 *     renderer iframes; see the `bootstrap` field below.
 *   - `tools/call` forwards to `onToolCall`; absent handler → reject
 *     with `{error: 'no-tool-handler'}`.
 *   - `ui/open-link` with `https?://` → delegates to window.open /
 *     Linking.openURL; other schemes → reject `unsupported-scheme`.
 *   - Unknown method → `method_not_supported`.
 */
export interface McpAppIframeProps {
  /**
   * The MCP Apps resource to render. Structurally compatible with
   * `@modelcontextprotocol/sdk`'s `ResourceContents` (same TS type).
   *
   * Shape:
   *   - `uri` — required. Identifies the resource.
   *   - `mimeType?` — ignored by this host; present for caller use.
   *   - `text?` — when present, host mounts via `srcdoc` (inline HTML).
   *   - `blob?` — when present (and no `text`), host mounts via a data
   *     URL derived from the base64 blob + `mimeType` (defaults
   *     `text/html`).
   *   - If neither `text` nor `blob` is set, host falls back to `src`
   *     pointing at `uri` — caller is responsible for the URI being
   *     `http(s)://` (the iframe loader rejects non-http schemes).
   */
  readonly resource: ResourceContents;

  /**
   * Theme CSS-var bag forwarded to `ui/initialize.result.theme`. When
   * absent, a minimal neutral default is forwarded (consumers should
   * pass their design tokens here).
   */
  readonly theme?: Record<string, string>;

  /**
   * Locale string forwarded to `ui/initialize.result.locale`. When
   * absent, `navigator.language` (web) / `'en-US'` (RN) is used.
   */
  readonly locale?: string;

  /**
   * Container-dimensions hint. Mirrored to the iframe element's style
   * AND echoed to the iframe via `ui/initialize.result.containerDimensions`
   * so the content can layout-size itself.
   */
  readonly containerDimensions?: McpAppIframeDimensions;

  /**
   * Permissions-Policy hint. Mapped to the iframe's `allow` attribute
   * (web) — the host does NOT echo this to `ui/initialize`. Absent /
   * empty object = no permissions granted (default-deny).
   */
  readonly permissions?: McpAppIframePermissions;

  /**
   * Opt-in bootstrap forwarding for first-party ggui renderer iframes.
   *
   * **When set:** the host's `ui/initialize` response gains a
   * `toolOutput._meta.ggui.bootstrap = <this value>` payload alongside
   * the existing `theme` / `containerDimensions` / `locale` adapter-
   * boundary fields. The renderer's `parseBootstrap()` (`packages/
   * renderer/src/bootstrap.ts`) reads exactly that path and uses it to
   * fetch the renderer bundle, open the WebSocket, and bootstrap the
   * session.
   *
   * **When absent (default):** behavior is unchanged — the host
   * responds with `{theme, containerDimensions, locale}` only and
   * NEVER leaks `_meta` to the iframe child. This is the correct
   * posture for any third-party MCP App iframe — opt-in here would be
   * a contract violation under the adapter-boundary rule.
   *
   * **Rule of thumb:** set this exactly when the iframe was spawned by
   * following ggui's own resource URI (`ui://ggui/session` or
   * `ui://ggui/session/<sessionId>` etc.) and the host is responsible
   * for wiring the bootstrap forward — e.g. the console's
   * `<McpAppIframe>` mount feeds it the bootstrap fetched from
   * `GET /ggui/console/session-resource`. Do NOT set this for any
   * iframe loading content authored outside ggui's session-resource
   * surface.
   *
   * **Recursive case.** The renderer itself hosts third-party MCP App
   * iframes via `packages/iframe-runtime/src/mcp-app-iframe-host.ts`.
   * That nested host MUST scrub `_meta` from its `ui/initialize`
   * responses regardless of the outer host's posture — first-party
   * forwarding does NOT cascade through to third-party content the
   * renderer is itself hosting.
   */
  readonly bootstrap?: GguiBootstrapMeta;

  /**
   * Opt-in: grant `allow-same-origin` in the iframe sandbox. Default
   * `false` — third-party MCP App iframes stay in an opaque/null
   * origin so they cannot read the host document, per the standard
   * deny-by-default posture.
   *
   * **When to set this:** the iframe loads a first-party trusted
   * surface (the operator's OWN ggui server iframe at
   * `ui://ggui/session/...`, or any URL whose origin you control).
   * Without `allow-same-origin`, the iframe runs in a null origin
   * and its same-origin XHR / WebSocket / fetch handshakes fail —
   * visible to users as ERR_CONNECTION_REFUSED inside the iframe
   * even when the server responded 200.
   *
   * **Recursive case:** the renderer's nested third-party hosts
   * scrub their own posture independent of this flag — first-party
   * trust does NOT cascade through to third-party content the
   * renderer is itself hosting.
   */
  readonly allowSameOrigin?: boolean;

  /**
   * Caller-provided handler for `tools/call` dispatches from the
   * iframe. The host forwards `(toolName, args)` and awaits; the
   * resolved value becomes the JSON-RPC `result`, rejections become
   * `-32000` errors.
   *
   * When absent, every `tools/call` from the iframe is rejected with
   * `-32000 no-tool-handler` — callers that do not supply a handler
   * have explicitly opted out of tool dispatch.
   */
  readonly onToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;

  /**
   * Surfaced on every ProtocolError the iframe postMessage'd up.
   * Hosts pattern-match on `err.kind` to choose UX. A ProtocolError
   * is ALWAYS a failure signal; happy-path telemetry flows through
   * `onObserve` instead.
   *
   * Handlers MUST NOT throw — the host already fired its own fallback
   * before invoking; a throwing handler would mask the real failure.
   */
  readonly onError?: (err: ProtocolError) => void;

  /**
   * Called when the iframe surfaces a version-handshake rejection
   * (`UPGRADE_REQUIRED`). Split out from `onError` because version
   * mismatches are typically rendered inline (prompt to update client)
   * rather than treated as a terminal error.
   *
   * `server` is the server's advertised version string; `client` is
   * the set of versions the client supports (same shape as
   * `ProtocolError {kind: 'version'}.clientSupports`).
   */
  readonly onUpgradeRequired?: (
    server: string,
    client: readonly string[],
  ) => void;

  /**
   * Surfaced for every {@link ObservabilityEvent} the iframe emits via
   * `postMessage({type:'ggui:observe', event})`. Complementary to
   * `onError`:
   *
   *   - `onError` fires on FAILURES only.
   *   - `onObserve` fires on happy paths + failures (telemetry signal
   *     the host can surface in a SessionInspector-style view).
   *
   * Handlers MUST tolerate unknown `event.kind` values — the union is
   * extensibly-closed.
   */
  readonly onObserve?: (event: ObservabilityEvent) => void;

  /**
   * Optional callback for every {@link McpAppLifecycleEvent} the iframe
   * emits via `postMessage({type:'ggui:lifecycle', event})`.
   *
   * Lifecycle is **always mirrored to the outer DOM** as
   * `data-ggui-mcp-app-iframe-lifecycle="<state>"` regardless of whether
   * this callback is bound — the outer-DOM mirror is the canonical
   * observation surface. This callback exists for hosts that want
   * additional reactive state (e.g., flipping a chrome-level loading
   * spinner off when `state === 'code-ready'`).
   *
   * Handlers MUST tolerate any future `state` values per the
   * `McpAppLifecycleState` closed union — adding a new state requires a
   * protocol change, but legacy hosts MUST not crash on a state they
   * don't recognise (the host filters known states before mirroring;
   * unknown states reach this callback as opaque strings the host
   * neither mirrors nor blocks).
   */
  readonly onLifecycle?: (event: McpAppLifecycleEvent) => void;

  /**
   * Optional callback for every `ui/message` envelope the iframe-
   * runtime posts to the host. The MCP Apps spec primitive lets an
   * in-iframe widget inject a chat message AS IF the user had typed
   * it — used by ggui's iframe-runtime as the agent-routed-dispatch
   * fallback (the third of three envelopes; the first two go to the
   * server's `ggui_runtime_submit_action` audit + a structured pending-
   * action hint).
   *
   * **When to wire this**:
   *
   *   - **Don't** wire it if your host's agent loop reads action
   *     events via `ggui_consume` long-poll — that pipe already
   *     surfaces the gesture and `ui/message` is a redundant nudge.
   *
   *   - **Do** wire it if your host runs the agent as one-shot
   *     `query()` per chat turn (no resume, no long-poll between
   *     turns) — in that case the consume pipe is closed by the time
   *     the user clicks, so this is the only path back to the agent.
   *     Forward `event.text` to your `/chat`-equivalent endpoint as a
   *     new user turn.
   *
   * The text is concatenated from every `content[i].type === 'text'`
   * block in the envelope params (single newline separator). Non-text
   * content blocks (image / resource / etc.) are dropped — they're
   * not meaningful for chat injection.
   */
  readonly onUiMessage?: (event: UiMessageEvent) => void;
}

/**
 * Imperative ref shape for `<McpAppIframe>` — exposed via
 * `React.forwardRef`. The narrow seam lets host-side tooling (e.g. a
 * test-action panel) inject JSON-RPC dispatches into the iframe
 * without bypassing the host-bridge protocol.
 *
 * `dispatchAction(name, data)` posts:
 *   ```
 *   { jsonrpc: '2.0', method: name, params: { data } }
 *   ```
 * as a fire-and-forget notification (no `id` — the iframe MUST NOT
 * respond). Host-bridge dispatch stays unambiguous: dispatches flow
 * host→iframe, responses flow iframe→host.
 */
export interface McpAppIframeRef {
  /**
   * Dispatch a JSON-RPC notification into the iframe. Used by
   * debugging tooling (console test-action panel) to inject test
   * events without routing through a real MCP server.
   */
  readonly dispatchAction: (name: string, data: unknown) => void;
}
