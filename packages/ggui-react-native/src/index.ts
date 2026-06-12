/**
 * @ggui-ai/react-native - React Native SDK for ggui
 *
 * Provides React Native components, hooks, and utilities for embedding ggui
 * agent interfaces in mobile applications. Includes WebSocket session
 * management with AppState/NetInfo awareness, dynamic component rendering
 * (descriptor-based native or WebView fallback), and a React Native theme
 * system that mirrors the web design tokens.
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
  SystemPayload,
  SystemAction,
  ShellType,
  InterfaceContext,
  DeviceCategory,
  EndUserIdentity,
  UserAuthMode,
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

// GguiSession
export { GguiRender } from './components/GguiRender';
export type { GguiRenderProps, GguiSessionApi, GguiSessionInfo } from './components/GguiRender';

// Dynamic Component Rendering
export {
  DynamicComponent,
  GguiSessionRenderer,
  registerComponent,
  getComponent,
  clearRegistry,
} from './components/DynamicComponent';
export type {
  DynamicComponentProps,
  GguiSessionRendererProps,
  ComponentDescriptor,
} from './components/DynamicComponent';

// WebView Renderer (for compiled code)
export { WebViewRenderer } from './components/WebViewRenderer';
export type { WebViewRendererProps, BridgeEvent } from './components/WebViewRenderer';

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

// Native Component Registry (built-in RN component mappings)
export { registerBuiltinComponents } from './components/NativeRegistry';

// Error Boundary
export { ErrorBoundary } from './components/ErrorBoundary';
export type { ErrorBoundaryProps } from './components/ErrorBoundary';

// Self-Repair Error Boundary
export { SelfRepairBoundary } from './components/SelfRepairBoundary';
export type { SelfRepairBoundaryProps } from './components/SelfRepairBoundary';

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
export { useWebSocket } from './hooks/useWebSocket';
export type { UseWebSocketOptions, UseWebSocketReturn } from './hooks/useWebSocket';
export { useAppState } from './hooks/useAppState';
// NOTE(F4 follow-up): `useAgentStream` listens for a `ggui:agent-stream`
// CustomEvent that no longer has any dispatcher (the `{type:'stream'}`
// WS frame and its bridge re-dispatch were retired draft-2026-06-11).
// The hook file is kept for now because a parallel work stream has
// in-flight changes on it — resolve its fate (delete or re-wire to a
// real emitter) when that work lands.
export { useAgentStream } from './hooks/useAgentStream';
export type { UseAgentStreamOptions } from './hooks/useAgentStream';

// WebSocket
export { WebSocketManager } from './websocket/WebSocketManager';
export type { WebSocketManagerOptions } from './websocket/WebSocketManager';
export { EventBuffer } from './websocket/EventBuffer';
export type { EventBufferOptions } from './websocket/EventBuffer';

