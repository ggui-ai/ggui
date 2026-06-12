/**
 * WebViewRenderer - Renders compiled JS components in a WebView
 *
 * This is the primary rendering strategy for React Native since
 * RN cannot dynamically import JS modules at runtime.
 *
 * Strategy:
 * 1. Take compiled component code (ESM module)
 * 2. Wrap in an HTML shell with React from CDN
 * 3. Render in a WebView
 * 4. Bridge events back to RN via postMessage/onMessage
 */

import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import { View, StyleSheet, ActivityIndicator, Text, Platform } from 'react-native';
import type { WebView as WebViewType, WebViewMessageEvent } from 'react-native-webview';
import { BRIDGE_EVENTS, SRCDOC_AGENT_DATA_BRIDGE } from '@ggui-ai/protocol';
import { getCssTokens } from '@ggui-ai/design/rendering';
import { useGguiContext } from '../context/GguiContext';

// Lazy import to avoid crash if react-native-webview not installed
let WebView: typeof WebViewType | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  WebView = require('react-native-webview').default;
} catch {
  // WebView not available — will show fallback
}

export interface WebViewRendererProps {
  code: string;
  props?: Record<string, unknown>;
  onEvent?: (event: BridgeEvent) => void;
  onError?: (error: Error) => void;
  onReady?: () => void;
}

export interface BridgeEvent {
  type: string;
  payload: unknown;
  componentId?: string;
}

/** Default React version for WebView import map */
const DEFAULT_REACT_VERSION = '18.2.0';

/**
 * Build an HTML document that renders the compiled component.
 *
 * `designSystemUrl` is required — there is no default. Host apps
 * must supply a design-system base URL via `<GguiProvider
 * designSystemUrl="..."/>`. Consumers must self-host the design-system
 * bundle or override the URL explicitly; the SDK never assumes a
 * default host it doesn't own.
 */
function buildHtml(
  code: string,
  props: Record<string, unknown> | undefined,
  reactVersion: string,
  designSystemUrl: string,
): string {
  const propsJson = JSON.stringify(props || {});
  // Strip trailing slash from designSystemUrl for consistent concatenation
  const dsUrl = designSystemUrl.replace(/\/+$/, '');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 16px;
      line-height: 1.5;
      color: #111827;
      background: transparent;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      overflow-x: hidden;
    }
    #root { min-height: 100vh; }
    /* ggui CSS variables — derived from @ggui-ai/design theme */
    ${getCssTokens()}
  </style>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@${reactVersion}",
      "react/": "https://esm.sh/react@${reactVersion}/",
      "react/jsx-runtime": "https://esm.sh/react@${reactVersion}/jsx-runtime",
      "react-dom": "https://esm.sh/react-dom@${reactVersion}",
      "react-dom/client": "https://esm.sh/react-dom@${reactVersion}/client",
      "@ggui-ai/design/primitives": "${dsUrl}/_primitives.js",
      "@ggui-ai/design/components": "${dsUrl}/_compositions.js",
      "@ggui-ai/design/compositions": "${dsUrl}/_compositions.js",
      "@ggui-ai/design/blueprints": "${dsUrl}/_compositions.js"
    }
  }
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';

    // Bridge: send events to React Native
    window.__ggui_bridge = {
      sendEvent(type, payload, componentId) {
        window.ReactNativeWebView?.postMessage(JSON.stringify({
          type: 'event',
          data: { type, payload, componentId }
        }));
      },
      sendReady() {
        window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'ready' }));
      },
      sendError(message) {
        window.ReactNativeWebView?.postMessage(JSON.stringify({
          type: 'error',
          data: { message }
        }));
      },
      sendResize(height) {
        window.ReactNativeWebView?.postMessage(JSON.stringify({
          type: 'resize',
          data: { height }
        }));
      }
    };

    // Listen for agent data pushed via ggui_emit (parent → iframe)
    ${SRCDOC_AGENT_DATA_BRIDGE}

    // Intercept form submissions
    document.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form));
      window.__ggui_bridge.sendEvent('data:submit', data);
    }, true);

    // Fallback: intercept button clicks for components that don't use onSubmit prop
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button[type="submit"], button:not([type])');
      if (!btn) return;
      const container = btn.closest('form') || document.getElementById('root');
      const inputs = container.querySelectorAll('input, textarea, select');
      const data = {};
      inputs.forEach(el => {
        const name = el.name || el.id || el.placeholder || el.getAttribute('aria-label') || ('field_' + Array.from(inputs).indexOf(el));
        if (el.type === 'checkbox') data[name] = el.checked;
        else if (el.type === 'radio') { if (el.checked) data[name] = el.value; }
        else data[name] = el.value;
      });
      // Only send if onSubmit prop didn't already handle it
      if (!window.__ggui_bridge._submitHandled) {
        window.__ggui_bridge.sendEvent('data:submit', data);
      }
      window.__ggui_bridge._submitHandled = false;
    }, true);

    try {
      // Component code
      const componentBlob = new Blob([${JSON.stringify(code)}], { type: 'application/javascript' });
      const componentUrl = URL.createObjectURL(componentBlob);
      const componentModule = await import(componentUrl);
      URL.revokeObjectURL(componentUrl);
      const Blueprint = componentModule.default;

      let RootComponent = Blueprint;

      // Bridge callbacks — wire React props to the event bridge.
      // data:submit is the ONLY event vocabulary (draft-2026-06-12):
      // the retired onChange/onClick bridge emissions dead-ended — the
      // server pipes only data:submit to the agent-facing consume queue.
      const bridgeProps = {
        onSubmit: (data) => {
          window.__ggui_bridge._submitHandled = true;
          window.__ggui_bridge.sendEvent('data:submit', data);
        },
      };

      // Render with data props + bridge props injected
      const dataProps = ${propsJson};
      const root = createRoot(document.getElementById('root'));
      root.render(React.createElement(RootComponent, { ...dataProps, ...bridgeProps }));

      window.__ggui_bridge.sendReady();
    } catch (err) {
      window.__ggui_bridge.sendError(err.message || String(err));
      document.getElementById('root').innerHTML =
        '<div style="padding:16px;color:#991b1b;background:#fee2e2;border-radius:8px;margin:8px">' +
        '<strong>Render Error</strong><br/>' + (err.message || err) + '</div>';
    }
  </script>
</body>
</html>`;
}

/**
 * WebViewRenderer renders compiled component code inside a WebView
 * with bidirectional event bridging to React Native
 */
export function WebViewRenderer({
  code,
  props,
  onEvent,
  onError,
  onReady,
}: WebViewRendererProps): React.JSX.Element {
  const webViewRef = useRef<WebViewType>(null);
  const [contentHeight, setContentHeight] = React.useState(300);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Read configurable URLs from GguiProvider context
  const ctx = useGguiContext();
  const reactVersion = ctx.reactVersion ?? DEFAULT_REACT_VERSION;
  const designSystemUrl = ctx.designSystemUrl;
  if (!designSystemUrl) {
    throw new Error(
      'WebViewRenderer: `designSystemUrl` is required on <GguiProvider>. ' +
        'Pass an explicit URL — no default. (Browser-capability hooks live in ' +
        '@ggui-ai/gadgets and do not need this URL.)',
    );
  }

  const html = useMemo(
    () => buildHtml(code, props, reactVersion, designSystemUrl),
    [code, props, reactVersion, designSystemUrl]
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const message = JSON.parse(event.nativeEvent.data);
        switch (message.type) {
          case 'ready':
            setLoading(false);
            onReady?.();
            break;
          case 'error':
            setError(message.data?.message || 'Unknown error');
            setLoading(false);
            onError?.(new Error(message.data?.message || 'WebView render error'));
            break;
          case 'event':
            onEvent?.(message.data);
            break;
          case 'resize':
            if (message.data?.height && message.data.height > 0) {
              setContentHeight(Math.ceil(message.data.height) + 16);
            }
            break;
        }
      } catch {
        // Ignore non-JSON messages
      }
    },
    [onEvent, onError, onReady]
  );

  // Web platform: render via iframe with srcdoc instead of react-native-webview
  if (Platform.OS === 'web') {
    return (
      <WebIframeRenderer
        html={html}
        loading={loading}
        error={error}
        onLoad={() => setLoading(false)}
        onMessage={(msg) => {
          switch (msg.type) {
            case 'ready':
              setLoading(false);
              onReady?.();
              break;
            case 'error':
              setError(String(msg.data?.message ?? 'Unknown error'));
              setLoading(false);
              onError?.(new Error(String(msg.data?.message ?? 'Iframe render error')));
              break;
            case 'event':
              if (msg.data) onEvent?.(msg.data as unknown as BridgeEvent);
              break;
            case 'resize':
              // On web, iframe uses flex layout — ignore resize messages
              break;
          }
        }}
      />
    );
  }

  if (!WebView) {
    return (
      <View style={styles.error}>
        <Text style={styles.errorTitle}>WebView Not Available</Text>
        <Text style={styles.errorMessage}>
          Install react-native-webview to render generated components.
        </Text>
      </View>
    );
  }

  const WebViewComponent = WebView as unknown as React.ComponentType<Record<string, unknown>>;

  return (
    <View style={[styles.container, { minHeight: contentHeight }]}>
      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="small" color="#3b82f6" />
          <Text style={styles.loadingText}>Rendering component...</Text>
        </View>
      )}
      {error && (
        <View style={styles.error}>
          <Text style={styles.errorTitle}>Render Error</Text>
          <Text style={styles.errorMessage}>{error}</Text>
        </View>
      )}
      <WebViewComponent
        ref={webViewRef}
        source={{ html }}
        style={[styles.webView, { height: contentHeight, opacity: loading ? 0 : 1 }]}
        originWhitelist={['about:blank', 'about:srcdoc']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        onMessage={handleMessage}
        onError={() => {
          setError('WebView failed to load');
          setLoading(false);
        }}
      />
    </View>
  );
}

/**
 * Web-only iframe renderer — replaces react-native-webview on Expo web.
 * Patches the bridge to use window.parent.postMessage instead of ReactNativeWebView.
 */
function WebIframeRenderer({
  html,
  loading,
  error,
  onLoad,
  onMessage,
}: {
  html: string;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  onMessage: (msg: { type: string; data?: Record<string, unknown> }) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Patch the HTML to use parent.postMessage instead of ReactNativeWebView.postMessage
  const patchedHtml = useMemo(() => {
    return html.replace(
      /window\.ReactNativeWebView\?\.postMessage/g,
      'window.parent.postMessage'
    );
  }, [html]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      // Only accept messages from our iframe
      if (iframeRef.current && event.source === iframeRef.current.contentWindow) {
        try {
          const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          onMessage(msg);
        } catch {
          // Ignore non-JSON messages
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onMessage]);

  // Forward agent data (ggui_emit) from parent → iframe via postMessage
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      iframeRef.current?.contentWindow?.postMessage(
        { type: BRIDGE_EVENTS.AGENT_DATA_POST, payload: detail },
        '*'
      );
    };
    window.addEventListener(BRIDGE_EVENTS.AGENT_DATA, handler);
    return () => window.removeEventListener(BRIDGE_EVENTS.AGENT_DATA, handler);
  }, []);

  return (
    <View style={styles.container}>
      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="small" color="#3b82f6" />
          <Text style={styles.loadingText}>Rendering component...</Text>
        </View>
      )}
      {error && (
        <View style={styles.error}>
          <Text style={styles.errorTitle}>Render Error</Text>
          <Text style={styles.errorMessage}>{error}</Text>
        </View>
      )}
      {/* iframe is web-only — rendered via Platform.OS === 'web' guard */}
      <iframe
        ref={iframeRef}
        srcDoc={patchedHtml}
        onLoad={onLoad}
        style={{
          flex: 1,
          border: 'none',
          width: '100%',
          height: '100%',
          opacity: loading ? 0 : 1,
        }}
        sandbox="allow-scripts allow-same-origin allow-forms"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  webView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
    gap: 8,
  },
  loadingText: {
    fontSize: 14,
    color: '#6b7280',
  },
  error: {
    padding: 16,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 8,
    margin: 8,
  },
  errorTitle: {
    fontWeight: '700',
    color: '#991b1b',
    marginBottom: 4,
  },
  errorMessage: {
    fontSize: 14,
    color: '#991b1b',
  },
});
