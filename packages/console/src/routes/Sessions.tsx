/**
 * Sessions route — `/sessions`.
 *
 * Operator-facing "what's live right now?" list. Reads
 * `GET /ggui/console/sessions` on mount, paints one entry card per
 * active session, and click-through to `/s/<shortCode>` (the
 * existing viewer) when a shortCode is bound.
 *
 * Scope:
 *
 *   - Active sessions only. Completed / expired states need server
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
import { navigateTo } from '../router.js';

/**
 * Response shape of `GET /ggui/console/sessions`. Must stay in sync
 * with the handler in `packages/mcp-server/src/server.ts`. Defined
 * locally (not exported from a shared module) — same convention the
 * Blueprints + BlueprintViewer routes use: the SPA owns its view-model,
 * the server owns its wire shape, TypeScript checks compatibility at
 * the parse boundary.
 */
interface SessionSummary {
  readonly sessionId: string;
  readonly shortCode?: string;
  readonly appId: string;
  readonly stackSize: number;
  readonly lastActivityAt: number;
  readonly createdAt: number;
  readonly status: 'active' | 'completed' | 'expired';
}

interface SessionsResponse {
  readonly sessions: readonly SessionSummary[];
  readonly total: number;
}

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: SessionsResponse }
  | { readonly kind: 'error'; readonly message: string };

export function Sessions(): ReactElement {
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
        const body = (await res.json()) as SessionsResponse;
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
    return state.data.sessions.filter((s) =>
      [s.sessionId, s.shortCode ?? '', s.appId]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [state, needle]);

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / sessions"
        title="Live sessions."
        mute="Active only — push from an agent to create one."
        intro={
          <>
            Every row is an active session on this server. Click-through
            to the viewer when a session has a{' '}
            <code className="ggui-code">shortCode</code> minted by{' '}
            <code className="ggui-code">ggui_render</code>.
          </>
        }
      />

      {state.kind === 'loading' ? (
        <StatusCard title="loading" num="SES / 01" tone="draft">
          Loading sessions…
        </StatusCard>
      ) : state.kind === 'error' ? (
        <StatusCard title="error" num="ERR / 01" tone="signal">
          Couldn&apos;t load sessions — {state.message}.
        </StatusCard>
      ) : (
        <>
          <div className="ggui-form" style={{ marginBottom: 20 }}>
            <label className="ggui-label" htmlFor="ggui-sessions-filter">
              filter
            </label>
            <div className="ggui-field">
              <input
                id="ggui-sessions-filter"
                name="filter"
                aria-label="filter session entries"
                placeholder="substring match over sessionId, shortCode, appId…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          </div>
          <SessionList
            all={state.data.sessions}
            shown={filtered ?? state.data.sessions}
            filterActive={needle.length > 0}
          />
        </>
      )}
    </section>
  );
}

function SessionList({
  all,
  shown,
  filterActive,
}: {
  readonly all: readonly SessionSummary[];
  readonly shown: readonly SessionSummary[];
  readonly filterActive: boolean;
}): ReactElement {
  if (all.length === 0) return <EmptySessions />;
  return (
    <div
      data-ggui-sessions-list
      className="ggui-stack"
      aria-label="active sessions"
    >
      <div className="ggui-stack__head">
        <span className="ggui-stack__num">SES</span>
        <span className="ggui-stack__label">live sessions</span>
        <span className="ggui-stack__count">
          {shown.length}
          {filterActive && shown.length !== all.length ? ` / ${all.length}` : ''}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          No sessions match the filter.
        </p>
      ) : (
        <ul className="ggui-stack__list">
          {shown.map((session, index) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              index={index + 1}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionRow({
  session,
  index,
}: {
  readonly session: SessionSummary;
  readonly index: number;
}): ReactElement {
  const shortId = session.sessionId.slice(0, 8);
  const tone =
    session.status === 'active'
      ? 'live'
      : session.status === 'expired'
        ? 'signal'
        : 'ink';
  return (
    <li
      data-ggui-session-id={session.sessionId}
      data-ggui-session-status={session.status}
      className="ggui-stack__entry"
    >
      <div className="ggui-stack__entry-head">
        <span className="ggui-stack__entry-num">
          {`SES / ${String(index).padStart(2, '0')}`}
        </span>
        <span className="ggui-stack__entry-title">
          <code className="ggui-code">{shortId}</code>…
        </span>
        <StatusBadge tone={tone}>{session.status}</StatusBadge>
      </div>
      <div className="ggui-stack__entry-meta">
        <span>
          app <code className="ggui-code">{session.appId}</code>
        </span>
        <span style={{ marginLeft: 12 }}>
          stack{' '}
          <code className="ggui-code">{String(session.stackSize)}</code>
        </span>
        <span style={{ marginLeft: 12 }}>
          last active{' '}
          <code className="ggui-code">
            {formatRelative(session.lastActivityAt)}
          </code>
        </span>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        {session.shortCode ? (
          <>
            <code className="ggui-code">{session.shortCode}</code>
            <button
              type="button"
              className="ggui-btn ggui-btn--ghost"
              onClick={() =>
                navigateTo(
                  `/s/${encodeURIComponent(session.shortCode as string)}`,
                )
              }
            >
              open viewer →
            </button>
          </>
        ) : (
          <span className="ggui-muted">
            No shortCode — push a stack item via{' '}
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

function EmptySessions(): ReactElement {
  return (
    <div className="ggui-card">
      <div className="ggui-card__head">
        <span className="ggui-card__title">empty</span>
        <span className="ggui-card__num">SES / 00</span>
      </div>
      <div className="ggui-card__body">
        <p className="ggui-body">No sessions yet.</p>
        <p className="ggui-muted">
          Push from an agent (<code className="ggui-code">ggui_render</code>)
          or open <code className="ggui-code">/chat</code> to start a
          generation — new sessions appear here on reload.
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
