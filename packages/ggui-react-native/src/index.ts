/**
 * @ggui-ai/react-native - React Native SDK for ggui
 *
 * Provides React Native components, hooks, and utilities for embedding ggui
 * agent interfaces in mobile applications. Includes WebSocket session
 * management with AppState/NetInfo awareness, dynamic component rendering
 * (descriptor-based native or WebView fallback), client-side data tools,
 * and a React Native theme system that mirrors the web design tokens.
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
  EventSubscription,
  Session,
  StackItem,
  AdapterPermissions,
  PermissionStatus,
  SubscribePayload,
  AckPayload,
  StreamPayload,
  StreamEnvelope,
  ErrorPayload,
  ProgressStep,
  ProgressPayload,
  SessionPayload,
  UrlPayload,
  SystemPayload,
  SystemAction,
  GeneratePayload,
  ShellType,
  InterfaceContext,
  DeviceCategory,
  EndUserIdentity,
  UserAuthMode,
} from '@ggui-ai/protocol';
export { BRIDGE_EVENTS, DEFAULT_SUBSCRIPTION, detectInterfaceContext, getDeviceCategory } from '@ggui-ai/protocol';
export { stackNavigationReducer, initialNavigationState } from '@ggui-ai/protocol';
export type { StackNavigationState, StackNavigationAction } from '@ggui-ai/protocol';

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

// Session
export { GguiSession } from './components/GguiSession';
export type { GguiSessionProps, SessionApi, SessionInfo } from './components/GguiSession';

// Dynamic Component Rendering
export {
  DynamicComponent,
  StackItemRenderer,
  registerComponent,
  getComponent,
  clearRegistry,
} from './components/DynamicComponent';
export type {
  DynamicComponentProps,
  StackItemRendererProps,
  ComponentDescriptor,
} from './components/DynamicComponent';

// WebView Renderer (for compiled code)
export { WebViewRenderer } from './components/WebViewRenderer';
export type { WebViewRendererProps, BridgeEvent } from './components/WebViewRenderer';

// MCP Apps stack-item renderer (inbound third-party iframe hosting).
// `@deprecated` — a session-bound legacy host. Prefer `<McpAppIframe>`
// (exported below) for any new code; this export is retired once every
// consumer has migrated.
// Web (Expo Web) renders the iframe with the host postMessage bridge.
// Native (iOS / Android) renders a `react-native-webview` loading the
// same ggui server proxy URL with an injected shim that aliases
// `window.parent.postMessage` → `ReactNativeWebView.postMessage`.
export { McpAppsStackItemRenderer } from './components/McpAppsStackItemRenderer';
export type { McpAppsStackItemRendererProps } from './components/McpAppsStackItemRenderer';
// Shared host-role bridge helpers — exported for composition by
// callers that want to embed the bridge in a custom WebView wrapper
// (e.g., custom error overlays, in-app navigation headers). The
// switch implements the canonical set: ui/initialize, tools/call,
// ping, ui/open-link, ui/resource-teardown.
export {
  handleHostBridgeRequest,
  buildInjectedBridgeScript,
  buildDeliveryScript,
  NATIVE_BRIDGE_ENVELOPE_KEY,
} from './components/McpAppsStackItemRenderer';
export type { HostBridgeContext } from './components/McpAppsStackItemRenderer';

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

// Navigator
export { GguiNavigator } from './components/GguiNavigator';
export type { GguiNavigatorProps } from './components/GguiNavigator';

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
export { useStackNavigation } from './hooks/useStackNavigation';
export type { UseStackNavigationOptions, UseStackNavigationReturn } from './hooks/useStackNavigation';
export { useAgentStream } from './hooks/useAgentStream';
export type { UseAgentStreamOptions } from './hooks/useAgentStream';
export { useGenerationProgress, STEP_PROGRESS } from './hooks/useGenerationProgress';
export type { ProgressState } from './hooks/useGenerationProgress';

// WebSocket
export { WebSocketManager } from './websocket/WebSocketManager';
export type { WebSocketManagerOptions } from './websocket/WebSocketManager';
export { EventBuffer } from './websocket/EventBuffer';
export type { EventBufferOptions } from './websocket/EventBuffer';

// Tools System
export {
  // Registry
  toolRegistry,
  registerTool,
  defineTool,
  // Hooks
  useTool,
  useBindings,
  useBinding,
  // Resolver utilities
  resolveBindings,
  topologicalSort,
  interpolateString,
  interpolateConfig,
  getNestedValue,
  validateBindings,
  // Built-in tools
  fetchTool,
  clearFetchCache,
  authTool,
  storageTool,
  writeStorage,
  removeStorage,
  chainTool,
  transformTool,
  mergeTool,
} from './tools';
export type {
  ToolContext,
  ToolExecutor,
  ToolDefinition,
  UseToolReturn,
  UseToolOptions,
  ResolvedBindings,
  UseBindingsOptions,
  ToolResult,
  ClientToolName,
  ClientToolConfig,
  DataBindings,
  TypedToolConfig,
  FetchToolConfig,
  AuthToolConfig,
  StorageToolConfig,
  SubscriptionToolConfig,
  ChainToolConfig,
  TransformToolConfig,
  MergeToolConfig,
} from './tools';
