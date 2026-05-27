import { createContext, useContext } from 'react';
import type { AdapterPermissions, PermissionStatus, InterfaceContext, EndUserIdentity, AppDisplayConfig } from '@ggui-ai/protocol';

/**
 * Open interface — host runtime registry of **client/device adapter
 * implementations**. Empty on purpose: capability packages or host
 * apps augment this interface via TypeScript declaration merging so
 * the slot for each adapter lands with its concrete type.
 *
 * Example (host app or downstream capability package):
 * ```ts
 * declare module '@ggui-ai/react-native' {
 *   interface AdapterRegistry {
 *     printer?: PrinterAdapter;
 *   }
 * }
 * ```
 *
 * Mirrors {@link AdapterRegistry} in `@ggui-ai/react`. The augmenting
 * party can augment one or both registries depending on which SDKs
 * the adapter ships against. (Browser-capability hooks — camera,
 * geolocation, clipboard, filePicker, notifications, microphone —
 * are better served by the gadget pattern in `@ggui-ai/gadgets`,
 * which doesn't need a Provider-wired adapter; generated UI imports
 * the hook directly.)
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AdapterRegistry {}

/**
 * Shape of the value provided by {@link GguiContext}.
 *
 * Contains app identity, WebSocket configuration, adapter permissions,
 * interface context, and optional auth/session/API state consumed by hooks
 * and the client-side tool system. Extends the web version with
 * `reactVersion` and `designSystemUrl` for WebView import map configuration.
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
   * `clientCapabilities.gadgets[*].permission` — this registry is
   * purely the runtime implementation slot. */
  adapterImpls: AdapterRegistry;
  /** Current interface context (device/viewport info) */
  interfaceContext: InterfaceContext;
  /** Auth context for tools system */
  auth?: {
    currentUser?: EndUserIdentity;
    userId?: string;
    token?: string;
    isAuthenticated: boolean;
  };
  /** Render ID for tools system */
  renderId?: string;
  /** Base URL for API calls (used by fetch tool) */
  apiBaseUrl?: string;
  /** React version for WebView import map (default: '18.2.0') */
  reactVersion?: string;
  /** Base URL for design system modules in WebView import map */
  designSystemUrl?: string;
  /**
   * App config (endpointUrl, defaultShellType, etc). Mirrors the web SDK's
   * context field — `useInvoke` reads `endpointUrl` from here when the
   * caller doesn't override it. Populated by {@link GguiProvider} via its
   * `appConfig` prop.
   */
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
 * Mirrors {@link useAdapter} in `@ggui-ai/react`. Capability packages
 * augment both {@link AdapterRegistry} surfaces via declaration
 * merging.
 */
export function useAdapter<K extends keyof AdapterRegistry>(
  name: K,
): AdapterRegistry[K] | undefined {
  const ctx = useGguiContext();
  return ctx.adapterImpls[name];
}
