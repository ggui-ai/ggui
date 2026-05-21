/**
 * @ggui-ai/react - React SDK for ggui
 *
 * Provides React components, hooks, and utilities for embedding ggui agent
 * interfaces in web applications. Includes WebSocket session management,
 * dynamic component rendering in the React tree with wire hook support,
 * client-side data tools, and prebuilt shell UIs (ChatShell, FullscreenShell).
 *
 * @packageDocumentation
 */

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
  GeneratePayload,
  GenerationStrategy,
  ShellType,
  AppDisplayConfig,
  InterfaceContext,
  DeviceCategory,
  EndUserIdentity,
  UserAuthMode,
  // Client tools types
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
  // System events (OAuth consent)
  SystemPayload,
  SystemAction,
} from '@ggui-ai/protocol';
export { BRIDGE_EVENTS, DEFAULT_SUBSCRIPTION, detectInterfaceContext, getDeviceCategory } from '@ggui-ai/protocol';
export { stackNavigationReducer, initialNavigationState } from '@ggui-ai/protocol';
export type { StackNavigationState, StackNavigationAction } from '@ggui-ai/protocol';

// Invoke protocol message block types — re-exported at root so facade
// consumers can pull them from the same import path as useInvoke.
// Parity: identical type re-export block exists on @ggui-ai/react-native.
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
// `@ggui-ai/iframe-runtime` owns the declaration; `@ggui-ai/react`
// re-exports it so consumers pulling from the React SDK don't need a
// direct renderer import.
export type {
  ProtocolError,
  ProtocolErrorEmitter,
  BootstrapFailureReason,
  // Bootstrap-failure postMessage envelope shape — the parent receives
  // `{type:'ggui:bootstrap-failed', reason, message}` from the iframe
  // on any pre-renderer or post-renderer boot failure. Host apps
  // (and the `<McpAppIframe onError>` wrapper) read this shape when
  // classifying iframe-origin failures.
  RendererBootFailedMessage,
  // `<McpAppIframe onObserve>` emission union. Embedding apps
  // pattern-match on `event.kind` (`wired-tool-invoked` /
  // `contract-error-emitted` / `schema-version-mismatch` /
  // `subscribe-failed` / `auth-required` / unknown tail). Re-exported
  // here so host apps wiring the onObserve callback don't need a
  // direct `@ggui-ai/iframe-runtime` import; same boundary posture as
  // `ProtocolError` above.
  ObservabilityEvent,
  ObservabilityMessage,
  WiredToolInvokedEvent,
  ContractErrorEmittedEvent,
  SchemaVersionMismatchEvent,
  SubscribeFailedEvent,
  AuthRequiredEvent,
  UnknownObservabilityEvent,
} from '@ggui-ai/iframe-runtime';

// Re-export types from internal
export type {
  // Self-repair types (premium)
  ComponentErrorReport,
  ComponentRepairResult,
  SelfRepairConfig,
  SelfRepairEventType,
  SelfRepairEvents,
  // Agent listing types (marketplace)
  AgentListingItem,
  AgentListingVisibility,
  AgentListingStatus,
} from '@ggui-ai/shared';

// App (top-level entry point)
export { GguiApp } from './components/GguiApp';
export type { GguiAppProps, ShellProp } from './components/GguiApp';

// Provider
export { GguiProvider, useGguiContext, useAdapter } from './components/GguiProvider';
export type { GguiProviderProps } from './components/GguiProvider';
export type { AdapterRegistry } from './context/GguiContext';

// Theme Provider — root-surface parity with RN SDK
export { ThemeProvider } from './components/ThemeProvider';
export type { ThemeProviderProps } from './components/ThemeProvider';

// Shell types — the only type surviving an earlier shell rewrite.
// Everything else (ShellContext, ShellProps, ActiveSession, Session
// handles, BaseShell props, InboundHandlers, OutboundHandlers) lived
// around the retired `<BaseShell>` WebSocket pattern.
export type { AgentState } from './types/shell';

// Session
export { GguiSession } from './components/GguiSession';
export type { GguiSessionProps, SessionApi, SessionInfo } from './components/GguiSession';

// Dynamic Component Rendering
export {
  DynamicComponent,
  StackItemRenderer,
  clearModuleCache,
} from './components/DynamicComponent';
export type {
  DynamicComponentProps,
  StackItemRendererProps,
} from './components/DynamicComponent';

// MCP Apps stack-item renderer (inbound third-party iframe hosting).
// `@deprecated` — a session-bound legacy host. Prefer `<McpAppIframe>`
// (exported below) for any new code; this export is retired once every
// consumer has migrated.
export { McpAppsStackItemRenderer } from './components/McpAppsStackItemRenderer';
export type { McpAppsStackItemRendererProps } from './components/McpAppsStackItemRenderer';

// `<McpAppIframe>` — generic MCP Apps iframe host.
// Zero ggui-specific coupling; any MCP Apps host (Claude Desktop,
// ChatGPT, VS Code, console, third-party playgrounds) uses this to
// embed a ggui (or any MCP Apps-conformant) session. Pairs with
// `@ggui-ai/iframe-runtime` which runs INSIDE the iframe.
export { McpAppIframe } from './McpAppIframe/index';
export type {
  McpAppIframeProps,
  McpAppIframeRef,
  McpAppIframeDimensions,
  McpAppIframePermissions,
  UiMessageEvent,
} from './McpAppIframe/index';

// Provisional A2UI preview renderer (consumes `_ggui:preview` channel)
export { ProvisionalRenderer } from './components/ProvisionalRenderer';
export type { ProvisionalRendererProps } from './components/ProvisionalRenderer';

// Self-Repair (Premium Feature)
export { SelfRepairBoundary } from './components/SelfRepairBoundary';
export type { SelfRepairBoundaryProps } from './components/SelfRepairBoundary';

// Navigator
export { GguiNavigator } from './components/GguiNavigator';
export type { GguiNavigatorProps } from './components/GguiNavigator';

// Agent Browse Panel
export { AgentBrowsePanel } from './components/AgentBrowsePanel';
export type { AgentBrowsePanelProps } from './components/AgentBrowsePanel';

// Hooks
export { useWebSocket } from './hooks/useWebSocket';
export type { UseWebSocketOptions, UseWebSocketReturn } from './hooks/useWebSocket';
export { useStackNavigation } from './hooks/useStackNavigation';
export type { UseStackNavigationOptions, UseStackNavigationReturn } from './hooks/useStackNavigation';
export { useInvoke, parseSseStream } from './invoke/index';
export type { UseInvokeOptions, UseInvokeReturn, ConversationMessage, InvokeError } from './invoke/index';
export { extractBootstrapMeta, extractUiMoments } from './invoke/index';
export type { UiMoment, ExtractUiMomentsOptions } from './invoke/index';
export { useGenerate } from './hooks/useGenerate';
export type { UseGenerateOptions, UseGenerateReturn, GenerateOptions, GenerateResult } from './hooks/useGenerate';

// WebSocket
export { WebSocketManager } from './websocket/WebSocketManager';
export type { WebSocketManagerOptions } from './websocket/WebSocketManager';
export { EventBuffer } from './websocket/EventBuffer';
export type { EventBufferOptions } from './websocket/EventBuffer';

// Client-side tools for data binding
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
} from './tools/index';
export type {
  ToolContext,
  ToolExecutor,
  ToolDefinition,
  UseToolReturn,
  UseToolOptions,
  ResolvedBindings,
  UseBindingsOptions,
  ToolResult,
} from './tools/index';

// Shells — prebuilt UI shells for agent interactions
export { AgentShell } from './shells/AgentShell';
export type { AgentShellProps } from './shells/agent-shell/types';
export { ChatShell } from './shells/ChatShell';
export type { ChatShellProps } from './shells/ChatShell';
export { FullscreenShell } from './shells/FullscreenShell';
export type { FullscreenShellProps } from './shells/FullscreenShell';
export { WelcomePage } from './shells/WelcomePage';
export type { WelcomePageProps } from './shells/WelcomePage';
export { hexToRgb, darkenRgb, buildDarkCssOverrides, buildPrimaryCssOverrides, buildShellTheme } from './shells/theme';

// TanStack Query integration — import from '@ggui-ai/react/query' instead.
// Kept as a separate subpath to avoid forcing @tanstack/react-query on all consumers.
