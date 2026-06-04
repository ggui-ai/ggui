/**
 * Status dashboard — `/status`.
 *
 * Internal debug view: "what's this ggui serve doing right now?"
 * (wiring, storage, capabilities, live sessions). Chat at `/` owns
 * the brand hero + wordmark; this page is utilitarian, so its
 * header is just the SectionHead carrying the page name — no
 * wordmark duplication.
 *
 * Layout:
 *
 *   - SectionHead (page title only — no brand hero).
 *   - **Live renders rail** (above the grid): full-width card with
 *     top-3 renders + an "open latest →" one-click CTA. Renders an
 *     empty variant pointing at `/` when no renders are live.
 *   - 2-column grid of status cards (stacks on narrow viewports):
 *       • server        — name + version + description
 *       • pairing       — pair code + expiry / disabled / idle
 *       • capabilities  — tool / blueprint / primitive counts,
 *         agent + generation wiring
 *       • storage       — render + vector store backends
 *
 * Fetches in parallel:
 *   - `GET /ggui/console/info`           (server + pairing + capabilities + storage)
 *   - `GET /ggui/console/renders?limit=3` (live-now rail data)
 */
import {
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';
import { navigateTo } from '../router.js';

/**
 * Shape of `GET /ggui/console/info`. Must match the handler in
 * `packages/mcp-server/src/server.ts`.
 */
interface ServerInfoResponse {
  readonly server: string;
  readonly version: string;
  readonly description?: string;
  readonly pairing: {
    readonly enabled: boolean;
    readonly pending: {
      readonly code: string;
      readonly codeExpiresAt: number;
      readonly serverName: string;
    } | null;
  };
  readonly capabilities: {
    readonly toolCount: number;
    readonly blueprintCount: number;
    readonly primitiveCount: number;
    readonly agentWired: boolean;
    readonly generation: {
      readonly wired: boolean;
      readonly hasCredentials: boolean;
    };
  };
  readonly storage: {
    readonly renderStore: 'memory' | 'custom';
    readonly vectorStore: 'memory' | 'custom';
  };
}

interface RenderSummary {
  readonly renderId: string;
  readonly shortCode?: string;
  readonly appId: string;
  readonly lastActivityAt: number;
  readonly createdAt: number;
  readonly status: 'active' | 'completed' | 'expired';
}

interface RendersResponse {
  readonly renders: readonly RenderSummary[];
  readonly total: number;
}

type InfoState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly info: ServerInfoResponse }
  | { readonly kind: 'error'; readonly message: string };

type RendersState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly data: RendersResponse }
  | { readonly kind: 'error' };

export function Status(): ReactElement {
  const [info, setInfo] = useState<InfoState>({ kind: 'loading' });
  const [renders, setRenders] = useState<RendersState>({
    kind: 'loading',
  });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/ggui/console/info', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          setInfo({
            kind: 'error',
            message: `server returned ${res.status}`,
          });
          return;
        }
        const body = (await res.json()) as ServerInfoResponse;
        setInfo({ kind: 'ok', info: body });
      } catch (err) {
        if (controller.signal.aborted) return;
        setInfo({ kind: 'error', message: String(err) });
      }
    })();
    void (async () => {
      try {
        const res = await fetch('/ggui/console/renders?limit=3', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          setRenders({ kind: 'error' });
          return;
        }
        const body = (await res.json()) as RendersResponse;
        setRenders({ kind: 'ok', data: body });
      } catch {
        if (!controller.signal.aborted) setRenders({ kind: 'error' });
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <section className="ggui-section" data-ggui-status-dashboard>
      <SectionHead
        num="01 / status"
        title="What's this server doing right now?"
        mute="Every card reads a local endpoint. No hosted calls."
        intro={
          <>
            Reloads on demand — console is an operator surface, not a
            live feed. Nav above points at the other pages:{' '}
            <code className="ggui-code">playground</code>,{' '}
            <code className="ggui-code">blueprints</code>,{' '}
            <code className="ggui-code">tools</code>,{' '}
            <code className="ggui-code">config</code>.
          </>
        }
      />
      <LiveRendersHero state={renders} />
      <div className="ggui-status-grid">
        <ServerCard state={info} />
        <PairingCard state={info} />
        <CapabilitiesCard state={info} />
        <StorageCard state={info} />
      </div>
    </section>
  );
}

function ServerCard({ state }: { readonly state: InfoState }): ReactElement {
  return (
    <Card num="SRV / 01" title="server">
      {state.kind === 'ok' ? (
        <>
          <dl className="ggui-kv">
            <div>
              <dt>name</dt>
              <dd>{state.info.server}</dd>
            </div>
            <div>
              <dt>version</dt>
              <dd>
                <code className="ggui-code">{state.info.version}</code>
              </dd>
            </div>
            {state.info.description ? (
              <div>
                <dt>description</dt>
                <dd>{state.info.description}</dd>
              </div>
            ) : null}
          </dl>
        </>
      ) : state.kind === 'loading' ? (
        <p className="ggui-muted">Loading server identity…</p>
      ) : (
        <p className="ggui-muted">
          Couldn&apos;t reach <code className="ggui-code">/ggui/console/info</code>{' '}
          — {state.message}.
        </p>
      )}
    </Card>
  );
}

function PairingCard({
  state,
}: {
  readonly state: InfoState;
}): ReactElement {
  if (state.kind !== 'ok') {
    return (
      <Card num="PAR / 01" title="pairing">
        <p className="ggui-muted">
          {state.kind === 'loading' ? 'Loading…' : 'Unavailable.'}
        </p>
      </Card>
    );
  }
  const { enabled, pending } = state.info.pairing;
  if (!enabled) {
    return (
      <Card num="PAR / 01" title="pairing">
        <p className="ggui-body">
          <StatusBadge tone="ink">disabled</StatusBadge>
        </p>
        <p className="ggui-muted">
          This server was composed with{' '}
          <code className="ggui-code">pairing: false</code>. Pass{' '}
          <code className="ggui-code">{'pairing: true'}</code> at boot to
          enable per-device auth.
        </p>
      </Card>
    );
  }
  if (!pending) {
    return (
      <Card num="PAR / 01" title="pairing">
        <p className="ggui-body">
          <StatusBadge tone="live">idle</StatusBadge>
        </p>
        <p className="ggui-muted">
          Pairing is enabled. No pair code is pending — mint one via the
          CLI (<code className="ggui-code">ggui pair</code>) or the admin
          route.
        </p>
      </Card>
    );
  }
  const remaining = Math.max(
    0,
    Math.round((pending.codeExpiresAt - Date.now()) / 1000),
  );
  return (
    <Card num="PAR / 01" title="pairing">
      <p className="ggui-body">
        <StatusBadge tone="draft">pending</StatusBadge>
      </p>
      <p
        className="ggui-code"
        style={{ fontSize: 24, letterSpacing: '0.08em', margin: '8px 0' }}
      >
        {pending.code}
      </p>
      <p className="ggui-muted">
        Valid for <code className="ggui-code">{remaining}s</code>. Paste
        into a paired client or{' '}
        <code className="ggui-code">POST /pair</code> with the bearer.
      </p>
    </Card>
  );
}

function CapabilitiesCard({
  state,
}: {
  readonly state: InfoState;
}): ReactElement {
  if (state.kind !== 'ok') {
    return (
      <Card num="CAP / 01" title="capabilities">
        <p className="ggui-muted">
          {state.kind === 'loading' ? 'Loading…' : 'Unavailable.'}
        </p>
      </Card>
    );
  }
  const c = state.info.capabilities;
  return (
    <Card num="CAP / 01" title="capabilities">
      <dl className="ggui-kv">
        <div>
          <dt>tools</dt>
          <dd>
            <code className="ggui-code">{c.toolCount}</code>
          </dd>
        </div>
        <div>
          <dt>blueprints</dt>
          <dd>
            <code className="ggui-code">{c.blueprintCount}</code>
          </dd>
        </div>
        <div>
          <dt>primitives</dt>
          <dd>
            <code className="ggui-code">{c.primitiveCount}</code>
          </dd>
        </div>
        <div>
          <dt>agent</dt>
          <dd>
            <StatusBadge tone={c.agentWired ? 'live' : 'ink'}>
              {c.agentWired ? 'wired' : 'off'}
            </StatusBadge>
          </dd>
        </div>
        <div>
          <dt>generation</dt>
          <dd>
            {renderGenerationBadge(c.generation)}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

/**
 * Three-state pill for the generation row — honest labeling per the
 * 2026-04-22 browser-tour feedback. The previous two-state pill
 * reported `wired` green even without a BYOK key, which contradicted
 * the chat pane's `text-only` meta and misled operators.
 *
 *   - `wired=false`              → off (neutral, no generator bound)
 *   - `wired=true, creds=false`  → needs key (draft tone, with hint)
 *   - `wired=true, creds=true`   → ready (live tone, full green-light)
 */
function renderGenerationBadge(generation: {
  readonly wired: boolean;
  readonly hasCredentials: boolean;
}): ReactElement {
  if (!generation.wired) {
    return <StatusBadge tone="ink">off</StatusBadge>;
  }
  if (!generation.hasCredentials) {
    return <StatusBadge tone="draft">needs key</StatusBadge>;
  }
  return <StatusBadge tone="live">ready</StatusBadge>;
}

function StorageCard({
  state,
}: {
  readonly state: InfoState;
}): ReactElement {
  if (state.kind !== 'ok') {
    return (
      <Card num="STG / 01" title="storage">
        <p className="ggui-muted">
          {state.kind === 'loading' ? 'Loading…' : 'Unavailable.'}
        </p>
      </Card>
    );
  }
  const s = state.info.storage;
  const tone = (backend: 'memory' | 'custom'): 'draft' | 'live' =>
    backend === 'custom' ? 'live' : 'draft';
  return (
    <Card num="STG / 01" title="storage">
      <dl className="ggui-kv">
        <div>
          <dt>sessions</dt>
          <dd>
            <StatusBadge tone={tone(s.renderStore)}>
              {s.renderStore}
            </StatusBadge>
          </dd>
        </div>
        <div>
          <dt>vectors</dt>
          <dd>
            <StatusBadge tone={tone(s.vectorStore)}>
              {s.vectorStore}
            </StatusBadge>
          </dd>
        </div>
      </dl>
      <p className="ggui-muted" style={{ marginTop: 12 }}>
        <code className="ggui-code">memory</code> = in-process default
        (loss on restart). <code className="ggui-code">custom</code> =
        operator-wired store.
      </p>
    </Card>
  );
}

/**
 * Live-renders hero — surfaces the most operator-relevant signal on
 * this page (where to find the live `/s/<shortCode>` viewer). Rendered
 * directly above the status grid so it's the first thing an operator
 * sees after the page header.
 *
 *   - loading → skeleton line; no layout thrash
 *   - error   → quiet micro-card, grid still paints
 *   - empty   → compact tip pointing at `/chat` (no hero rail)
 *   - ≥1      → full-width rail with top-3 rows + "open latest →"
 *               primary CTA + "view all (N) →" trailing link
 *
 * Rationale: the `/s/<shortCode>` viewer is the most important page
 * in the console, but reaching it from the dashboard would otherwise
 * take two clicks. This component is the dashboard's answer to
 * "what's live right now?" — one click away, first thing visible,
 * captures the common case (open latest) with a single button.
 */
function LiveRendersHero({
  state,
}: {
  readonly state: RendersState;
}): ReactElement {
  if (state.kind === 'loading') {
    return (
      <div className="ggui-status-hero" data-ggui-status-hero="loading">
        <p className="ggui-muted">Loading live renders…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="ggui-status-hero" data-ggui-status-hero="error">
        <p className="ggui-muted">
          Couldn&apos;t reach <code className="ggui-code">/ggui/console/renders</code>.
        </p>
      </div>
    );
  }
  if (state.data.renders.length === 0) {
    return (
      <div
        className="ggui-status-hero ggui-status-hero--empty"
        data-ggui-status-hero="empty"
      >
        <div className="ggui-status-hero__head">
          <span className="ggui-status-hero__eyebrow">
            <StatusBadge tone="ink">idle</StatusBadge>
            <span>live renders</span>
          </span>
        </div>
        <p className="ggui-muted" style={{ margin: 0 }}>
          No renders yet. Open{' '}
          <button
            type="button"
            className="ggui-link"
            onClick={() => navigateTo('/')}
          >
            playground
          </button>{' '}
          to start one, or point an agent at{' '}
          <code className="ggui-code">ggui_render</code>.
        </p>
      </div>
    );
  }

  const all = state.data.renders;
  const top3 = all.slice(0, 3);
  const latest = top3.find((r) => typeof r.shortCode === 'string');

  return (
    <div
      className="ggui-status-hero ggui-status-hero--active"
      data-ggui-status-hero="active"
      data-ggui-live-render-count={String(all.length)}
    >
      <div className="ggui-status-hero__head">
        <span className="ggui-status-hero__eyebrow">
          <StatusBadge tone="live">live</StatusBadge>
          <span>
            {all.length} {all.length === 1 ? 'render' : 'renders'}
          </span>
        </span>
        {latest ? (
          <button
            type="button"
            className="ggui-btn"
            onClick={() =>
              navigateTo(
                `/s/${encodeURIComponent(latest.shortCode as string)}`,
              )
            }
            data-ggui-status-hero-open-latest
          >
            open latest →
          </button>
        ) : null}
      </div>
      <ul className="ggui-status-hero__list">
        {top3.map((r) => (
          <li
            key={r.renderId}
            className="ggui-status-hero__row"
            data-ggui-dashboard-render-id={r.renderId}
          >
            <div className="ggui-status-hero__row-main">
              {r.shortCode ? (
                <code
                  className="ggui-code"
                  data-ggui-status-hero-shortcode={r.shortCode}
                >
                  /s/{r.shortCode}
                </code>
              ) : (
                <code className="ggui-code">{r.renderId.slice(0, 8)}…</code>
              )}
              <span className="ggui-muted">
                {formatRelative(r.lastActivityAt)}
              </span>
            </div>
            {r.shortCode ? (
              <button
                type="button"
                className="ggui-btn ggui-btn--ghost"
                onClick={() =>
                  navigateTo(
                    `/s/${encodeURIComponent(r.shortCode as string)}`,
                  )
                }
              >
                open →
              </button>
            ) : (
              <span className="ggui-muted">no shortCode</span>
            )}
          </li>
        ))}
      </ul>
      {all.length > top3.length ? (
        <div className="ggui-status-hero__foot">
          <button
            type="button"
            className="ggui-link"
            onClick={() => navigateTo('/admin/renders')}
          >
            view all {all.length} →
          </button>
        </div>
      ) : (
        <div className="ggui-status-hero__foot">
          <button
            type="button"
            className="ggui-link"
            onClick={() => navigateTo('/admin/renders')}
          >
            view all →
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Relative-time formatter — shared with `Renders.tsx`. Simple inline
 * copy avoids creating a utilities module for a 10-line helper; the
 * status hero list mirrors the renders-list formatter character for
 * character so operators read the same string across pages.
 */
function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return 'just now';
  const s = Math.floor(delta / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = new Date(ms);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function Card({
  num,
  title,
  children,
}: {
  readonly num: string;
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="ggui-card">
      <div className="ggui-card__head">
        <span className="ggui-card__title">{title}</span>
        <span className="ggui-card__num">{num}</span>
      </div>
      <div className="ggui-card__body">{children}</div>
    </div>
  );
}
