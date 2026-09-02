/**
 * @ggui-ai/mcp-apps-react - React SDK for ggui
 *
 * Provides React components, hooks, and utilities for embedding ggui agent
 * interfaces in web applications: the invoke conversation loop, MCP Apps
 * tool-result helpers, and dynamic component rendering in the React tree
 * with wire hook support.
 *
 * @packageDocumentation
 */

// Re-export types from protocol
export type {
  // Post-Phase-B render shape — replaces the deleted Session/StackItem
  // pair with a single GguiSession union (ComponentGguiSession, SystemGguiSession,
  // McpAppsGguiSession) keyed by the flat `sessionId`.
  GguiSession,
  ComponentGguiSession,
  SystemGguiSession,
  AdapterPermissions,
  PermissionStatus,
  StreamEnvelope,
  AppDisplayConfig,
  InterfaceContext,
  EndUserIdentity,
} from '@ggui-ai/protocol';
export { detectInterfaceContext } from '@ggui-ai/protocol';

// Invoke protocol message block types — re-exported at root so facade
// consumers can pull them from the same import path as useInvoke.
// Parity: identical type re-export block exists on @ggui-ai/mcp-apps-react-native.
export type {
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  InvokeTurn,
} from '@ggui-ai/protocol';

// ProtocolError typed union — the canonical shape for every failure
// the renderer classifies outward. `<AppRenderer onError>` (from
// `@mcp-ui/client`, imported directly) surfaces it; embedding apps
// pattern-match on `err.kind`. The sibling package
// `@ggui-ai/iframe-runtime` owns the declaration; `@ggui-ai/mcp-apps-react`
// re-exports it so consumers pulling from the React SDK don't need a
// direct renderer import.
export type {
  ProtocolError,
  ProtocolErrorEmitter,
  BootstrapFailureReason,
  // Bootstrap-failure postMessage envelope shape — the parent receives
  // `{type:'ggui:bootstrap-failed', reason, message}` from the iframe
  // on any pre-renderer or post-renderer boot failure. Host apps
  // (and the `<AppRenderer onError>` wrapper) read this shape when
  // classifying iframe-origin failures.
  RendererBootFailedMessage,
  // `<AppRenderer onError>` emission union. Embedding apps
  // pattern-match on `event.kind` (`schema-version-mismatch` /
  // `subscribe-failed` / unknown tail). Re-exported here so host apps
  // wiring the onError callback don't need a direct
  // `@ggui-ai/iframe-runtime` import; same boundary posture as
  // `ProtocolError` above.
  ObservabilityEvent,
  ObservabilityMessage,
  RelayDeadTapEvent,
  RelayIncapabilityEvent,
  RelayLatchTrigger,
  SchemaVersionMismatchEvent,
  SubscribeFailedEvent,
  UiFeedbackEvent,
  UnknownObservabilityEvent,
} from '@ggui-ai/iframe-runtime';
// The `ggui:observe` envelope guard — a web host owns its iframe and
// listens on the protocol-owned tag directly; this narrows `event.data`
// so it can switch on `event.kind` (relay dead taps, latch edges, …)
// without hand-typed payloads. Runtime value, so a separate export.
export { isObservabilityMessage } from '@ggui-ai/iframe-runtime';

// Provider
export { GguiProvider } from './components/GguiProvider';
export type { GguiProviderProps } from './components/GguiProvider';

// Dynamic Component Rendering
export {
  DynamicComponent,
  GguiSessionRenderer,
} from './components/DynamicComponent';
export type {
  DynamicComponentProps,
  GguiSessionRendererProps,
} from './components/DynamicComponent';

// Spec-canonical MCP Apps iframe host — import DIRECTLY from `@mcp-ui/client`.
//
// ggui does NOT re-export `@mcp-ui/client`. Add it as a direct dependency and
// import the host components/types from it:
//
//   import { AppRenderer, AppFrame, AppBridge, PostMessageTransport } from "@mcp-ui/client";
//   import type { AppRendererProps, RequestHandlerExtra, SandboxConfig } from "@mcp-ui/client";
//
// **Why @mcp-ui/client (not a ggui wrapper).** The MCP Apps spec mandates a
// two-iframe sandbox-proxy pattern (sandbox.html on a different origin) +
// spec-canonical `AppBridge` over postMessage. `@mcp-ui/client` is the de-facto
// reference React host (Apache-2.0; used by Claude / VSCode / Postman / Goose /
// LibreChat). Per ggui's first principle — work with standard spec MCP, no
// out-of-spec extensions — ggui uses the canonical implementation directly
// rather than wrapping OR re-exporting it.
//
// **Where ggui's bootstrap envelope flows.** `_meta["ai.ggui/bootstrap"]` on
// `ggui_render` / `ggui_handshake` tool results uses the spec-canonical `_meta`
// extension grammar (SEP-2133); a spec-compliant host (including `<AppRenderer>`)
// MUST forward `_meta` from tool results to the view via
// `ui/notifications/tool-result`. The view's iframe-runtime reads the key
// directly. See `docs/protocol/extensions/ai.ggui-bootstrap.md`.
//
// Sandbox-proxy hosting: consumers MUST mount a `sandbox.html` on a different
// origin and pass that URL via `<AppRenderer sandbox={{url, ...}}>`.
// `@ggui-ai/agent-server`'s `startSandboxProxyServer` provides a ready impl.
//
// ggui's own helper for the AppRenderer toolResult envelope is
// `buildAppRendererToolResult` (exported below).

// Provisional preview placeholder shown while a render's componentCode
// is still being generated.
export { ProvisionalRenderer } from './components/ProvisionalRenderer';
export type { ProvisionalRendererProps } from './components/ProvisionalRenderer';

// UI Feedback affordance — host-side render-shell chrome. Hidden
// entirely unless the host wires `onUiFeedback`; the payload leaves
// through that callback only (never the agent ↔ UI wire). An
// in-iframe twin lives in `@ggui-ai/iframe-runtime` (emitting a
// `ui-feedback` event on the `ggui:observe` seam) — hosts wire
// exactly ONE of the two surfaces, never both.
export { UiFeedback } from './components/UiFeedback';
export type {
  UiFeedbackProps,
  UiFeedbackPayload,
  UiFeedbackVerdict,
} from './components/UiFeedback';

// Hooks
export { useInvoke, parseSseStream } from './invoke/index';
export type { UseInvokeOptions, UseInvokeReturn, ConversationMessage, InvokeError } from './invoke/index';
export {
  extractMcpAppAiGguiMeta,
  buildAppRendererToolResult,
  extractUiMoments,
} from './invoke/index';
export type { UiMoment, ExtractUiMomentsOptions } from './invoke/index';
