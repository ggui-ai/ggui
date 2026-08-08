/**
 * @ggui-ai/react-native - React Native SDK for ggui
 *
 * Provides React Native components, hooks, and utilities for embedding ggui
 * agent interfaces in mobile applications. The host primitive is
 * `<McpAppIframe>` — the WebView-backed MCP Apps host (RN analog of the
 * web's `<AppRenderer>` from `@mcp-ui/client`) — surrounded by the
 * thread-backed chat stack (`chat-thread` subpath), the Streamable
 * Invoke hook (`useInvoke`), and a React Native theme system that
 * mirrors the web design tokens.
 *
 * @packageDocumentation
 */

// Theme System
export { ThemeProvider, useTheme, buildTheme } from './theme';
export type { ThemeProviderProps, RNTheme, RNThemeColors, RNThemeSemantic, RNShadow, RNTransitionPreset, RNAccessibility } from './theme';
export {
  rnColors,
  rnSemantic,
  rnSpacing,
  rnSpacingNamed,
  rnFontSize,
  rnFontWeight,
  rnLineHeight,
  rnFontFamily,
  rnRadius,
  rnShadow,
  rnDuration,
  rnEasing,
  rnTransition,
  rnAccessibility,
} from './theme';

// Re-export transport types from the transport subpath
export type {
  ConnectionStatus,
  WebSocketMessage,
  WebSocketMessageType,
} from '@ggui-ai/protocol/transport/websocket';

// Re-export types from protocol
export type {
  ActionEnvelope,
  EventType,
  // Single GguiSession union (ComponentGguiSession, SystemGguiSession, McpAppsGguiSession)
  // keyed by the flat `sessionId`.
  GguiSession,
  ComponentGguiSession,
  SystemGguiSession,
  GguiSessionStatus,
  AdapterPermissions,
  PermissionStatus,
  SubscribePayload,
  AckPayload,
  StreamEnvelope,
  ErrorPayload,
  RenderPayload,
  PropsUpdatePayload,
  ShellType,
  InterfaceContext,
  DeviceCategory,
  EndUserIdentity,
} from '@ggui-ai/protocol';
export { BRIDGE_EVENTS, detectInterfaceContext, getDeviceCategory } from '@ggui-ai/protocol';

// Invoke protocol message block types — re-exported at root so facade
// consumers can pull them from the same import path as useInvoke.
// Parity: identical type re-export block exists on @ggui-ai/react.
export type {
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  InvokeTurn,
} from '@ggui-ai/protocol';

// ProtocolError typed union — the canonical shape for every failure
// the renderer classifies outward. `<McpAppIframe onError>` surfaces
// it; embedding apps pattern-match on `err.kind`. The sibling package
// `@ggui-ai/iframe-runtime` owns the declaration; the RN SDK re-exports
// it at parity with `@ggui-ai/react` so consumers have a single import
// point per platform.
export type {
  ProtocolError,
  ProtocolErrorEmitter,
  BootstrapFailureReason,
  // Bootstrap-failure postMessage envelope shape — the parent receives
  // `{type:'ggui:bootstrap-failed', reason, message}` from the iframe /
  // WebView on any pre-renderer or post-renderer boot failure. RN
  // hosts reading this via WebView `onMessage` pattern-match on the
  // `type` tag to classify iframe-origin failures.
  RendererBootFailedMessage,
} from '@ggui-ai/iframe-runtime';

// Provider
export { GguiProvider, useGguiContext, useAdapter } from './components/GguiProvider';
export type { GguiProviderProps } from './components/GguiProvider';
export type { AdapterRegistry } from './context/GguiContext';

// Shared host-role MCP-Apps bridge helpers — exported for composition by
// callers that want to embed the bridge in a custom WebView wrapper
// (e.g., custom error overlays, in-app navigation headers). The
// switch implements the canonical set: ui/initialize, tools/call,
// ping, ui/open-link, ui/resource-teardown.
export {
  handleHostBridgeRequest,
  buildInjectedBridgeScript,
  buildDeliveryScript,
  NATIVE_BRIDGE_ENVELOPE_KEY,
} from './components/mcp-apps-bridge';
export type { HostBridgeContext } from './components/mcp-apps-bridge';

// `<McpAppIframe>` — generic MCP Apps iframe host for React Native.
// Zero ggui-specific coupling; a mirror of the web host exported from
// `@ggui-ai/react`. Any MCP Apps host (Claude Desktop,
// ChatGPT, VS Code, console, third-party playgrounds) uses this to
// embed a ggui (or any MCP Apps-conformant) session on RN.
export { McpAppIframe } from './McpAppIframe/index';
export type {
  McpAppIframeProps,
  McpAppIframeRef,
  McpAppIframeDimensions,
  McpAppIframePermissions,
} from './McpAppIframe/index';

// Error Boundary
export { ErrorBoundary } from './components/ErrorBoundary';
export type { ErrorBoundaryProps } from './components/ErrorBoundary';

// Self-Repair Error Boundary
export { SelfRepairBoundary } from './components/SelfRepairBoundary';
export type { SelfRepairBoundaryProps } from './components/SelfRepairBoundary';

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

// Re-export self-repair types from internal
export type {
  ComponentErrorReport,
  ComponentRepairResult,
  SelfRepairConfig,
} from '@ggui-ai/shared';

// Streamable Invoke Protocol (v1.1) hook
export { useInvoke, parseSseStream } from './invoke/index';
export type { UseInvokeOptions, UseInvokeReturn, ConversationMessage, InvokeError } from './invoke/index';

// Hooks
export { useAppState } from './hooks/useAppState';

