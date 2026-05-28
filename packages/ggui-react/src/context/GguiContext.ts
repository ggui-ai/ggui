import { createContext, useContext } from 'react';
import type { AdapterPermissions, PermissionStatus, InterfaceContext, AppDisplayConfig, EndUserIdentity } from '@ggui-ai/protocol';

/** Structural QueryClient type to keep `@tanstack/react-query` an optional peer dependency. */
type QueryClientLike = { getQueryData: (key: unknown[]) => unknown } | undefined;

/**
 * Open interface — host runtime registry of **client/device adapter
 * implementations**. Empty on purpose: capability packages or host
 * apps augment this interface via TypeScript declaration merging so
 * the slot for each adapter lands with its concrete type.
 *
 * Example (host app or downstream capability package):
 * ```ts
 * declare module '@ggui-ai/react' {
 *   interface AdapterRegistry {
 *     printer?: PrinterAdapter;
 *   }
 * }
 * ```
 *
 * `AdapterRegistry` names the runtime contract slots (host-provided
 * implementations). The augmenting party ships the concrete adapter
 * object. The grant decision lives elsewhere — on
 * `clientCapabilities.gadgets[*].permission` — so this surface is
 * purely the runtime implementation slot.
 *
 * For browser-capability hooks (camera, geolocation, clipboard, file
 * picker, notifications, microphone), prefer `@ggui-ai/gadgets` — the
 * gadget pattern doesn't need a Provider-wired adapter; generated UI
 * imports the hook directly.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AdapterRegistry {}

/**
 * Shape of the value provided by {@link GguiContext}.
 *
 * Contains app identity, WebSocket configuration, adapter permissions,
 * interface context, and optional auth/session/API state consumed by hooks
 * and the client-side tool system.
 */
export interface GguiContextValue {
  appId: string;
  wsEndpoint?: string;
  adapterPermissions: AdapterPermissions;
  requestPermission: (adapter: string) => Promise<PermissionStatus>;
  /** Host-registered adapter implementations, keyed by capability name.
   * Generated UI reads from this registry via {@link useAdapter} (or
   * capability-specific hooks exposed by host apps that augment
   * {@link AdapterRegistry}). Grant decisions live on
   * `clientCapabilities.gadgets[*].permission`. */
  adapterImpls: AdapterRegistry;
  /** Current interface context (device/viewport info) */
  interfaceContext: InterfaceContext;
  /** Optional TanStack QueryClient for tool caching. Provide via GguiQueryProvider. */
  queryClient?: QueryClientLike;
  /** Auth context for tools system */
  auth?: {
    currentUser?: EndUserIdentity;
    userId?: string;
    token?: string;
    isAuthenticated: boolean;
  };
  /**
   * Conversation envelope identity. Forwarded by {@link useInvoke} as
   * the `X-Ggui-Host-Session-Id` header so the agent threads multi-turn
   * invokes through its own keyed conversation state. Distinct from
   * {@link renderId} — this names the chat thread, not a render.
   */
  hostSessionId?: string;
  /**
   * Per-render scope identity for the client-side tool system. Used by
   * {@link useTool} / {@link useBindings} as `ToolContext.renderId` —
   * scopes the in-memory fetch cache so two concurrent renders cannot
   * leak each other's cached responses. Distinct from
   * {@link hostSessionId} — this names a single render, not the
   * conversation envelope.
   */
  renderId?: string;
  /** Base URL for API calls (used by fetch tool) */
  apiBaseUrl?: string;
  /** Optional app metadata (name, description, icon). Passed through to wire hooks. */
  appMetadata?: {
    appName?: string;
    appDescription?: string;
    appIcon?: string;
  };
  /** App configuration fetched from platform (shell selection, initial screen). */
  appConfig?: AppDisplayConfig | null;
}

/**
 * React context that carries ggui configuration to all descendant components.
 *
 * Provided by {@link GguiProvider}. Access the value with {@link useGguiContext}.
 */
export const GguiContext = createContext<GguiContextValue | null>(null);

/**
 * Access the nearest {@link GguiContext} value.
 *
 * Must be called inside a `<GguiProvider>`. Throws if no provider is found.
 *
 * @returns The current {@link GguiContextValue}
 * @throws Error if called outside a GguiProvider
 */
export function useGguiContext(): GguiContextValue {
  const ctx = useContext(GguiContext);
  if (!ctx) {
    throw new Error('useGguiContext must be used within a GguiProvider');
  }
  return ctx;
}

/**
 * Read a host-registered adapter implementation by capability name.
 *
 * Returns `undefined` when the host hasn't wired an implementation
 * for this capability — callers MUST handle that case (e.g. render
 * a fallback UI). Grant decisions live on `clientCapabilities.gadgets
 * [*].permission` and surface to the iframe via `Permissions-Policy`;
 * the SDK context just exposes whatever the host wired into
 * `adapterImpls`.
 *
 * Type safety comes from capability packages or host apps augmenting
 * {@link AdapterRegistry} via declaration merging. After augmenting
 * the registry with a slot (e.g. `printer?: PrinterAdapter`),
 * `useAdapter('printer')` is typed as `PrinterAdapter | undefined`.
 */
export function useAdapter<K extends keyof AdapterRegistry>(
  name: K,
): AdapterRegistry[K] | undefined {
  const ctx = useGguiContext();
  return ctx.adapterImpls[name];
}
