/**
 * GguiProvider — React Native twin of `@ggui-ai/react`'s
 * `components/GguiProvider.tsx`.
 *
 * The provider surface mirrors the web copy: permission requests gate
 * on `KNOWN_PERMISSION_NAMES`, `adapterImpls` is the runtime
 * implementation slot only, and the context value shape feeds the
 * same `GguiContext`.
 *
 * Platform delta (every intentional divergence from the web copy):
 *
 *   - Interface-context detection reads RN `Dimensions` / `PixelRatio`
 *     (with rotation / split-screen change updates) instead of
 *     `window`-based `detectInterfaceContext` + resize listener.
 *   - RN-only props `reactVersion` / `designSystemUrl` feed the
 *     WebView import map.
 *   - No `apiBaseUrl` / `appMetadata` props and no app-config fetch —
 *     RN hosts pass a pre-fetched `appConfig`; the web provider can
 *     fetch it from the platform itself.
 *
 * Guarded by the structural twin gate in `../twin-parity.test.ts`
 * (`DOCUMENTED_DELTA_TWINS`): exported surface must match the web
 * copy.
 */
import { useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { Dimensions, PixelRatio } from 'react-native';
import type { AdapterPermissions, PermissionStatus, InterfaceContext, EndUserIdentity, AppDisplayConfig } from '@ggui-ai/protocol';
import { KNOWN_PERMISSION_NAMES, UnknownPermissionNameError } from '@ggui-ai/protocol';
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
  /** Auth context surfaced to embedding hosts and renderer surfaces. */
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
   * thread, not a render.
   */
  hostSessionId?: string;
  /** React version for WebView import map (default: '18.2.0') */
  reactVersion?: string;
  /** Base URL for design system modules in WebView import map */
  designSystemUrl?: string;
  /**
   * Custom handler for permission requests (e.g., camera, microphone).
   *
   * By default, all permissions are granted immediately. Provide a custom
   * `permissionHandler` to integrate with your app's permission flow
   * (e.g., react-native-permissions, expo-permissions, or a custom dialog).
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
  /**
   * App config (endpointUrl, defaultShellType, etc). Consumed by
   * `useInvoke` for the Streamable Invoke Protocol v1.1 — pass this when
   * you have a pre-fetched `AppDisplayConfig` (e.g. when the host fetches
   * it from an API before mounting). Mirrors the web provider's
   * `appConfig` prop.
   */
  appConfig?: AppDisplayConfig | null;
  children: ReactNode;
}

function detectRNInterfaceContext(): InterfaceContext {
  const { width, height } = Dimensions.get('window');
  // Align breakpoints with getDeviceCategory() in interface-context.ts:
  //   width < 768  -> phone
  //   width < 1024 -> tablet
  //   width >= 1024 -> desktop
  const deviceType: 'phone' | 'tablet' | 'desktop' =
    width < 768 ? 'phone' : width < 1024 ? 'tablet' : 'desktop';
  return {
    viewport: { width, height },
    platform: 'mobile',
    deviceType,
    orientation: width >= height ? 'landscape' : 'portrait',
    devicePixelRatio: PixelRatio.get(),
    touchPrimary: true,
  };
}

/**
 * Root provider for the ggui React Native SDK.
 *
 * Wraps the application with shared configuration needed by all ggui hooks
 * and components. Auto-detects interface context from React Native Dimensions
 * and updates on rotation/split-screen changes.
 *
 * @example
 * ```tsx
 * <GguiProvider appId="my-app" wsEndpoint="wss://your-ws-gateway.example/">
 *   <App />
 * </GguiProvider>
 * ```
 */
export function GguiProvider({ appId, wsEndpoint, adapterImpls, interfaceContext: interfaceContextProp, auth, hostSessionId, reactVersion, designSystemUrl, permissionHandler, appConfig, children }: GguiProviderProps) {
  const [adapterPermissions, setAdapterPermissions] = useState<AdapterPermissions>({});

  // Auto-detect interface context from React Native Dimensions
  const [detectedContext, setDetectedContext] = useState<InterfaceContext>(detectRNInterfaceContext);

  // Update on dimension changes (rotation, split-screen, etc.)
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', () => {
      setDetectedContext(detectRNInterfaceContext());
    });
    return () => subscription.remove();
  }, []);

  const interfaceContext = interfaceContextProp || detectedContext;

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
  // no manifest-level allow-list — grant decisions live on
  // `clientCapabilities.gadgets[*].permission`. Pass all impls
  // verbatim.
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
      reactVersion,
      designSystemUrl,
      appConfig,
    }),
    [appId, wsEndpoint, adapterPermissions, resolvedAdapterImpls, requestPermission, interfaceContext, auth, hostSessionId, reactVersion, designSystemUrl, appConfig]
  );

  return <GguiContext.Provider value={value}>{children}</GguiContext.Provider>;
}
