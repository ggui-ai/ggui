import { useState, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import type { AdapterPermissions, PermissionStatus, InterfaceContext, AppDisplayConfig, EndUserIdentity } from '@ggui-ai/protocol';
import {
  detectInterfaceContext,
  defaultInterfaceContext,
  KNOWN_PERMISSION_NAMES,
  UnknownPermissionNameError,
} from '@ggui-ai/protocol';
import { GguiContext, type AdapterRegistry, type GguiContextValue } from '../context/GguiContext';

const KNOWN_PERMISSION_NAMES_SET: ReadonlySet<string> = new Set(KNOWN_PERMISSION_NAMES);

export { useGguiContext, useAdapter, type AdapterRegistry } from '../context/GguiContext';

/**
 * Props for the {@link GguiProvider} component.
 */
export interface GguiProviderProps {
  appId: string;
  wsEndpoint?: string;
  /** Host-provided adapter implementations. Host apps or downstream
   * capability packages augment {@link AdapterRegistry} via
   * declaration merging so each slot is strongly typed. The grant
   * model lives entirely on `clientCapabilities.gadgets[*].permission`
   * — this is just the runtime implementation slot. */
  adapterImpls?: AdapterRegistry;
  /** Override auto-detected interface context */
  interfaceContext?: InterfaceContext;
  /**
   * Custom handler for permission requests (e.g., camera, microphone).
   *
   * By default, all permissions are granted immediately. Provide a custom
   * `permissionHandler` to integrate with your app's permission flow
   * (e.g., browser Permissions API, or a custom confirmation dialog).
   *
   * @param permission - The Web Permissions API name being requested
   *   (e.g., `'camera'`, `'microphone'`, `'geolocation'`). The SDK
   *   pre-validates the name against `KNOWN_PERMISSION_NAMES` before
   *   invoking this handler, so an unknown name surfaces as a
   *   `UnknownPermissionNameError` to the caller without ever
   *   reaching the host's permission flow.
   * @returns The resulting permission status
   */
  permissionHandler?: (permission: string) => Promise<PermissionStatus>;
  /** Auth context surfaced to wire hooks (`useAuth`) via the renderer. */
  auth?: {
    currentUser?: EndUserIdentity;
    userId?: string;
    token?: string;
    isAuthenticated: boolean;
  };
  /**
   * Conversation envelope identity. Forwarded by {@link useInvoke} as
   * the `X-Ggui-Host-Session-Id` header so the agent threads multi-turn
   * invokes through its own keyed conversation state. Names the chat
   * thread, not a GguiSession.
   */
  hostSessionId?: string;
  /** Base URL for platform API calls (app-config fetch). */
  apiBaseUrl?: string;
  /** App metadata (name, description, icon). Passed to wire's useApp hook. */
  appMetadata?: {
    appName?: string;
    appDescription?: string;
    appIcon?: string;
  };
  /** Pre-fetched app config. If not provided, GguiProvider fetches from apiBaseUrl. */
  appConfig?: AppDisplayConfig | null;
  children: ReactNode;
}

/**
 * Root provider for the ggui React SDK.
 *
 * Wraps the application (or a subtree) with shared configuration needed by
 * all ggui hooks and components: app identity, WebSocket endpoint, adapter
 * permissions, interface context detection, and optional auth/session state.
 *
 * @example
 * ```tsx
 * <GguiProvider appId="my-app" wsEndpoint="wss://your-ws-gateway.example/">
 *   <App />
 * </GguiProvider>
 * ```
 */
export function GguiProvider({ appId, wsEndpoint, adapterImpls, interfaceContext: interfaceContextProp, permissionHandler, auth, hostSessionId, apiBaseUrl, appMetadata, appConfig, children }: GguiProviderProps) {
  const [adapterPermissions, setAdapterPermissions] = useState<AdapterPermissions>({});

  // Auto-detect interface context from window, or use SSR default
  const [detectedContext, setDetectedContext] = useState<InterfaceContext>(() =>
    typeof window !== 'undefined' ? detectInterfaceContext() : defaultInterfaceContext()
  );

  // Update on resize
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setDetectedContext(detectInterfaceContext());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const interfaceContext = interfaceContextProp || detectedContext;

  // App config — use provided value or fetch from platform
  const [fetchedAppConfig, setFetchedAppConfig] = useState<AppDisplayConfig | null>(null);

  useEffect(() => {
    if (appConfig !== undefined) return;
    if (!apiBaseUrl || !appId) return;

    const controller = new AbortController();
    fetch(`${apiBaseUrl.replace(/\/$/, '')}/apps/${appId}/config`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setFetchedAppConfig(data as AppDisplayConfig); })
      .catch(() => { /* fail silently — built-in WelcomePage will show */ });

    return () => controller.abort();
  }, [appConfig, apiBaseUrl, appId]);

  const resolvedAppConfig = appConfig !== undefined ? appConfig : fetchedAppConfig;

  const requestPermission = useCallback(
    async (permission: string): Promise<PermissionStatus> => {
      // Gate on `KNOWN_PERMISSION_NAMES` (the Web Permissions API
      // enum). With no host-advertised `AdapterType[]` allow-list,
      // the SDK is the last line of defense against typos or
      // unsupported names slipping into the runtime cache.
      if (!KNOWN_PERMISSION_NAMES_SET.has(permission)) {
        throw new UnknownPermissionNameError({ observedName: permission });
      }
      const status: PermissionStatus = permissionHandler
        ? await permissionHandler(permission)
        : 'granted';
      const key = permission as keyof AdapterPermissions;
      setAdapterPermissions((prev) => ({ ...prev, [key]: status }));
      return status;
    },
    [permissionHandler]
  );

  // `adapterImpls` is the runtime implementation slot ONLY. There is
  // no manifest-level allow-list mirror — grant decisions live on
  // `clientCapabilities.gadgets[*].permission`.
  const resolvedAdapterImpls = useMemo<AdapterRegistry>(
    () => (adapterImpls ?? {}) as AdapterRegistry,
    [adapterImpls],
  );

  const value = useMemo<GguiContextValue>(
    () => ({
      appId,
      wsEndpoint,
      adapterPermissions,
      adapterImpls: resolvedAdapterImpls,
      requestPermission,
      interfaceContext,
      auth,
      hostSessionId,
      apiBaseUrl,
      appMetadata,
      appConfig: resolvedAppConfig,
    }),
    [appId, wsEndpoint, adapterPermissions, resolvedAdapterImpls, requestPermission, interfaceContext, auth, hostSessionId, apiBaseUrl, appMetadata, resolvedAppConfig]
  );

  return <GguiContext.Provider value={value}>{children}</GguiContext.Provider>;
}
