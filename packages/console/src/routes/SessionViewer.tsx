/**
 * Session viewer route — `/s/<shortCode>`.
 *
 * **Posture: read-only / visual-only.** The console SessionViewer is
 * an admin inspector view — it shows what the agent rendered into a
 * given session. It does NOT forward end-user interactions back to
 * any MCP host (the console has no MCP client to relay through), and
 * it does NOT mount the operator-debug chrome (test-action form,
 * activity ring buffer, error pane) the pre-spec-migration viewer
 * carried.
 *
 * **Why a same-origin srcdoc iframe instead of `<AppRenderer>`.** The
 * spec-canonical `<AppRenderer>` host needs a separate-origin
 * sandbox-proxy + an MCP `client` (or `onCallTool`) to forward
 * inbound `tools/call`. Both are pure overhead for a read-only
 * inspector. We mount the production thin-shell HTML directly into
 * `<iframe srcdoc>` with `sandbox="allow-scripts"` (no
 * `allow-same-origin` = the iframe runs in an opaque origin —
 * effective origin isolation without a second port), then implement
 * just enough of AppBridge to reply to the iframe's
 * `ui/initialize` request with the slice-envelope `_meta` it needs
 * to boot. The iframe-runtime's own wsToken-gated WS channel handles
 * wired-action dispatch independently — the rendered UI stays
 * interactive even though the console host doesn't relay tool calls.
 *
 * # Boot sequence
 *
 *   1. POST `/ggui/console/session-cookie` with the short-code →
 *      mint a same-origin HttpOnly cookie bound to (sessionId, appId).
 *   2. In parallel:
 *      - GET `/ggui/console/session-resource?session=<sessionId>` →
 *        `ResourceContents` blob whose `text` is the production thin-
 *        shell HTML.
 *      - GET `/ggui/console/sessions/<sessionId>/meta` →
 *        slice-envelope JSON (`{ "ai.ggui/session": {...}, "ai.ggui/stack-item": {...} }`,
 *        same shape as the wire `_meta`).
 *      - GET `/ggui/console/session-stack?session=<sessionId>` →
 *        observational stack snapshot (currently unused by the
 *        read-only viewer; kept in the fetch fan-out so the server
 *        round-trip count doesn't regress when an admin panel is
 *        re-added).
 *   3. Mount `<iframe srcdoc={shellHtml} sandbox="allow-scripts">`.
 *   4. Listen for `ui/initialize` postMessage from the iframe's
 *      contentWindow; reply with the spec-canonical JSON-RPC envelope
 *      whose `result.toolOutput._meta` carries the slice pair
 *      (Path-B inline-meta delivery per
 *      `docs/protocol/extensions/ai.ggui-meta.md`).
 *
 * # Unhappy paths
 *
 *   - 404 (short-code miss): explicit not-found card.
 *   - 500/4xx on cookie-mint: error card with status.
 *   - Network fail on any fetch: raw error message.
 *   - Resource OR meta fetch fails (401/403/404/503/network) OR
 *     `contents[]` empty OR missing `ai.ggui/session` slice: explicit
 *     `resource-failed` state with message.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  parseMcpAppAiGguiMeta,
  toMcpAppEnvelope,
  type McpAppAiGguiMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';
import { navigateTo } from '../router.js';

/**
 * Response shape of `POST /ggui/console/session-cookie`. Must
 * match `packages/mcp-server/src/server.ts`'s cookie-mint route.
 */
interface SessionCookieResponse {
  readonly sessionId: string;
  readonly appId: string;
  readonly expiresAt: number;
}

/**
 * Shape of a single content blob returned by the session-resource
 * endpoint. Structurally compatible with
 * `@modelcontextprotocol/sdk`'s `ResourceContents`.
 */
interface SessionResourceContents {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

/**
 * Shape of `GET /ggui/console/session-resource?session=<id>`'s
 * success body.
 */
interface SessionResourceResponse {
  readonly contents: readonly SessionResourceContents[];
}

type BootstrapState =
  | { readonly kind: 'minting' }
  | {
      readonly kind: 'loading-resource';
      readonly session: SessionCookieResponse;
    }
  | {
      readonly kind: 'ready';
      readonly session: SessionCookieResponse;
      readonly resource: SessionResourceContents;
      readonly meta: McpAppAiGguiMeta;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'resource-failed'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export function SessionViewer({
  shortCode,
}: {
  readonly shortCode: string;
}): ReactElement {
  const [state, setState] = useState<BootstrapState>({ kind: 'minting' });

  // Step 1 — mint cookie from short-code.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/ggui/console/session-cookie', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ shortCode }),
          credentials: 'same-origin',
        });
        if (res.status === 404) {
          setState({ kind: 'not-found' });
          return;
        }
        if (!res.ok) {
          setState({
            kind: 'error',
            message: `server returned ${res.status}`,
          });
          return;
        }
        const session = (await res.json()) as SessionCookieResponse;
        setState({ kind: 'loading-resource', session });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: String(err) });
      }
    })();
    return () => controller.abort();
  }, [shortCode]);

  // Step 2 — fetch the session-resource HTML blob, the slice envelope,
  // and the observational stack snapshot in parallel once the cookie's
  // been minted. Cookie travels via `credentials: 'same-origin'`.
  // Resource + meta failure transitions to `resource-failed`; stack
  // failure does NOT block (kept in the fan-out as a no-op probe so
  // when admin chrome is re-added the network shape doesn't regress).
  const loadingSession =
    state.kind === 'loading-resource' ? state.session : null;
  useEffect(() => {
    if (!loadingSession) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const sessionParam = encodeURIComponent(loadingSession.sessionId);
        const [resourceRes, metaRes, _stackRes] = await Promise.all([
          fetch(
            `/ggui/console/session-resource?session=${sessionParam}`,
            {
              method: 'GET',
              signal: controller.signal,
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            },
          ),
          fetch(
            `/ggui/console/sessions/${sessionParam}/meta`,
            {
              method: 'GET',
              signal: controller.signal,
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            },
          ),
          fetch(
            `/ggui/console/session-stack?session=${sessionParam}`,
            {
              method: 'GET',
              signal: controller.signal,
              headers: { accept: 'application/json' },
              credentials: 'same-origin',
            },
          ).catch(() => null),
        ]);
        if (!resourceRes.ok) {
          setState({
            kind: 'resource-failed',
            message: `session-resource fetch returned ${resourceRes.status}`,
          });
          return;
        }
        if (!metaRes.ok) {
          setState({
            kind: 'resource-failed',
            message: `sessions/:id/meta fetch returned ${metaRes.status}`,
          });
          return;
        }
        const resourceBody =
          (await resourceRes.json()) as SessionResourceResponse;
        const first = resourceBody.contents[0];
        if (!first) {
          setState({
            kind: 'resource-failed',
            message: 'session-resource response had empty contents array',
          });
          return;
        }
        const metaBody = (await metaRes.json()) as unknown;
        const parsedMeta = parseMcpAppAiGguiMeta(metaBody);
        if (!parsedMeta.ok || !parsedMeta.meta.session) {
          setState({
            kind: 'resource-failed',
            message: 'sessions/:id/meta response missing `ai.ggui/session` slice',
          });
          return;
        }
        setState({
          kind: 'ready',
          session: loadingSession,
          resource: first,
          meta: parsedMeta.meta,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ kind: 'resource-failed', message: String(err) });
      }
    })();
    return () => controller.abort();
  }, [loadingSession]);

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / session"
        title="Live session."
        mute={
          <>
            <code className="ggui-code">/s/{shortCode}</code>
          </>
        }
        intro="The short-code above resolved against this server's index. The iframe below renders exactly what the agent pushed — interactions inside the iframe dispatch through the same wsToken-gated WS channel the agent's own host uses."
      />

      {state.kind === 'minting' ? (
        <BootstrapCard title="resolving" tone="draft">
          Resolving short-code against{' '}
          <code className="ggui-code">/ggui/console/session-cookie</code>…
        </BootstrapCard>
      ) : state.kind === 'loading-resource' ? (
        <BootstrapCard title="loading" tone="draft">
          Fetching session resource from{' '}
          <code className="ggui-code">/ggui/console/session-resource</code>…
        </BootstrapCard>
      ) : state.kind === 'not-found' ? (
        <UnresolvedCard
          title="Short-code not found"
          body={
            <p className="ggui-body">
              <code className="ggui-code">{shortCode}</code> didn&apos;t
              resolve to a session on this server. The code may have expired,
              been on a different server, or never existed.
            </p>
          }
        />
      ) : state.kind === 'error' ? (
        <UnresolvedCard
          title="Couldn't open session"
          body={<p className="ggui-muted">{state.message}</p>}
        />
      ) : state.kind === 'resource-failed' ? (
        <UnresolvedCard
          title="Session resource unavailable"
          body={<p className="ggui-muted">{state.message}</p>}
        />
      ) : (
        <LiveViewer
          session={state.session}
          resource={state.resource}
          meta={state.meta}
          shortCode={shortCode}
        />
      )}
    </section>
  );
}

/**
 * Minimal JSON-RPC request shape we recognize on the message bus.
 * Anything not matching this is ignored.
 */
interface UiInitializeRequest {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: 'ui/initialize';
  readonly params?: unknown;
}

function isUiInitializeRequest(value: unknown): value is UiInitializeRequest {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
  };
  if (obj.jsonrpc !== '2.0') return false;
  if (obj.method !== 'ui/initialize') return false;
  if (typeof obj.id !== 'number' && typeof obj.id !== 'string') return false;
  return true;
}

/**
 * `ready` state — mount the srcdoc iframe and reply to its
 * `ui/initialize` request with the slice-envelope `_meta`. The iframe
 * runs in an opaque origin (`sandbox="allow-scripts"` without
 * `allow-same-origin`) so it can't reach this window's DOM.
 *
 * The reply implements the minimum slice of AppBridge the iframe-
 * runtime asks for at boot — `ui/initialize` → `{ toolOutput: { _meta: {…} } }`
 * (Path-B inline-meta delivery per spec). No further bridge methods
 * are implemented: outbound `tools/call`, `resources/*`, `prompts/*`
 * are all no-ops, which is the read-only contract.
 */
function LiveViewer({
  session,
  resource,
  meta,
  shortCode,
}: {
  readonly session: SessionCookieResponse;
  readonly resource: SessionResourceContents;
  readonly meta: McpAppAiGguiMeta;
  readonly shortCode: string;
}): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Build the slice envelope once per meta change. The iframe receives
  // it as `result.toolOutput._meta` on the `ui/initialize` reply —
  // iframe-runtime parses the `ai.ggui/*` keys exactly like it would
  // off any wire `_meta` field.
  const envelope = useMemo(() => toMcpAppEnvelope(meta), [meta]);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      // Only respond to messages from THIS iframe's contentWindow —
      // postMessages on `window` from elsewhere (other iframes, the
      // host itself, browser extensions) are ignored.
      if (event.source !== iframe.contentWindow) return;
      if (!isUiInitializeRequest(event.data)) return;
      const reply = {
        jsonrpc: '2.0' as const,
        id: event.data.id,
        result: {
          // Per `ui/initialize` spec response shape; iframe-runtime
          // reads `toolOutput._meta` for the slice envelope.
          toolOutput: {
            _meta: envelope,
          },
        },
      };
      // Reply through `event.source`, NOT a fresh `iframe.contentWindow`
      // dereference. In jsdom, `iframe.contentWindow` is a getter that
      // can return distinct proxy instances across accesses — when
      // tests patch the postMessage method on the FIRST access, a
      // subsequent access can see the unpatched original, which makes
      // the spy invisible to the host's reply path. `event.source`
      // is the exact proxy the message arrived through, so any
      // monkey-patched listener catches the reply. Production browsers
      // don't exhibit this churn, but the safer pattern is to reply
      // on the source you received from regardless.
      //
      // Wildcard target is safe here — the iframe is opaque-origin
      // (sandbox without allow-same-origin), so postMessage's origin
      // check would reject any non-wildcard string anyway.
      const source = event.source;
      if (source && 'postMessage' in source) {
        source.postMessage(reply, '*');
      }
    },
    [envelope],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <section className="ggui-pane" aria-label="live session header">
        <div className="ggui-pane__head">
          <div className="ggui-pane__traffic" aria-hidden>
            <span />
            <span />
            <span />
          </div>
          <span className="ggui-pane__title">session · {shortCode}</span>
          <span className="ggui-pane__meta">read-only inspector</span>
        </div>
        <div className="ggui-pane__body">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <StatusBadge tone="ink">mounted</StatusBadge>
            <span className="ggui-muted">
              session <code className="ggui-code">{session.sessionId}</code>
            </span>
          </div>
          <p className="ggui-muted">
            app <code className="ggui-code">{session.appId}</code> · short-code{' '}
            <code className="ggui-code">{shortCode}</code>
          </p>
        </div>
      </section>

      <section className="ggui-pane" aria-label="rendered session">
        <div className="ggui-pane__head">
          <span className="ggui-pane__title">rendered session</span>
          <span className="ggui-pane__meta">
            <code className="ggui-code">{resource.uri}</code>
          </span>
        </div>
        <div
          className="ggui-pane__body"
          style={{ padding: 0, minHeight: 420 }}
          data-ggui-console-iframe-host
          data-ggui-console-session={session.sessionId}
        >
          <iframe
            ref={iframeRef}
            data-testid="session-viewer-iframe"
            title={`session ${shortCode}`}
            srcDoc={resource.text}
            // `allow-scripts` is required for the shell's inline
            // bootstrap. `allow-same-origin` is INTENTIONALLY omitted —
            // an opaque-origin sandbox gives effective cross-origin
            // isolation without a second port. Inner-iframe access to
            // this window's DOM is blocked by the browser.
            sandbox="allow-scripts"
            style={{
              width: '100%',
              height: '100%',
              minHeight: 420,
              border: 'none',
              display: 'block',
            }}
          />
        </div>
      </section>
    </div>
  );
}

function BootstrapCard({
  title,
  tone,
  children,
}: {
  readonly title: string;
  readonly tone: 'draft' | 'signal' | 'ink';
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="ggui-card">
      <div className="ggui-card__head">
        <span className="ggui-card__title">{title}</span>
        <span className="ggui-card__num">BOOT / 01</span>
      </div>
      <div className="ggui-card__body">
        <p className="ggui-body">
          <StatusBadge tone={tone}>{title}</StatusBadge>
        </p>
        <p className="ggui-muted">{children}</p>
      </div>
    </div>
  );
}

function UnresolvedCard({
  title,
  body,
}: {
  readonly title: string;
  readonly body: ReactNode;
}): ReactElement {
  return (
    <div className="ggui-card">
      <div className="ggui-card__head">
        <span className="ggui-card__title">unresolved</span>
        <span className="ggui-card__num">ERR / 01</span>
      </div>
      <div className="ggui-card__body">
        <h2 className="ggui-h2">{title}</h2>
        {body}
        <div>
          <button
            type="button"
            className="ggui-btn ggui-btn--ghost"
            onClick={() => navigateTo('/')}
          >
            back to landing
          </button>
        </div>
      </div>
    </div>
  );
}
