/**
 * Renders route — `/admin/sessions`.
 *
 * Operator-facing "what's live right now?" list. Reads
 * `GET /ggui/console/sessions` on mount and paints one entry card per
 * active render. Each row surfaces the render's `sessionId`, `appId`,
 * status, and (when bound) its `shortCode`.
 *
 * Scope:
 *
 *   - Active renders only. Completed / expired states need server
 *     surface we don't expose yet; the endpoint pins `status:
 *     'active'` so every row the SPA sees is live.
 *   - No per-row polling. Single fetch on mount; operators reload
 *     when they want (console, not a dashboard).
 *   - No destructive actions. This page is list-only; close /
 *     delete belong on the detail page when the operator flow
 *     justifies them.
 *
 * Layout follows the same `ggui-stack` entry-card grammar the
 * Blueprints page uses, so the two index pages read as one surface.
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-sessions-list` on the column container.
 *   - `data-ggui-session-id={sessionId}` on every row.
 *   - `data-ggui-session-status={status}` on every row.
 */
import {
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';

/**
 * Response shape of `GET /ggui/console/sessions`. Must stay in sync
 * with the handler in `packages/mcp-server/src/server.ts`. Defined
 * locally (not exported from a shared module) — same convention the
 * Blueprints + BlueprintViewer routes use: the SPA owns its view-model,
 * the server owns its wire shape, TypeScript checks compatibility at
 * the parse boundary.
 */
interface GguiSessionSummary {
  readonly sessionId: string;
  readonly shortCode?: string;
  readonly appId: string;
  readonly lastActivityAt: number;
  readonly createdAt: number;
  readonly status: 'active' | 'completed' | 'expired';
}

interface GguiSessionsResponse {
  readonly sessions: readonly GguiSessionSummary[];
  readonly total: number;
}

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: GguiSessionsResponse }
  | { readonly kind: 'error'; readonly message: string };

export function Renders(): ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/ggui/console/sessions', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          setState({
            kind: 'error',
            message: `server returned ${res.status}`,
          });
          return;
        }
        const body = (await res.json()) as GguiSessionsResponse;
        setState({ kind: 'ready', data: body });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: String(err) });
      }
    })();
    return () => controller.abort();
  }, []);

  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (state.kind !== 'ready') return null;
    if (needle.length === 0) return state.data.sessions;
    return state.data.sessions.filter((r) =>
      [r.sessionId, r.shortCode ?? '', r.appId]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [state, needle]);

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / renders"
        title="Live renders."
        mute="Active only — render from an agent to create one."
        intro={
          <>
            Every row is an active render on this server. A render has a{' '}
            <code className="ggui-code">shortCode</code> once one is
            minted by <code className="ggui-code">ggui_render</code>.
          </>
        }
      />

      {state.kind === 'loading' ? (
        <StatusCard title="loading" num="REN / 01" tone="draft">
          Loading renders…
        </StatusCard>
      ) : state.kind === 'error' ? (
        <StatusCard title="error" num="ERR / 01" tone="signal">
          Couldn&apos;t load renders — {state.message}.
        </StatusCard>
      ) : (
        <>
          <div className="ggui-form" style={{ marginBottom: 20 }}>
            <label className="ggui-label" htmlFor="ggui-renders-filter">
              filter
            </label>
            <div className="ggui-field">
              <input
                id="ggui-renders-filter"
                name="filter"
                aria-label="filter render entries"
                placeholder="substring match over sessionId, shortCode, appId…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          </div>
          <GguiSessionList
            all={state.data.sessions}
            shown={filtered ?? state.data.sessions}
            filterActive={needle.length > 0}
          />
        </>
      )}
    </section>
  );
}

function GguiSessionList({
  all,
  shown,
  filterActive,
}: {
  readonly all: readonly GguiSessionSummary[];
  readonly shown: readonly GguiSessionSummary[];
  readonly filterActive: boolean;
}): ReactElement {
  if (all.length === 0) return <EmptyGguiSessions />;
  return (
    <div
      data-ggui-sessions-list
      className="ggui-stack"
      aria-label="active renders"
    >
      <div className="ggui-stack__head">
        <span className="ggui-stack__num">REN</span>
        <span className="ggui-stack__label">live renders</span>
        <span className="ggui-stack__count">
          {shown.length}
          {filterActive && shown.length !== all.length ? ` / ${all.length}` : ''}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          No renders match the filter.
        </p>
      ) : (
        <ul className="ggui-stack__list">
          {shown.map((render, index) => (
            <GguiSessionRow
              key={render.sessionId}
              render={render}
              index={index + 1}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function GguiSessionRow({
  render,
  index,
}: {
  readonly render: GguiSessionSummary;
  readonly index: number;
}): ReactElement {
  const shortId = render.sessionId.slice(0, 8);
  const tone =
    render.status === 'active'
      ? 'live'
      : render.status === 'expired'
        ? 'signal'
        : 'ink';
  return (
    <li
      data-ggui-session-id={render.sessionId}
      data-ggui-session-status={render.status}
      className="ggui-stack__entry"
    >
      <div className="ggui-stack__entry-head">
        <span className="ggui-stack__entry-num">
          {`REN / ${String(index).padStart(2, '0')}`}
        </span>
        <span className="ggui-stack__entry-title">
          <code className="ggui-code">{shortId}</code>…
        </span>
        <StatusBadge tone={tone}>{render.status}</StatusBadge>
      </div>
      <div className="ggui-stack__entry-meta">
        <span>
          app <code className="ggui-code">{render.appId}</code>
        </span>
        <span style={{ marginLeft: 12 }}>
          last active{' '}
          <code className="ggui-code">
            {formatRelative(render.lastActivityAt)}
          </code>
        </span>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        {render.shortCode ? (
          <span>
            shortCode{' '}
            <code className="ggui-code">{render.shortCode}</code>
          </span>
        ) : (
          <span className="ggui-muted">
            No shortCode — render via{' '}
            <code className="ggui-code">ggui_render</code> to mint one.
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * Format a Unix ms timestamp as a short relative-time string.
 * Falls back to an ISO chunk for values older than a day — keeps the
 * pill narrow without linking in a formatter dep.
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
  // Local-time ISO prefix, YYYY-MM-DD — no timezone noise, no dep.
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function EmptyGguiSessions(): ReactElement {
  return (
    <div className="ggui-card">
      <div className="ggui-card__head">
        <span className="ggui-card__title">empty</span>
        <span className="ggui-card__num">REN / 00</span>
      </div>
      <div className="ggui-card__body">
        <p className="ggui-body">No renders yet.</p>
        <p className="ggui-muted">
          Render from an agent (<code className="ggui-code">ggui_render</code>)
          to start a generation — new renders appear here on reload.
        </p>
      </div>
    </div>
  );
}

function StatusCard({
  title,
  num,
  tone,
  children,
}: {
  readonly title: string;
  readonly num: string;
  readonly tone: 'draft' | 'signal' | 'ink';
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="ggui-card">
      <div className="ggui-card__head">
        <span className="ggui-card__title">{title}</span>
        <span className="ggui-card__num">{num}</span>
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
