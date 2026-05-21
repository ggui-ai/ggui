/**
 * `<McpAppIframe>` — the generic MCP Apps iframe host for web.
 *
 * Any React web app can use this to host a ggui (or any MCP Apps-
 * conformant) session: Claude Desktop, ChatGPT, VS Code, Cursor, Goose,
 * third-party playgrounds, a console session viewer. There is zero
 * ggui-specific coupling in the host — the only outward surface is:
 *
 *   - `onToolCall` — caller-provided tool-dispatch callback.
 *   - `onError`    — renderer-emitted ProtocolError frames.
 *   - `onObserve`  — renderer-emitted ObservabilityEvent frames.
 *   - `onUpgradeRequired` — explicit version-negotiation rejection.
 *
 * Host obligations — ENFORCED here:
 *
 *   1. Mount iframe with `src` / `srcdoc` derived from
 *      {@link McpAppIframeProps.resource}.
 *   2. Respond to `ui/initialize` with `{theme, containerDimensions,
 *      locale}` ONLY. NO outer-app state leaks.
 *   3. Respond to `ping`, `ui/open-link` (http(s) only), `tools/call`
 *      (forwards to `onToolCall`), default `method_not_supported`.
 *   4. Send `ui/resource-teardown` from the iframe-ref null phase
 *      BEFORE DOM removal.
 *   5. Surface renderer-emitted typed postMessage events to the
 *      matching callback.
 *
 * Imperative ref:
 *
 *   - `dispatchAction(name, data)` — posts a JSON-RPC notification
 *     into the iframe; a debugging seam for test-action panels.
 *
 * The `<McpAppsStackItemRenderer>` component (ggui-session-specific;
 * takes `stackItem` + `sessionId` + `serverBaseUrl`) is the legacy
 * host, retired once every consumer has migrated. Until then both
 * components coexist.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  DEFAULT_HOST_THEME,
  buildDispatchActionNotification,
  buildResourceTeardownNotification,
  classifyRendererEnvelope,
  deriveResourceMountSource,
  dispatchHostBridgeRequest,
  parseUiMessageEnvelope,
  type HostBridgeContext,
  type HostBridgeRequest,
} from './dispatch.js';
import type {
  McpAppIframeDimensions,
  McpAppIframePermissions,
  McpAppIframeProps,
  McpAppIframeRef,
} from './types.js';

// =============================================================================
// Attribute helpers
// =============================================================================

function buildSandbox(allowSameOrigin: boolean): string {
  // MCP Apps hosts grant the minimum necessary sandbox tokens.
  // `allow-scripts` (iframe needs JS) + `allow-forms` (covers most
  // Apps workflows).
  //
  // `allow-same-origin` is OFF by default — that's the right posture
  // for any third-party MCP App iframe; with it OFF the iframe runs
  // in an opaque/null origin and cannot read the host document.
  //
  // First-party hosts (the operator's own ggui server iframe at
  // `ui://ggui/session/...`) opt in via the `allowSameOrigin` prop.
  // Without `allow-same-origin`, the iframe's same-origin XHR /
  // WebSocket / fetch handshakes against its OWN renderer-bundle
  // origin fail with opaque-origin errors that look like ERR_CONNECTION
  // REFUSED. Opt-in is the right shape: third parties stay deny-by-
  // default, first parties grant the trust explicitly.
  const tokens = ['allow-scripts', 'allow-forms'];
  if (allowSameOrigin) tokens.push('allow-same-origin');
  return tokens.join(' ');
}

function buildAllow(perms: McpAppIframePermissions | undefined): string | undefined {
  if (!perms) return undefined;
  const parts: string[] = [];
  if (perms.camera) parts.push("camera 'self'");
  if (perms.microphone) parts.push("microphone 'self'");
  if (perms.geolocation) parts.push("geolocation 'self'");
  if (perms.clipboardWrite) parts.push("clipboard-write 'self'");
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function resolveContainerDimensions(
  dims: McpAppIframeDimensions | undefined,
): McpAppIframeDimensions {
  return dims ?? {};
}

function resolveLocale(locale: string | undefined): string {
  if (typeof locale === 'string' && locale.length > 0) return locale;
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    return navigator.language;
  }
  return 'en-US';
}

function resolveTheme(
  theme: Record<string, string> | undefined,
): Readonly<Record<string, string>> {
  return theme ?? DEFAULT_HOST_THEME;
}

function openLinkWeb(url: string): void {
  if (typeof window === 'undefined') return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// =============================================================================
// Component
// =============================================================================

export const McpAppIframe = forwardRef<McpAppIframeRef, McpAppIframeProps>(
  function McpAppIframe(
    {
      resource,
      theme,
      locale,
      containerDimensions,
      permissions,
      bootstrap,
      allowSameOrigin = false,
      onToolCall,
      onError,
      onUpgradeRequired,
      onObserve,
      onLifecycle,
      onUiMessage,
    },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    // Outer-DOM mirror of the most recent lifecycle state the renderer
    // posted. `null` (default) renders no `data-ggui-mcp-app-iframe-
    // lifecycle` attribute — observers waiting on the attribute
    // distinguish "renderer hasn't posted yet" from any classified
    // state. Locked in `@ggui-ai/protocol/integrations/mcp-apps` —
    // host MUST mirror the latest received state per the protocol
    // bar's named-obligations criterion.
    const [lifecycleState, setLifecycleState] =
      useState<McpAppLifecycleState | null>(null);
    // Cache the contentWindow at mount time — on detach, the element's
    // `.contentWindow` is null, so the cached handle is the only way
    // the teardown notification can still reach the iframe.
    const iframeWindowRef = useRef<Window | null>(null);

    const mountSource = useMemo(() => deriveResourceMountSource(resource), [resource]);

    // Freeze the dispatch context behind a ref so the `message` listener
    // can see the latest props without re-subscribing on every prop
    // change. The listener reads via `ctxRef.current` — which we
    // synchronously update in the layout effect below.
    const ctxRef = useRef<HostBridgeContext>({
      theme: resolveTheme(theme),
      locale: resolveLocale(locale),
      containerDimensions: resolveContainerDimensions(containerDimensions),
      openLink: openLinkWeb,
      onToolCall,
      ...(bootstrap !== undefined ? { bootstrap } : {}),
    });
    useEffect(() => {
      ctxRef.current = {
        theme: resolveTheme(theme),
        locale: resolveLocale(locale),
        containerDimensions: resolveContainerDimensions(containerDimensions),
        openLink: openLinkWeb,
        onToolCall,
        ...(bootstrap !== undefined ? { bootstrap } : {}),
      };
    }, [theme, locale, containerDimensions, onToolCall, bootstrap]);

    // Late-arrival bootstrap delivery. The iframe's `ui/initialize`
    // request arrives synchronously on mount; if `bootstrap` is still
    // `undefined` at that moment, the dispatch response carries no
    // `_meta.ggui.bootstrap` and the renderer enters its "waiting for
    // tool result" state. When `bootstrap` later transitions to a
    // defined value (e.g. after the WebSocket session push lands the
    // first stack item), post the bootstrap to the iframe via the
    // `ui/notifications/tool-result` notification — same `_meta.ggui.
    // bootstrap` shape that the init response would have used. The
    // renderer's bootstrap parser is idempotent (mount guard inside
    // the shell), so retransmits during a single session are safe.
    const lastBootstrapRef = useRef<typeof bootstrap>(undefined);
    useEffect(() => {
      const prev = lastBootstrapRef.current;
      lastBootstrapRef.current = bootstrap;
      if (prev !== undefined || bootstrap === undefined) return;
      const win =
        iframeRef.current?.contentWindow ?? iframeWindowRef.current;
      if (!win) return;
      try {
        win.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: { toolOutput: { _meta: { ggui: { bootstrap } } } },
          },
          '*',
        );
      } catch {
        // Best-effort: a detached/cross-origin window throwing on
        // postMessage shouldn't surface as an error; the synchronous
        // init-response path already handled the on-mount case.
      }
    }, [bootstrap]);

    // Expose imperative ref. `dispatchAction` is a pure host→iframe
    // notification — no response is expected. Fires into the cached
    // iframe window so the notification still lands during the React
    // effect window where the DOM element exists.
    useImperativeHandle(
      ref,
      () => ({
        dispatchAction(name: string, data: unknown): void {
          const target = iframeRef.current?.contentWindow ?? iframeWindowRef.current;
          if (!target) return;
          target.postMessage(buildDispatchActionNotification(name, data), '*');
        },
      }),
      [],
    );

    const handleMessage = useCallback(
      async (ev: MessageEvent): Promise<void> => {
        // Only trust messages from our own iframe's contentWindow.
        const iframe = iframeRef.current;
        if (!iframe || ev.source !== iframe.contentWindow) return;

        const tag = classifyRendererEnvelope(ev.data);
        switch (tag) {
          case 'bootstrap-failed': {
            const msg = ev.data as RendererBootFailedMessage;
            onError?.(fromBootstrapFailure(msg.reason, msg.message));
            return;
          }
          case 'protocol-error': {
            const env = ev.data as { error: ProtocolError };
            onError?.(env.error);
            return;
          }
          case 'observability': {
            const env = ev.data as ObservabilityMessage;
            onObserve?.(env.event);
            return;
          }
          case 'lifecycle': {
            // Re-validate the envelope shape via the protocol's type
            // guard — `classifyRendererEnvelope` only matched on
            // `type === 'ggui:lifecycle'`, but a host MUST not trust
            // `event.state` without confirming it's a known
            // `McpAppLifecycleState`. A malformed envelope (unknown
            // state, empty stackItemId, malformed error) silently
            // skips the mirror — the legacy attribute stays at its
            // previous value, observers see the protocol violation
            // as a stuck attribute.
            if (!isMcpAppLifecycleMessage(ev.data)) return;
            const env = ev.data as McpAppLifecycleMessage;
            setLifecycleState(env.event.state);
            onLifecycle?.(env.event);
            return;
          }
          case 'upgrade-required': {
            // Dedicated envelope: `{type:'ggui:upgrade-required',
            // server, client}`. Hosts render an inline upgrade prompt;
            // we ALSO emit a matching `onError` so pattern-matchers
            // that route every failure through onError see this path.
            const env = ev.data as {
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
          case 'ui-message': {
            // Agent-routed-dispatch fallback. Iframe-runtime posted
            // `ui/message` so a host running one-shot agent turns can
            // forward this gesture to its own loop. Hosts that read
            // actions via `ggui_consume` long-poll typically ignore
            // this — the consume pipe already carries the event.
            const event = parseUiMessageEnvelope(ev.data);
            if (event !== null) onUiMessage?.(event);
            return;
          }
          case 'jsonrpc': {
            const req = ev.data as HostBridgeRequest;
            const response = await dispatchHostBridgeRequest(req, ctxRef.current);
            if (response) iframe.contentWindow?.postMessage(response, '*');
            return;
          }
          case 'unknown':
          default:
            return;
        }
      },
      [onError, onObserve, onUpgradeRequired, onLifecycle, onUiMessage],
    );

    useEffect(() => {
      if (typeof window === 'undefined') return;
      const listener = (ev: MessageEvent): void => {
        void handleMessage(ev);
      };
      window.addEventListener('message', listener);
      return () => {
        window.removeEventListener('message', listener);
      };
    }, [handleMessage]);

    const sandbox = useMemo(() => buildSandbox(allowSameOrigin), [allowSameOrigin]);
    const allow = useMemo(() => buildAllow(permissions), [permissions]);
    const dims = containerDimensions;

    // Mount source derivation null → caller gave an unmountable
    // resource (e.g., `mcp://` URI with no inline content). We render
    // an empty iframe + emit a bootstrap-failure error so the caller
    // can surface it through `onError`. The effect depends only on
    // `mountSource` — we capture the latest `onError` and `resource.uri`
    // via refs so a handler-identity change does NOT re-fire a
    // previously-reported failure (classification is mount-source-
    // transition-scoped).
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

    const iframeStyle = useMemo(
      () => ({
        width: dims?.width ?? '100%',
        height: dims?.height ?? 480,
        maxWidth: dims?.maxWidth ?? '100%',
        maxHeight: dims?.maxHeight ?? undefined,
        border: '1px solid #e5e5e5',
        borderRadius: 8,
        display: 'block' as const,
      }),
      [dims?.width, dims?.height, dims?.maxWidth, dims?.maxHeight],
    );

    return (
      <iframe
        ref={(el) => {
          if (el) {
            iframeRef.current = el;
            iframeWindowRef.current = el.contentWindow;
          } else {
            // Detach: ref callback fires with null during commit, the
            // iframe is still live. Post the `ui/resource-teardown`
            // notification NOW — passive effect cleanup runs too late
            // (after DOM removal).
            const win = iframeWindowRef.current;
            try {
              win?.postMessage(buildResourceTeardownNotification(), '*');
            } catch {
              // Best-effort courtesy — a detached window throwing on
              // postMessage is expected in some environments; swallow
              // vs. erroring here because the host is about to unmount
              // anyway and the teardown is not a correctness contract.
            }
            iframeRef.current = null;
            iframeWindowRef.current = null;
          }
        }}
        data-ggui-mcp-app-iframe=""
        data-ggui-resource-uri={resource.uri}
        // Outer-DOM mirror of the renderer's lifecycle state. Set when
        // the iframe child posts a `ggui:lifecycle` envelope; absent
        // before the first envelope arrives. Observers (E2E specs,
        // accessibility scanners, console inspectors) pin selectors on
        // this attribute so they don't need to traverse the iframe
        // boundary. See `McpAppLifecycleMessage` in
        // `@ggui-ai/protocol/integrations/mcp-apps`.
        {...(lifecycleState !== null
          ? { 'data-ggui-mcp-app-iframe-lifecycle': lifecycleState }
          : {})}
        title="MCP App"
        sandbox={sandbox}
        {...(allow !== undefined ? { allow } : {})}
        {...(mountSource?.kind === 'srcdoc' ? { srcDoc: mountSource.value } : {})}
        {...(mountSource?.kind === 'src' || mountSource?.kind === 'data-url'
          ? { src: mountSource.value }
          : {})}
        style={iframeStyle}
      />
    );
  },
);
