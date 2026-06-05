/**
 * `<McpAppIframe>` — the generic MCP Apps iframe host for React Native.
 *
 * RN mirror of `@ggui-ai/react::<McpAppIframe>` — same prop shape, same
 * imperative-ref shape, same callback contract. The platform-specific
 * parts are:
 *
 *   - Underlying element: `react-native-webview` WebView (not iframe).
 *   - Page → host bridge: `ReactNativeWebView.postMessage` forwarded
 *     via an injected-before-content-loaded bridge script (wraps each
 *     page postMessage in the `__ggui_mcp_apps` envelope). Reuses the
 *     existing `buildInjectedBridgeScript` + `buildDeliveryScript`
 *     helpers from the sibling `components/mcp-apps-bridge`.
 *   - Host → page delivery: `WebView.injectJavaScript` synthesising
 *     MessageEvents on `window`.
 *   - `ui/open-link` delegates to `Linking.openURL`.
 *
 * Host obligations — ENFORCED here (parity with the web host):
 *
 *   1. Mount WebView with `source` derived from {@link
 *      McpAppIframeProps.resource}.
 *   2. Respond to `ui/initialize` with `{theme, containerDimensions,
 *      locale}` ONLY. NO outer-app state leaks.
 *   3. Respond to `ping`, `ui/open-link` (http(s) only), `tools/call`
 *      (forwards to `onToolCall`), default `method_not_supported`.
 *   4. Send `ui/resource-teardown` from the effect cleanup BEFORE the
 *      WebView element unmounts.
 *   5. Surface renderer-emitted typed postMessage events to the
 *      matching callback.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Linking, View } from 'react-native';
import WebView, {
  type WebView as WebViewType,
  type WebViewMessageEvent,
} from 'react-native-webview';
import {
  fromBootstrapFailure,
  fromUpgradeRequired,
  type ObservabilityMessage,
  type ProtocolError,
  type RendererBootFailedMessage,
} from '@ggui-ai/iframe-runtime';
import {
  isMcpAppLifecycleMessage,
  type McpAppLifecycleMessage,
  type McpAppLifecycleState,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  buildDeliveryScript,
  buildInjectedBridgeScript,
  NATIVE_BRIDGE_ENVELOPE_KEY,
} from '../components/mcp-apps-bridge';
import {
  DEFAULT_HOST_THEME,
  buildDispatchActionNotification,
  buildResourceTeardownNotification,
  buildToolResultNotification,
  classifyRendererEnvelope,
  deriveResourceMountSource,
  dispatchHostBridgeRequest,
  type HostBridgeContext,
  type HostBridgeRequest,
  type HostBridgeResponse,
  type HostBridgeNotification,
} from './dispatch.js';
import type {
  McpAppIframeDimensions,
  McpAppIframeProps,
  McpAppIframeRef,
} from './types.js';

function resolveContainerDimensions(
  dims: McpAppIframeDimensions | undefined,
): McpAppIframeDimensions {
  return dims ?? {};
}

function resolveLocale(locale: string | undefined): string {
  if (typeof locale === 'string' && locale.length > 0) return locale;
  return 'en-US';
}

function resolveTheme(
  theme: Record<string, string> | undefined,
): Readonly<Record<string, string>> {
  return theme ?? DEFAULT_HOST_THEME;
}

async function openLinkNative(url: string): Promise<void> {
  await Linking.openURL(url);
}

export const McpAppIframe = forwardRef<McpAppIframeRef, McpAppIframeProps>(
  function McpAppIframe(
    {
      resource,
      theme,
      locale,
      containerDimensions,
      permissions,
      meta,
      onToolCall,
      onError,
      onUpgradeRequired,
      onObserve,
      onLifecycle,
    },
    ref,
  ) {
    const webViewRef = useRef<WebViewType | null>(null);
    // Outer-View mirror of the most recent lifecycle state the renderer
    // posted. `null` (default) renders no `accessibilityValue` —
    // observers waiting on the value distinguish "renderer hasn't
    // posted yet" from any classified state. Locked in
    // `@ggui-ai/protocol/integrations/mcp-apps` — host MUST mirror the
    // latest received state per the protocol bar's named-obligations
    // criterion. RN equivalent of the web `data-ggui-mcp-app-iframe-
    // lifecycle` outer-DOM attribute.
    const [lifecycleState, setLifecycleState] =
      useState<McpAppLifecycleState | null>(null);
    const mountSource = useMemo(() => deriveResourceMountSource(resource), [resource]);

    const ctxRef = useRef<HostBridgeContext>({
      theme: resolveTheme(theme),
      locale: resolveLocale(locale),
      containerDimensions: resolveContainerDimensions(containerDimensions),
      openLink: openLinkNative,
      onToolCall,
    });
    useEffect(() => {
      ctxRef.current = {
        theme: resolveTheme(theme),
        locale: resolveLocale(locale),
        containerDimensions: resolveContainerDimensions(containerDimensions),
        openLink: openLinkNative,
        onToolCall,
      };
    }, [theme, locale, containerDimensions, onToolCall]);

    // Track the current `meta` separately from `ctxRef`. `meta` no
    // longer rides on `ui/initialize` (Reading-B retired); the host
    // now delivers it via the spec-canonical
    // `ui/notifications/tool-result` notification fired immediately
    // after the initialize response. Stored in a ref so the
    // initialize-branch dispatch can read the latest value without
    // forcing a re-mount of the listener closure.
    const metaRef = useRef<typeof meta>(meta);
    useEffect(() => {
      metaRef.current = meta;
    }, [meta]);

    // Delivery helper — host → WebView. Reuses the existing synthesis
    // pattern: escape payload through JSON.parse(JSON.stringify(...))
    // + dispatch a `message` event on window with `source =
    // window.parent`.
    const deliverToWebView = useCallback(
      (message: HostBridgeResponse | HostBridgeNotification) => {
        webViewRef.current?.injectJavaScript(buildDeliveryScript(message));
      },
      [],
    );

    useImperativeHandle(
      ref,
      () => ({
        dispatchAction(name: string, data: unknown): void {
          deliverToWebView(buildDispatchActionNotification(name, data));
        },
      }),
      [deliverToWebView],
    );

    // Failure-path classification handlers — delegate to the matching
    // caller callback. Kept inline for parity with the web host's
    // listener switch.
    const handleMessage = useCallback(
      async (event: WebViewMessageEvent): Promise<void> => {
        const raw = event.nativeEvent.data;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Non-JSON payloads come from other messaging paths the
          // page might use (e.g., `console.log` forwarding). Drop
          // them — they're not bridge traffic.
          return;
        }
        if (parsed === null || typeof parsed !== 'object') return;
        const envelope = parsed as Record<string, unknown>;
        // The injected bridge wraps every `window.postMessage` call in
        // `{__ggui_mcp_apps: true, payload: <original>}`. Unwrap
        // here; raw payloads outside the envelope (legacy / non-bridge
        // messages) are dropped.
        if (envelope[NATIVE_BRIDGE_ENVELOPE_KEY] !== true) return;
        const payload = envelope.payload;

        const tag = classifyRendererEnvelope(payload);
        switch (tag) {
          case 'bootstrap-failed': {
            const msg = payload as RendererBootFailedMessage;
            onError?.(fromBootstrapFailure(msg.reason, msg.message));
            return;
          }
          case 'protocol-error': {
            const env = payload as { error: ProtocolError };
            onError?.(env.error);
            return;
          }
          case 'observability': {
            const env = payload as ObservabilityMessage;
            onObserve?.(env.event);
            return;
          }
          case 'lifecycle': {
            // Re-validate the envelope shape via the protocol's type
            // guard — `classifyRendererEnvelope` only matched on
            // `type === 'ggui:lifecycle'`, but a host MUST not trust
            // `event.state` without confirming it's a known
            // `McpAppLifecycleState`. A malformed envelope (unknown
            // state, empty sessionId, malformed error) silently
            // skips the mirror — the legacy attribute stays at its
            // previous value, observers see the protocol violation
            // as a stuck attribute.
            if (!isMcpAppLifecycleMessage(payload)) return;
            const env = payload as McpAppLifecycleMessage;
            setLifecycleState(env.event.state);
            onLifecycle?.(env.event);
            return;
          }
          case 'upgrade-required': {
            const env = payload as {
              server?: string;
              client?: readonly string[];
            };
            const server = typeof env.server === 'string' ? env.server : '';
            const client = Array.isArray(env.client)
              ? (env.client as readonly string[])
              : [];
            onUpgradeRequired?.(server, client);
            onError?.(
              fromUpgradeRequired({
                observedVersion: server.length > 0 ? server : undefined,
                acceptedVersions: client,
                message: 'upgrade-required',
              }),
            );
            return;
          }
          case 'jsonrpc': {
            const req = payload as HostBridgeRequest;
            const response = await dispatchHostBridgeRequest(req, ctxRef.current);
            if (response) deliverToWebView(response);
            // Spec-canonical render-meta delivery (Reading-B retired).
            // When the renderer just completed its `ui/initialize`
            // handshake AND the host was given a `meta` prop, fire the
            // `ui/notifications/tool-result` notification right after
            // the initialize response so the renderer's pre-handshake
            // `awaitToolResultMeta` listener (Tier 2 of
            // `bootSequence`) catches the slice. The renderer
            // registers that listener BEFORE calling
            // `app.connect(transport)`, so a notification sent
            // immediately after we resolve `ui/initialize` arrives
            // strictly after the listener is in place — no race.
            //
            // Filter: only fire on `ui/initialize` requests so a
            // renderer that pings or re-issues an unrelated request
            // doesn't re-trigger the delivery. (`meta` updates
            // mid-mount are out of scope — the wire delivers a fresh
            // tool-result on every `ggui_update` via the live channel.)
            if (req.method === 'ui/initialize' && metaRef.current !== undefined) {
              deliverToWebView(buildToolResultNotification(metaRef.current));
            }
            return;
          }
          case 'unknown':
          default:
            return;
        }
      },
      [deliverToWebView, onError, onObserve, onUpgradeRequired, onLifecycle],
    );

    // Mount-source null → caller gave an unmountable resource. Emit
    // once per transition; refs keep the error surface idempotent
    // across prop-identity changes.
    const onErrorRef = useRef(onError);
    const resourceUriRef = useRef(resource.uri);
    useEffect(() => {
      onErrorRef.current = onError;
    }, [onError]);
    useEffect(() => {
      resourceUriRef.current = resource.uri;
    }, [resource.uri]);
    useEffect(() => {
      if (mountSource === null) {
        onErrorRef.current?.(
          fromBootstrapFailure(
            'MALFORMED_BOOTSTRAP',
            `McpAppIframe: resource uri '${resourceUriRef.current}' is not http(s) and has no inline text/blob content`,
          ),
        );
      }
    }, [mountSource]);

    // Teardown handshake on unmount. Reuses the existing effect-
    // cleanup pattern preserved from the original renderer — the WebView's
    // JS context is still live during cleanup, so the synthesised
    // MessageEvent reaches the embedded page.
    useEffect(() => {
      const webView = webViewRef.current;
      return () => {
        webView?.injectJavaScript(
          buildDeliveryScript(buildResourceTeardownNotification()),
        );
      };
    }, []);

    const injectedScript = useMemo(() => buildInjectedBridgeScript(), []);
    const dims = resolveContainerDimensions(containerDimensions);

    // Native WebView permission gating — media playback requires user
    // gesture when no permission is granted, and pop-ups are disabled
    // so embedded views cannot spawn new browser windows that bypass
    // the `ui/open-link` validation path.
    const mediaRequiresGesture =
      permissions?.camera !== true && permissions?.microphone !== true;

    if (mountSource === null) {
      // GguiSession an empty View so the caller still sees a slot; onError
      // already fired the bootstrap-failed error.
      return (
        <View
          testID="mcp-app-iframe-empty"
          style={{
            width: dims.width ?? '100%',
            height: dims.height ?? 480,
            ...(dims.maxWidth !== undefined ? { maxWidth: dims.maxWidth } : {}),
            ...(dims.maxHeight !== undefined ? { maxHeight: dims.maxHeight } : {}),
            borderWidth: 1,
            borderColor: '#e5e5e5',
            borderRadius: 8,
          }}
        />
      );
    }

    return (
      <View
        testID="mcp-app-iframe-host"
        // Outer-View mirror of the renderer's lifecycle state. Set when
        // the WebView child posts a `ggui:lifecycle` envelope; absent
        // before the first envelope arrives. Observers (RN testing
        // libraries, console inspectors) query `accessibilityValue.text`
        // so they don't need to traverse the WebView boundary. RN
        // equivalent of the web host's `data-ggui-mcp-app-iframe-
        // lifecycle` data attribute. See `McpAppLifecycleMessage` in
        // `@ggui-ai/protocol/integrations/mcp-apps`.
        {...(lifecycleState !== null
          ? { accessibilityValue: { text: lifecycleState } }
          : {})}
        style={{
          width: dims.width ?? '100%',
          height: dims.height ?? 480,
          ...(dims.maxWidth !== undefined ? { maxWidth: dims.maxWidth } : {}),
          ...(dims.maxHeight !== undefined ? { maxHeight: dims.maxHeight } : {}),
          borderWidth: 1,
          borderColor: '#e5e5e5',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <WebView
          ref={webViewRef}
          testID="mcp-app-iframe-webview"
          source={mountSource}
          originWhitelist={['http://*', 'https://*']}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          setSupportMultipleWindows={false}
          mediaPlaybackRequiresUserAction={mediaRequiresGesture}
          injectedJavaScriptBeforeContentLoaded={injectedScript}
          onMessage={(ev) => {
            void handleMessage(ev);
          }}
        />
      </View>
    );
  },
);
