/**
 * Public props + imperative-ref shape for `<McpAppIframe>` on React
 * Native — the canonical MCP-Apps WebView host exported from
 * `@ggui-ai/react-native`.
 *
 * The web side retired `<McpAppIframe>` in favor of `<AppRenderer>`
 * from `@mcp-ui/client`. That migration relied on a two-iframe
 * sandbox-proxy architecture (cross-origin iframe nesting) that has
 * no meaningful WebView equivalent — a `react-native-webview` WebView
 * is itself a top-level browser surface, not a nestable origin. So on
 * RN, `<McpAppIframe>` IS the spec-canonical host primitive.
 *
 * Wire shape parity with `<AppRenderer>` is preserved on every other
 * surface: spec-canonical `ui/initialize` handshake (adapter-boundary
 * response), `ui/notifications/tool-result` for render-meta delivery,
 * `tools/call` outbound routing, `ui/open-link` delegated to
 * `Linking.openURL`, `ui/resource-teardown` notification at unmount,
 * and observability / lifecycle envelopes posted upward.
 */

import type { ResourceContents } from '@modelcontextprotocol/sdk/types.js';
import type {
  ObservabilityEvent,
  ProtocolError,
} from '@ggui-ai/iframe-runtime';
import type {
  McpAppAiGguiRenderMeta,
  McpAppLifecycleEvent,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Container-dimensions hint forwarded verbatim to the iframe via
 * `ui/initialize`'s `containerDimensions` field.
 */
export interface McpAppIframeDimensions {
  readonly width?: number;
  readonly height?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

/**
 * Permissions-Policy hint forwarded to the WebView (RN). Spec-canonical
 * field names. Native WebView enforces these through platform-specific
 * permission prompts — on web these map to the iframe `allow` attribute.
 */
export interface McpAppIframePermissions {
  readonly camera?: boolean;
  readonly microphone?: boolean;
  readonly geolocation?: boolean;
  readonly clipboardWrite?: boolean;
}

/**
 * Props for `<McpAppIframe>` on React Native.
 *
 * Host obligations:
 *   - Host MUST mount WebView with `source` derived from `resource`:
 *     `source={{html: resource.text}}` for inline HTML; `source={{uri:
 *     resource.uri}}` for URL resources (http(s) only).
 *   - `ui/initialize` replies carry ONLY `{theme, containerDimensions,
 *     locale}` — adapter-boundary rule.
 *   - `tools/call` forwards to `onToolCall`; absent handler → reject
 *     `no-tool-handler`.
 *   - `ui/open-link` with `https?://` → delegates to `Linking.openURL`;
 *     other schemes → reject `unsupported-scheme`.
 *   - Unknown method → `method_not_supported`.
 */
export interface McpAppIframeProps {
  /**
   * The MCP Apps resource to render. Structurally compatible with
   * `@modelcontextprotocol/sdk`'s `ResourceContents` (same TS type).
   *
   * Shape:
   *   - `uri` — required. Identifies the resource.
   *   - `mimeType?` — used when deriving a data-URL from a `blob`.
   *   - `text?` — when present, host mounts via `source={{html}}`
   *     (inline HTML).
   *   - `blob?` — when present (and no `text`), host mounts via a
   *     data-URL derived from the base64 blob + `mimeType` (defaults
   *     `text/html`).
   *   - Else → host mounts via `source={{uri}}` — caller is
   *     responsible for the URI being `http(s)://` (WebView rejects
   *     non-http schemes via `originWhitelist`).
   */
  readonly resource: ResourceContents;

  /**
   * Theme CSS-var bag forwarded to `ui/initialize.result.theme`. When
   * absent, a minimal neutral default is forwarded.
   */
  readonly theme?: Record<string, string>;

  /**
   * Locale string forwarded to `ui/initialize.result.locale`. On RN,
   * defaults to `'en-US'` when absent (no `navigator` available).
   */
  readonly locale?: string;

  /**
   * Container-dimensions hint. Mirrored to the View element's style
   * AND echoed to the iframe via
   * `ui/initialize.result.containerDimensions`.
   */
  readonly containerDimensions?: McpAppIframeDimensions;

  /**
   * Permissions-Policy hint. Passed through to the platform WebView's
   * media/geolocation gating; does NOT leak into `ui/initialize`.
   */
  readonly permissions?: McpAppIframePermissions;

  /**
   * Opt-in first-party `ai.ggui/render` meta delivery for ggui
   * renderer WebViews.
   *
   * **When set:** the host fires a spec-canonical
   * `ui/notifications/tool-result` JSON-RPC notification immediately
   * after responding to the renderer's `ui/initialize` request,
   * wrapping a `CallToolResult` whose `_meta` carries the single
   * `ai.ggui/render` slice from the supplied {@link
   * McpAppAiGguiRenderMeta}. The renderer's `parseMetaFromToolResult`
   * extractor (`packages/iframe-runtime/src/meta-parse.ts`) reads
   * `params._meta` and uses it to fetch the renderer bundle, open the
   * WebSocket, and bootstrap the render. This matches the wire shape
   * `<AppRenderer toolResult={...}>` forwards on web and the
   * `McpUiToolResultNotification` shape in
   * `@modelcontextprotocol/ext-apps/spec.types`. The `ui/initialize`
   * response itself is unchanged — it carries the adapter-boundary
   * `{theme, containerDimensions, locale}` fields ONLY.
   *
   * **When absent (default):** no `ui/notifications/tool-result`
   * notification is sent. The renderer falls through to its other
   * boot paths (inline `__GGUI_META__` global from a self-contained
   * shell, or the per-app live channel). Third-party MCP App
   * WebViews MUST NOT be given `meta` here — leaking outer-app state
   * into a generic MCP App is exactly the adapter-boundary
   * violation the rule exists to prevent.
   *
   * **Rule of thumb:** set this exactly when the WebView was spawned by
   * following ggui's own resource URI (`ui://ggui/render` or
   * `ui://ggui/render/<renderId>` etc.) and the host is responsible
   * for wiring the meta forward — e.g. the console's
   * `<McpAppIframe>` mount feeds it the meta fetched from
   * `GET /ggui/console/render-resource`. Do NOT set this for any
   * WebView loading content authored outside ggui's render-resource
   * surface.
   *
   * **Recursive case.** The renderer itself hosts third-party MCP App
   * iframes via `packages/iframe-runtime/src/mcp-app-iframe-host.ts`.
   * That nested host MUST NOT forward `meta` regardless of the outer
   * host's posture — first-party meta delivery does NOT cascade
   * through to third-party content the renderer is itself hosting.
   */
  readonly meta?: McpAppAiGguiRenderMeta;

  /**
   * Caller-provided handler for `tools/call` dispatches from the
   * iframe. The host forwards `(toolName, args)` and awaits; the
   * resolved value becomes the JSON-RPC `result`, rejections become
   * `-32000` errors. Absent handler = every `tools/call` is rejected
   * with `no-tool-handler`.
   */
  readonly onToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;

  /**
   * Surfaced on every ProtocolError the iframe postMessage'd up.
   * Hosts pattern-match on `err.kind`. Handlers MUST NOT throw.
   */
  readonly onError?: (err: ProtocolError) => void;

  /**
   * Called when the iframe surfaces a version-handshake rejection.
   */
  readonly onUpgradeRequired?: (
    server: string,
    client: readonly string[],
  ) => void;

  /**
   * Surfaced for every {@link ObservabilityEvent} the iframe emits
   * via `postMessage({type:'ggui:observe', event})`. Handlers MUST
   * tolerate unknown `event.kind` values (extensibly-closed union).
   */
  readonly onObserve?: (event: ObservabilityEvent) => void;

  /**
   * Optional callback for every {@link McpAppLifecycleEvent} the iframe
   * emits via `postMessage({type:'ggui:lifecycle', event})`.
   *
   * Lifecycle is **always mirrored to the outer `<View>`** via
   * `accessibilityValue={{text: state}}` regardless of whether this
   * callback is bound — this is the canonical observation surface
   * (RN equivalent of the web `data-ggui-mcp-app-iframe-lifecycle`
   * attribute that E2E + console inspectors pin on). On RN, lifecycle
   * is mirrored via `accessibilityValue={{text: state}}` on the host
   * `<View>` so RN testing libraries (`@testing-library/react-native`)
   * can query the same observable surface as web E2E selectors. Hosts
   * that want richer reactive state should bind `onLifecycle` directly.
   *
   * Handlers MUST tolerate any future `state` values per the
   * `McpAppLifecycleState` closed union — adding a new state requires a
   * protocol change, but legacy hosts MUST not crash on a state they
   * don't recognise (the host filters known states before mirroring;
   * unknown states reach this callback as opaque strings the host
   * neither mirrors nor blocks).
   */
  readonly onLifecycle?: (event: McpAppLifecycleEvent) => void;
}

/**
 * Imperative ref shape. Mirror of the web version — keep stable so
 * host-side tooling (e.g. a test-action panel) works against either
 * platform.
 */
export interface McpAppIframeRef {
  /**
   * Dispatch a JSON-RPC notification into the WebView. Fire-and-
   * forget; the iframe MUST NOT respond.
   */
  readonly dispatchAction: (name: string, data: unknown) => void;
}
