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
export { BRIDGE_EVENTS, detectInterfaceContext, getDeviceCategory } from '@ggui-ai/protocol';

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
// the renderer classifies outward. `<AppRenderer onError>` (from
// `@mcp-ui/client`, re-exported below) surfaces it; embedding apps
// pattern-match on `err.kind`. The sibling package
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
  // (and the `<AppRenderer onError>` wrapper) read this shape when
  // classifying iframe-origin failures.
  RendererBootFailedMessage,
  // `<AppRenderer onError>` emission union. Embedding apps
  // pattern-match on `event.kind` (`wired-tool-invoked` /
  // `contract-error-emitted` / `schema-version-mismatch` /
  // `subscribe-failed` / `auth-required` / unknown tail). Re-exported
  // here so host apps wiring the onError callback don't need a
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

// Spec-canonical MCP Apps iframe host — re-exported from `@mcp-ui/client`.
//
// **Why a re-export, not our own component.** The MCP Apps spec mandates a
// two-iframe sandbox-proxy pattern on different origins (sandbox.html on a
// different origin from the host) + spec-canonical `AppBridge` over
// postMessage. `@mcp-ui/client` is the de-facto reference React host
// (Apache-2.0, used by Claude / VSCode / Postman / Goose / LibreChat) and
// implements the pattern correctly. Per ggui's first principle — protocol
// MUST work with standard spec MCP, no extensions out of spec — we adopt
// the canonical implementation directly rather than wrap it.
//
// **Where ggui's bootstrap envelope flows.** `_meta["ai.ggui/bootstrap"]`
// on `ggui_push` / `ggui_handshake` tool results uses the spec-canonical
// `_meta` extension grammar (SEP-2133: `{reverse-dns-prefix}/{name}`); a
// spec-compliant host (including `<AppRenderer>`) MUST forward
// `_meta` from tool results to the view via `ui/notifications/tool-result`.
// The view's iframe-runtime reads the key directly. See
// `docs/protocol/extensions/ai.ggui-bootstrap.md`.
//
// Sandbox-proxy hosting: consumers MUST mount a `sandbox.html` on a
// different origin and pass that URL via `<AppRenderer sandbox={{url, ...}}>`.
// `@ggui-ai/dev-stack`'s `startSandboxProxyServer` provides a dev-ready
// implementation on a different port.
export {
  AppRenderer,
  AppFrame,
  AppBridge,
  PostMessageTransport,
  getUIResourceMetadata,
  getResourceMetadata,
  isUIResource,
  UI_EXTENSION_NAME,
  UI_EXTENSION_CONFIG,
  UI_EXTENSION_CAPABILITIES,
} from '@mcp-ui/client';
export type {
  AppRendererProps,
  AppRendererHandle,
  AppFrameProps,
  SandboxConfig,
  AppInfo,
  RequestHandlerExtra,
  UIResourceMetadata,
  ClientCapabilitiesWithExtensions,
  McpUiHostContext,
  McpUiHostCapabilities,
} from '@mcp-ui/client';

// Provisional A2UI preview renderer (consumes `_ggui:preview` channel)
export { ProvisionalRenderer } from './components/ProvisionalRenderer';
export type { ProvisionalRendererProps } from './components/ProvisionalRenderer';

// Self-Repair (Premium Feature)
export { SelfRepairBoundary } from './components/SelfRepairBoundary';
export type { SelfRepairBoundaryProps } from './components/SelfRepairBoundary';

// Agent Browse Panel
export { AgentBrowsePanel } from './components/AgentBrowsePanel';
export type { AgentBrowsePanelProps } from './components/AgentBrowsePanel';

// Hooks
export { useWebSocket } from './hooks/useWebSocket';
export type { UseWebSocketOptions, UseWebSocketReturn } from './hooks/useWebSocket';
export { useInvoke, parseSseStream } from './invoke/index';
export type { UseInvokeOptions, UseInvokeReturn, ConversationMessage, InvokeError } from './invoke/index';
export {
  extractBootstrapMeta,
  extractMcpAppAiGguiMeta,
  buildAppRendererToolResult,
  extractUiMoments,
} from './invoke/index';
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
