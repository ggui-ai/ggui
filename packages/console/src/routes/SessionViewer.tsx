/**
 * Session viewer route — `/s/<shortCode>`.
 *
 * The console boots the SAME thin-shell HTML Claude Desktop fetches
 * via MCP `resources/read ui://ggui/session` — no compensation layer
 * inside the iframe. Bootstrap-meta forwarding happens host-side via
 * `<McpAppIframe bootstrap={...}>`, which threads the value through
 * `ui/initialize` in a forwarding path scoped to the `_meta.ggui`
 * namespace. The iframe child stays portable: it never assumes it is
 * running inside the console.
 *
 * Boot sequence:
 *
 *   1. POST `/ggui/console/session-cookie` with the short-code →
 *      mint a same-origin HttpOnly cookie bound to (sessionId, appId).
 *   2. In parallel:
 *      - GET `/ggui/console/session-resource?session=<sessionId>` →
 *        `ResourceContents` blob whose `text` is the production thin-
 *        shell HTML (no inlined bootstrap).
 *      - GET `/ggui/console/session-bootstrap?session=<sessionId>` →
 *        `{bootstrap: GguiBootstrapMeta}` JSON.
 *   3. Mount `<McpAppIframe resource={...} bootstrap={...}>`. The host
 *      forwards bootstrap via `ui/initialize`'s `toolOutput._meta.ggui.
 *      bootstrap`; the renderer's `parseBootstrap` reads exactly that
 *      path. All other postMessages (`ggui:renderer-ready`,
 *      `ggui:observe`, `ggui:bootstrap-failed`, `tools/call`) reach
 *      `<McpAppIframe>` natively — no fakeParent override, no
 *      `Object.defineProperty` substitution.
 *
 * Earlier iterations of this viewer consumed a wrapped console shell
 * that inlined the bootstrap + monkey-patched
 * `window.parent.postMessage` from inside the iframe. That layering
 * violation is gone — the iframe child is now portable across any
 * MCP Apps host that supports the prop forwarding path.
 *
 * Unhappy paths handled honestly:
 *
 *   - 404 (short-code miss): explicit not-found card.
 *   - 500/4xx on cookie-mint: error card with status.
 *   - Network fail on either fetch: raw error message.
 *   - Resource OR bootstrap fetch fails (401/403/404/503/network):
 *     explicit `resource-failed` state with message — the viewer
 *     needs both blobs to mount.
 *   - `<McpAppIframe onError>`: routed to the error pane.
 *
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { type ProtocolError } from '@ggui-ai/react';

// Legacy `<McpAppIframe>` (+ its `McpAppIframeProps` / `McpAppIframeRef`
// types) was deleted in the spec-migration slice (2026-05-26 — adopted
// `<AppRenderer>` from `@mcp-ui/client`). This route hasn't been
// migrated yet (cleanup tracked in #98); fail-loud stub keeps the
// console buildable while the SessionViewer rewrite is pending.
function McpAppIframe(_props: McpAppIframeProps): React.JSX.Element {
  throw new Error(
    'console SessionViewer uses deleted <McpAppIframe>. Migrate route to <AppRenderer> + sandbox-proxy URL.',
  );
}
interface McpAppIframeProps {
  readonly resource?: unknown;
  readonly bootstrap?: unknown;
  readonly theme?: Record<string, string>;
  readonly containerDimensions?: { width?: number; height?: number };
  readonly onToolCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly onError?: (err: ProtocolError) => void;
  readonly onObserve?: (event: { readonly kind: string }) => void;
  readonly allowSameOrigin?: boolean;
  readonly ref?: React.RefObject<McpAppIframeRef | null>;
}
interface McpAppIframeRef {
  readonly dispatchAction: (name: string, data: unknown) => void;
}
import type { SessionStackEntry, StackItem } from '@ggui-ai/protocol';
import type { GguiBootstrapMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';
import { navigateTo } from '../router.js';
import {
  MAX_ACTIVITY_EVENTS,
  SessionInspector,
  toObservabilityEventShape,
  type ActivityEvent,
} from './SessionInspector.js';

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
 * `@modelcontextprotocol/sdk`'s `ResourceContents` — the superset
 * requires `uri: string` + allows optional `mimeType` / `text` /
 * `blob`. We declare every field we rely on as required + non-null,
 * which both satisfies the SDK's structural check on `<McpAppIframe
 * resource={…}>` and keeps the fetch layer decoupled from the SDK's
 * type (console avoids pulling `@modelcontextprotocol/sdk` into its
 * dependency tree — the dep boundary matches SessionInspector's
 * decision to stay free of `@ggui-ai/iframe-runtime`).
 */
interface SessionResourceContents {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

/**
 * Shape of `GET /ggui/console/session-resource?session=<id>`'s
 * success body (see `packages/mcp-server/src/server.ts`).
 */
interface SessionResourceResponse {
  readonly contents: readonly SessionResourceContents[];
}

/**
 * Shape of `GET /ggui/console/session-bootstrap?session=<id>`'s
 * success body (see `packages/mcp-server/src/server.ts`). The
 * `bootstrap` field is the `GguiBootstrapMeta` that `<McpAppIframe>`
 * threads through `ui/initialize`.
 */
interface SessionBootstrapResponse {
  readonly bootstrap: GguiBootstrapMeta;
}

/**
 * Shape of `GET /ggui/console/session-stack?session=<id>`'s
 * success body — console-only observation surface for the
 * inspector pane. The iframe owns the live WS subscription, so
 * the OUTER console DOM has no live signal for stack data;
 * this endpoint is the read-once-on-mount source of truth that
 * lets `<SessionInspector>` render contract / test-action panels
 * per stack entry.
 */
interface SessionStackResponse {
  readonly stack: readonly SessionStackEntry[];
  readonly currentStackIndex: number;
  readonly eventSequence: number;
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
      readonly bootstrap: GguiBootstrapMeta;
      readonly stack: readonly SessionStackEntry[];
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

  // Step 2 — fetch the session-resource blob, the bootstrap JSON,
  // and the inspector-side stack snapshot in parallel once the
  // cookie's been minted. Cookie travels via `credentials:
  // 'same-origin'`. Resource + bootstrap failure transitions the
  // viewer to `resource-failed` — both are required to mount the
  // iframe. Stack-fetch failure does NOT block the iframe mount;
  // the inspector pane simply renders an empty-stack hint while
  // the iframe still paints. The iframe is the primary surface;
  // the inspector is observational chrome that should degrade
  // gracefully.
  const loadingSession =
    state.kind === 'loading-resource' ? state.session : null;
  useEffect(() => {
    if (!loadingSession) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const sessionParam = encodeURIComponent(loadingSession.sessionId);
        const [resourceRes, bootstrapRes, stackRes] = await Promise.all([
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
            `/ggui/console/session-bootstrap?session=${sessionParam}`,
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
          ),
        ]);
        if (!resourceRes.ok) {
          setState({
            kind: 'resource-failed',
            message: `session-resource fetch returned ${resourceRes.status}`,
          });
          return;
        }
        if (!bootstrapRes.ok) {
          setState({
            kind: 'resource-failed',
            message: `session-bootstrap fetch returned ${bootstrapRes.status}`,
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
        const bootstrapBody =
          (await bootstrapRes.json()) as SessionBootstrapResponse;
        if (!bootstrapBody.bootstrap) {
          setState({
            kind: 'resource-failed',
            message: 'session-bootstrap response missing `bootstrap` field',
          });
          return;
        }
        // Stack fetch is observational — degrade gracefully when
        // the route 503's (no sessionStore wired) or 4xx's. The
        // iframe still mounts; the inspector pane shows an empty
        // stack with a hint.
        let stack: readonly SessionStackEntry[] = [];
        if (stackRes.ok) {
          try {
            const stackBody = (await stackRes.json()) as SessionStackResponse;
            stack = stackBody.stack;
          } catch {
            // Malformed JSON on the stack route — keep the iframe
            // mount honest; surface zero stack entries.
            stack = [];
          }
        }
        setState({
          kind: 'ready',
          session: loadingSession,
          resource: first,
          bootstrap: bootstrapBody.bootstrap,
          stack,
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
        intro="The short-code above resolved against this server's index. The viewer holds a same-origin cookie on /ws and mirrors every stack mutation the agent emits."
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
          bootstrap={state.bootstrap}
          stack={state.stack}
          shortCode={shortCode}
        />
      )}
    </section>
  );
}

/**
 * `ready` state — mount `<McpAppIframe>` against the fetched
 * `ResourceContents` + `GguiBootstrapMeta`. The bootstrap is forwarded
 * via the `bootstrap` prop (`<McpAppIframe bootstrap={...}>`); the
 * host threads it onto `ui/initialize`'s
 * `toolOutput._meta.ggui.bootstrap`. Feeds `onObserve` into the
 * activity ring buffer and `onError` into the error pane. The test-
 * action panel fires notifications through
 * `iframeRef.current?.dispatchAction`.
 */
function LiveViewer({
  session,
  resource,
  bootstrap,
  stack,
  shortCode,
}: {
  readonly session: SessionCookieResponse;
  readonly resource: SessionResourceContents;
  readonly bootstrap: GguiBootstrapMeta;
  readonly stack: readonly SessionStackEntry[];
  readonly shortCode: string;
}): ReactElement {
  // Activity ring buffer — bounded FIFO so chatty MCPs don't drift
  // the viewer's render cost. Fed by `<McpAppIframe onObserve>`,
  // which surfaces the renderer's observability union via C7c + C12.
  const [activity, setActivity] = useState<readonly ActivityEvent[]>([]);
  const eventCounter = useRef(0);
  const pushActivity = useCallback((event: ActivityEvent) => {
    setActivity((prev) => {
      const next = [...prev, event];
      return next.length > MAX_ACTIVITY_EVENTS
        ? next.slice(next.length - MAX_ACTIVITY_EVENTS)
        : next;
    });
  }, []);
  const nextEventId = useCallback(() => {
    eventCounter.current += 1;
    return `evt-${eventCounter.current}`;
  }, []);

  // `<McpAppIframe onObserve>` fires with `ObservabilityEvent` (owned
  // by `@ggui-ai/iframe-runtime`). Console avoids a direct renderer import
  // — SessionInspector.ts documents the boundary: renderer ships
  // react + design + wire + protocol inline and console would
  // balloon. We extract the parameter type from the exported prop
  // shape (`@ggui-ai/react` re-exports `McpAppIframeProps` but NOT
  // `ObservabilityEvent`) and route through `toObservabilityEventShape`
  // to land the event in the ring buffer (`ActivityEvent['event']`
  // is typed `ObservabilityEventShape` — see SessionInspector.tsx).
  // Every observe emission lands as an `observe` activity row — the
  // row reader (`activityRowLabel` / `activityRowTone` below)
  // pattern-matches on `event.event.kind` for the four known kinds
  // and falls through to an extensible branch for anything else
  // (renderer may ship new kinds ahead of the console's typings —
  // extensibly-closed union invariant).
  type ObserveHandler = NonNullable<McpAppIframeProps['onObserve']>;
  const handleObserve = useCallback<ObserveHandler>(
    (event) => {
      pushActivity({
        kind: 'observe',
        id: nextEventId(),
        at: Date.now(),
        event: toObservabilityEventShape(event),
      });
    },
    [pushActivity, nextEventId],
  );

  const [iframeError, setIframeError] = useState<ProtocolError | null>(null);
  const handleError = useCallback((err: ProtocolError) => {
    setIframeError(err);
  }, []);

  const iframeRef = useRef<McpAppIframeRef>(null);

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
          <span className="ggui-pane__meta">
            {activity.length}{' '}
            {activity.length === 1 ? 'event' : 'events'}
          </span>
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
            <StatusBadge tone={iframeError ? 'signal' : 'ink'}>
              {iframeError ? 'iframe error' : 'mounted'}
            </StatusBadge>
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

      {iframeError ? <IframeErrorPane err={iframeError} /> : null}

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
        >
          <McpAppIframe
            ref={iframeRef}
            resource={resource}
            bootstrap={bootstrap}
            onObserve={handleObserve}
            onError={handleError}
          />
        </div>
      </section>

      <StackInspectorList
        stack={stack}
        activity={activity}
        onFireAction={(name, data) => {
          iframeRef.current?.dispatchAction(name, data);
        }}
      />

      <TestActionForm
        onDispatch={(name, data) => {
          iframeRef.current?.dispatchAction(name, data);
        }}
      />

      <ActivityList activity={activity} />
    </div>
  );
}

/**
 * Stack-inspector pane — renders one `<SessionInspector>` per
 * `StackItem` in the session's stack. The iframe is the primary
 * view; this pane is operator-facing debug chrome (contract /
 * activity / test-action panels per entry).
 *
 * `McpAppsStackItem` entries are filtered out — those are
 * embedded third-party MCP App iframes that don't carry the
 * `actionSpec` / `streamSpec` / `propsSpec` fields the inspector
 * surfaces. Only the `'component'` (generated UI) variant flows
 * through the inspector.
 *
 * `data-ggui-console-stack-inspectors` is the outer anchor for
 * tests; each inspector retains its own `data-ggui-inspect`
 * attribute (asserted by `e2e/ggui-oss/tests/session-inspector.spec.ts`).
 */
function StackInspectorList({
  stack,
  activity,
  onFireAction,
}: {
  readonly stack: readonly SessionStackEntry[];
  readonly activity: readonly ActivityEvent[];
  readonly onFireAction: (name: string, data: unknown) => void;
}): ReactElement {
  // Filter to component-variant StackItems. The inspector's
  // contract panel reads actionSpec / streamSpec / propsSpec —
  // fields McpAppsStackItem doesn't carry (typed as `?: never`
  // on that variant per protocol/types/session.ts).
  const componentEntries: readonly StackItem[] = stack.filter(
    (entry): entry is StackItem => entry.type !== 'mcpApps',
  );
  if (componentEntries.length === 0) {
    return (
      <section
        className="ggui-pane"
        aria-label="stack inspector"
        data-ggui-console-stack-inspectors
        data-ggui-console-stack-inspectors-empty="true"
      >
        <div className="ggui-pane__head">
          <span className="ggui-pane__title">stack inspector</span>
          <span className="ggui-pane__meta">INS · 0 entries</span>
        </div>
        <div className="ggui-pane__body">
          <p className="ggui-muted" style={{ margin: 0 }}>
            No stack entries to inspect yet. When the agent commits a
            generated UI to the session stack (via{' '}
            <code className="ggui-code">ggui_push</code>), per-entry
            contract / activity / test-action panels appear here.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section
      className="ggui-pane"
      aria-label="stack inspector"
      data-ggui-console-stack-inspectors
    >
      <div className="ggui-pane__head">
        <span className="ggui-pane__title">stack inspector</span>
        <span className="ggui-pane__meta">
          INS · {componentEntries.length}{' '}
          {componentEntries.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>
      <div className="ggui-pane__body">
        {componentEntries.map((entry, index) => (
          <SessionInspector
            key={entry.id}
            entry={entry}
            entryIndex={index}
            activity={activity}
            onFireAction={(data) => {
              // Fire through the same dispatcher the rendered UI
              // uses. The inspector's TestActionPanel tracks the
              // selected action name internally; the parsed JSON is
              // routed through `dispatchAction` using the stack-item
              // id as the action key.
              // Operators that need fine-grained per-action firing
              // can use the flat `<TestActionForm>` below — that's
              // the surface where the action name is the form's
              // first field.
              onFireAction(entry.id, data);
            }}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Typed error pane — surfaces `ProtocolError.kind` so operators can
 * tell a transport blip from a bootstrap rejection. Observable-
 * violation leg of the viewer contract (plan §C9.5 Bar 4).
 */
function IframeErrorPane({ err }: { readonly err: ProtocolError }): ReactElement {
  return (
    <div className="ggui-card" data-ggui-console-iframe-error>
      <div className="ggui-card__head">
        <span className="ggui-card__title">iframe error</span>
        <span className="ggui-card__num">ERR / IFR</span>
      </div>
      <div className="ggui-card__body">
        <p className="ggui-body">
          <StatusBadge tone="signal">{err.kind}</StatusBadge>{' '}
          {formatProtocolErrorMessage(err)}
        </p>
      </div>
    </div>
  );
}

function formatProtocolErrorMessage(err: ProtocolError): string {
  if (err.kind === 'transport') return err.message ?? err.code;
  if (err.kind === 'auth') return err.message ?? err.code;
  if (err.kind === 'protocol') return err.message ?? err.code;
  if (err.kind === 'contract')
    return `contract-error ${err.payload.error.code}: ${err.payload.error.message}`;
  if (err.kind === 'bootstrap') return err.message;
  if (err.kind === 'version') return err.message ?? 'version mismatch';
  if (err.kind === 'unknown') return 'unknown error (see ring buffer)';
  // Extensibly-closed union: render gracefully rather than assert.
  return 'unrecognized error';
}

/**
 * Flat test-fire form — replaces the old per-entry TestActionPanel
 * that was stack-bound. Operator types `name` + `data` (JSON); on
 * submit we parse the JSON and fire through `dispatchAction` on the
 * iframe ref. The iframe's own wired-action handler receives it as
 * a JSON-RPC notification (see McpAppIframeRef.dispatchAction).
 */
function TestActionForm({
  onDispatch,
}: {
  readonly onDispatch: (name: string, data: unknown) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [payloadText, setPayloadText] = useState('{}');
  const [parseError, setParseError] = useState<string | null>(null);
  const [lastFired, setLastFired] = useState<string | null>(null);

  const canSubmit = useMemo(() => name.trim().length > 0, [name]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmit) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadText);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : String(err));
        return;
      }
      setParseError(null);
      onDispatch(name, parsed);
      setLastFired(name);
    },
    [canSubmit, name, payloadText, onDispatch],
  );

  return (
    <section
      className="ggui-pane"
      aria-label="test action"
      data-ggui-console-test-action
    >
      <div className="ggui-pane__head">
        <span className="ggui-pane__title">test action</span>
        <span className="ggui-pane__meta">TST · dispatch</span>
      </div>
      <form
        className="ggui-pane__body ggui-form"
        onSubmit={handleSubmit}
        style={{ display: 'grid', gap: 8 }}
      >
        <label className="ggui-label" htmlFor="ggui-console-test-name">
          action name
        </label>
        <div className="ggui-field">
          <input
            id="ggui-console-test-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my.action"
            data-ggui-console-test-name
          />
        </div>
        <label
          className="ggui-label"
          htmlFor="ggui-console-test-payload"
        >
          payload (JSON)
        </label>
        <div className="ggui-field">
          <textarea
            id="ggui-console-test-payload"
            data-ggui-console-test-payload
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            rows={4}
            spellCheck={false}
            style={{
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: '0.85em',
              width: '100%',
            }}
          />
        </div>
        {parseError ? (
          <p
            className="ggui-body"
            style={{ margin: 0 }}
            data-ggui-console-test-parse-error
          >
            <StatusBadge tone="signal">parse error</StatusBadge> {parseError}
          </p>
        ) : null}
        {lastFired && !parseError ? (
          <p
            className="ggui-muted"
            style={{ margin: 0 }}
            data-ggui-console-test-last-fired={lastFired}
          >
            fired <code className="ggui-code">{lastFired}</code> — responses
            appear in the activity log below.
          </p>
        ) : null}
        <div>
          <button
            type="submit"
            className="ggui-btn"
            data-ggui-console-test-submit
            disabled={!canSubmit}
          >
            fire →
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * Flat ring-buffer readout — the inspector's full tab-filter UI was
 * stack-entry-bound; here we stream observe events in arrival order.
 * Every row renders its `event.kind` + a JSON dump so unknown kinds
 * stay observable (extensibly-closed union invariant).
 */
function ActivityList({
  activity,
}: {
  readonly activity: readonly ActivityEvent[];
}): ReactElement {
  return (
    <section
      className="ggui-pane"
      aria-label="activity log"
      data-ggui-console-activity
    >
      <div className="ggui-pane__head">
        <span className="ggui-pane__title">activity</span>
        <span className="ggui-pane__meta">
          ACT · {activity.length}/{MAX_ACTIVITY_EVENTS}
        </span>
      </div>
      <div className="ggui-pane__body">
        {activity.length === 0 ? (
          <p className="ggui-muted" style={{ margin: 0 }}>
            No observability events yet. When the iframe fires a wired
            tool, emits a contract-error envelope, rejects a schema-
            version handshake, or surfaces a non-fatal subscribe
            failure, a row lands here in arrival order.
          </p>
        ) : (
          <ul
            data-ggui-console-activity-list
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 4,
              maxHeight: 280,
              overflowY: 'auto',
            }}
          >
            {[...activity].reverse().map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ActivityRow({
  event,
}: {
  readonly event: ActivityEvent;
}): ReactElement {
  const label = activityRowLabel(event);
  const tone = activityRowTone(event);
  const preview = activityRowPreview(event);
  return (
    <li
      data-ggui-console-activity-row
      data-ggui-console-activity-kind={event.kind}
      style={{
        padding: '4px 8px',
        borderRadius: 3,
        background: 'var(--ggui-surface-subtle, #f8f8f8)',
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        <span className="ggui-muted" style={{ fontSize: '0.8em', minWidth: 80 }}>
          {formatTimeOnly(event.at)}
        </span>
        <StatusBadge tone={tone}>{label}</StatusBadge>
        <code
          className="ggui-code"
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {preview}
        </code>
      </div>
    </li>
  );
}

/**
 * Row label: observe rows surface the inner observability `kind` so
 * operators see `wired-tool-invoked` / `contract-error-emitted` /
 * etc. rather than the outer category. Dispatch / response / stream
 * rows retain the arrow shorthand from the old inspector.
 */
function activityRowLabel(event: ActivityEvent): string {
  if (event.kind === 'dispatch') return '⟶';
  if (event.kind === 'response') return '⟵ack';
  if (event.kind === 'stream') return '⟵str';
  return event.event.kind;
}

function activityRowTone(
  event: ActivityEvent,
): 'ink' | 'draft' | 'signal' {
  if (event.kind === 'stream') return 'draft';
  if (event.kind === 'observe') {
    if (event.event.kind === 'contract-error-emitted') return 'signal';
    if (event.event.kind === 'schema-version-mismatch') return 'signal';
    return 'draft';
  }
  return 'ink';
}

function activityRowPreview(event: ActivityEvent): string {
  const source =
    event.kind === 'observe'
      ? event.event
      : event.kind === 'response'
        ? event.response
        : event.kind === 'dispatch'
          ? event.data
          : event.payload;
  const s = safeStringify(source);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

function formatTimeOnly(at: number): string {
  try {
    const d = new Date(at);
    return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
  } catch {
    return String(at);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
