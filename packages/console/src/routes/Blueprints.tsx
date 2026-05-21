/**
 * Blueprints route — `/blueprints`.
 *
 * Operator-facing answer to _"what can this server produce without
 * generating?"_, merged from two sources the push + handshake paths
 * already consult:
 *
 *   1. **Declared blueprints** from `ggui.json#blueprints.include`
 *      (read via `GET /ggui/console/registry`).
 *   2. **Cached generation entries** the push path has recorded via
 *      the blueprint registry (via `GET /ggui/console/blueprints/cached`).
 *      Contract-keyed; per-row invalidate + bulk clear via DELETE /
 *      POST endpoints.
 *
 * Layout (top → bottom):
 *
 *   - Section head `01 / blueprints`.
 *   - Filter input.
 *   - Two-column grid: declared (left) + cached (right). Both share
 *     the `ggui-stack` entry-card grammar. Cached rows expose
 *     "invalidate ✕" buttons; the cached stack head exposes "clear
 *     all".
 *   - Primitives aside — collapsed by default; expandable single
 *     row showing every primitive with its source pill.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';
import { navigateTo } from '../router.js';

interface BlueprintSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
}

interface PrimitiveSummary {
  readonly name: string;
  readonly source: 'package' | 'local';
  readonly catalog: string;
}

interface RegistryResponse {
  readonly blueprints: readonly BlueprintSummary[];
  readonly primitives: readonly PrimitiveSummary[];
}

interface CachedEntry {
  readonly id: string;
  readonly cachedIntent: string;
  readonly cachedAt: string;
  readonly contractKey?: string;
  readonly kind?: string;
  readonly hitCount?: number;
  readonly lastHitAt?: string;
}

interface CachedResponse {
  readonly entries: readonly CachedEntry[];
  readonly total: number;
}

type RegistryState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: RegistryResponse }
  | { readonly kind: 'error'; readonly message: string };

type CachedState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: CachedResponse }
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export function Blueprints(): ReactElement {
  const [registry, setRegistry] = useState<RegistryState>({ kind: 'loading' });
  const [cached, setCached] = useState<CachedState>({ kind: 'loading' });
  const [filter, setFilter] = useState('');
  const [primitivesExpanded, setPrimitivesExpanded] = useState(false);

  // ── Initial fetches ─────────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/ggui/console/registry', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          setRegistry({ kind: 'error', message: `server returned ${res.status}` });
          return;
        }
        const body = (await res.json()) as RegistryResponse;
        setRegistry({ kind: 'ready', data: body });
      } catch (err) {
        if (controller.signal.aborted) return;
        setRegistry({ kind: 'error', message: String(err) });
      }
    })();
    return () => controller.abort();
  }, []);

  const refreshCached = useCallback(async (signal?: AbortSignal) => {
    setCached({ kind: 'loading' });
    try {
      const res = await fetch('/ggui/console/blueprints/cached', {
        signal,
        headers: { accept: 'application/json' },
      });
      if (res.status === 501) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        setCached({
          kind: 'unsupported',
          message:
            body.message ??
            'The configured vector store does not support enumeration.',
        });
        return;
      }
      if (!res.ok) {
        setCached({ kind: 'error', message: `server returned ${res.status}` });
        return;
      }
      const body = (await res.json()) as CachedResponse;
      setCached({ kind: 'ready', data: body });
    } catch (err) {
      if (signal?.aborted) return;
      setCached({ kind: 'error', message: String(err) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshCached(controller.signal);
    return () => controller.abort();
  }, [refreshCached]);

  // ── Cached mutations ────────────────────────────────────────────
  const invalidateOne = useCallback(
    async (id: string) => {
      try {
        await fetch(`/ggui/console/blueprints/cached/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } catch (err) {
        // Surface the failure on the cached card next refresh — no
        // toast infra in the console yet, and a silent retry would
        // hide the operator-facing problem.
        setCached({ kind: 'error', message: String(err) });
        return;
      }
      await refreshCached();
    },
    [refreshCached],
  );

  const clearAll = useCallback(async () => {
    try {
      await fetch('/ggui/console/blueprints/cached/clear', { method: 'POST' });
    } catch (err) {
      setCached({ kind: 'error', message: String(err) });
      return;
    }
    await refreshCached();
  }, [refreshCached]);

  // ── Filtered views ──────────────────────────────────────────────
  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (registry.kind !== 'ready') return null;
    if (needle.length === 0) return registry.data;
    return {
      blueprints: registry.data.blueprints.filter((b) =>
        [b.id, b.name, b.description ?? '', b.category ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      ),
      primitives: registry.data.primitives.filter((p) =>
        [p.name, p.catalog, p.source]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      ),
    };
  }, [registry, needle]);

  const filteredCached = useMemo(() => {
    if (cached.kind !== 'ready') return null;
    if (needle.length === 0) return cached.data.entries;
    return cached.data.entries.filter((e) =>
      [e.id, e.cachedIntent].join(' ').toLowerCase().includes(needle),
    );
  }, [cached, needle]);

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / blueprints"
        title="What can this server produce without generating?"
        mute="Declared and cached."
        intro={
          <>
            Two answers on one screen. <strong>Declared</strong> blueprints
            from <code className="ggui-code">ggui.json#blueprints.include</code>;{' '}
            <strong>cached</strong> generations the push path has stored
            (contract-keyed, written by the blueprint registry on every
            successful cold-gen).
          </>
        }
      />

      {registry.kind === 'loading' || cached.kind === 'loading' ? (
        <StatusCard title="loading" num="REG / 01" tone="draft">
          Loading…
        </StatusCard>
      ) : registry.kind === 'error' ? (
        <StatusCard title="error" num="ERR / 01" tone="signal">
          Couldn&apos;t load registry — {registry.message}.
        </StatusCard>
      ) : (
        <>
          <div className="ggui-form" style={{ marginBottom: 20 }}>
            <label className="ggui-label" htmlFor="ggui-registry-filter">
              filter
            </label>
            <div className="ggui-field">
              <input
                id="ggui-registry-filter"
                name="filter"
                aria-label="filter registry entries"
                placeholder="substring match over id, name, description, intent…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="ggui-registry-grid">
            <DeclaredColumn
              all={registry.data.blueprints}
              shown={filtered?.blueprints ?? registry.data.blueprints}
              filterActive={needle.length > 0}
            />
            <CachedColumn
              state={cached}
              shown={filteredCached}
              filterActive={needle.length > 0}
              onInvalidate={invalidateOne}
              onClearAll={clearAll}
            />
          </div>

          <PrimitivesAside
            all={registry.data.primitives}
            shown={filtered?.primitives ?? registry.data.primitives}
            filterActive={needle.length > 0}
            expanded={primitivesExpanded}
            onToggle={() => setPrimitivesExpanded((v) => !v)}
          />
        </>
      )}
    </section>
  );
}

// ── Declared ──────────────────────────────────────────────────────

function DeclaredColumn({
  all,
  shown,
  filterActive,
}: {
  readonly all: readonly BlueprintSummary[];
  readonly shown: readonly BlueprintSummary[];
  readonly filterActive: boolean;
}): ReactElement {
  return (
    <div
      data-ggui-registry-list="blueprints"
      className="ggui-stack"
      aria-label="declared blueprints"
    >
      <div className="ggui-stack__head">
        <span className="ggui-stack__num">BPR</span>
        <span className="ggui-stack__label">declared</span>
        <span className="ggui-stack__count">
          {shown.length}
          {filterActive && shown.length !== all.length ? ` / ${all.length}` : ''}
        </span>
      </div>
      {all.length === 0 ? (
        <EmptyDeclared />
      ) : shown.length === 0 ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          No declared blueprints match the filter.
        </p>
      ) : (
        <ul className="ggui-stack__list">
          {shown.map((blueprint, index) => (
            <li
              key={blueprint.id}
              data-ggui-registry-item="blueprint"
              data-ggui-registry-id={blueprint.id}
              className="ggui-stack__entry"
            >
              <div className="ggui-stack__entry-head">
                <span className="ggui-stack__entry-num">
                  {`BPR / ${String(index + 1).padStart(2, '0')}`}
                </span>
                <span className="ggui-stack__entry-title">
                  {blueprint.name}
                </span>
                {blueprint.category ? (
                  <StatusBadge tone="ink">{blueprint.category}</StatusBadge>
                ) : null}
              </div>
              <div className="ggui-stack__entry-meta">
                <code className="ggui-code">{blueprint.id}</code>
              </div>
              {blueprint.description ? (
                <p className="ggui-body" style={{ margin: '8px 0 0' }}>
                  {blueprint.description}
                </p>
              ) : null}
              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="ggui-btn ggui-btn--ghost"
                  onClick={() =>
                    navigateTo(`/preview/${encodeURIComponent(blueprint.id)}`)
                  }
                >
                  preview →
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Cached ────────────────────────────────────────────────────────

function CachedColumn({
  state,
  shown,
  filterActive,
  onInvalidate,
  onClearAll,
}: {
  readonly state: CachedState;
  readonly shown: readonly CachedEntry[] | null;
  readonly filterActive: boolean;
  readonly onInvalidate: (id: string) => Promise<void>;
  readonly onClearAll: () => Promise<void>;
}): ReactElement {
  const all = state.kind === 'ready' ? state.data.entries : [];
  const rows = shown ?? all;
  return (
    <div
      data-ggui-cached-list
      className="ggui-stack"
      aria-label="cached blueprints"
    >
      <div className="ggui-stack__head">
        <span className="ggui-stack__num">CCH</span>
        <span className="ggui-stack__label">cached</span>
        <span className="ggui-stack__count">
          {state.kind === 'ready'
            ? `${rows.length}${filterActive && rows.length !== all.length ? ` / ${all.length}` : ''}`
            : '—'}
        </span>
        {state.kind === 'ready' && all.length > 0 ? (
          <button
            type="button"
            data-ggui-cached-clear-all
            className="ggui-btn ggui-btn--ghost"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              void onClearAll();
            }}
          >
            clear all
          </button>
        ) : null}
      </div>
      {state.kind === 'unsupported' ? (
        <CachedUnsupported message={state.message} />
      ) : state.kind === 'error' ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          Couldn&apos;t load cache — {state.message}.
        </p>
      ) : all.length === 0 ? (
        <EmptyCached />
      ) : rows.length === 0 ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          No cached entries match the filter.
        </p>
      ) : (
        <ul className="ggui-stack__list">
          {rows.map((entry, index) => (
            <li
              key={entry.id}
              data-ggui-cached-item
              data-ggui-cached-id={entry.id}
              className="ggui-stack__entry"
            >
              <div className="ggui-stack__entry-head">
                <span className="ggui-stack__entry-num">
                  {`CCH / ${String(index + 1).padStart(2, '0')}`}
                </span>
                <span className="ggui-stack__entry-title">
                  {entry.cachedIntent}
                </span>
                {typeof entry.hitCount === 'number' ? (
                  <StatusBadge tone="ink">hits {entry.hitCount}</StatusBadge>
                ) : null}
              </div>
              <div className="ggui-stack__entry-meta">
                <code className="ggui-code">{entry.id}</code>
                <span style={{ marginLeft: 12 }}>
                  cached {formatTimestamp(entry.cachedAt)}
                </span>
                {entry.lastHitAt ? (
                  <span style={{ marginLeft: 12 }}>
                    last hit {formatTimestamp(entry.lastHitAt)}
                  </span>
                ) : null}
              </div>
              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  data-ggui-cached-invalidate
                  className="ggui-btn ggui-btn--ghost"
                  onClick={() => {
                    void onInvalidate(entry.id);
                  }}
                >
                  invalidate ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  } catch {
    return iso;
  }
}

// ── Primitives aside ──────────────────────────────────────────────

function PrimitivesAside({
  all,
  shown,
  filterActive,
  expanded,
  onToggle,
}: {
  readonly all: readonly PrimitiveSummary[];
  readonly shown: readonly PrimitiveSummary[];
  readonly filterActive: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  return (
    <div
      data-ggui-registry-list="primitives"
      className="ggui-card"
      aria-label="primitives"
      style={{ marginTop: 24 }}
    >
      <button
        type="button"
        data-ggui-primitives-toggle
        onClick={onToggle}
        className="ggui-card__head"
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
        }}
        aria-expanded={expanded}
      >
        <span className="ggui-card__title">
          {expanded ? '▾' : '▸'} primitives
        </span>
        <span className="ggui-card__num">
          {shown.length}
          {filterActive && shown.length !== all.length
            ? ` / ${all.length}`
            : ''}
          {' available — fyi'}
        </span>
      </button>
      {expanded ? (
        all.length === 0 ? (
          <EmptyPrimitives />
        ) : shown.length === 0 ? (
          <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
            No primitives match the filter.
          </p>
        ) : (
          <ul
            className="ggui-card__body"
            style={{
              listStyle: 'none',
              margin: 0,
              padding: '12px 16px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px 12px',
            }}
          >
            {shown.map((primitive) => (
              <li
                key={`${primitive.catalog}::${primitive.name}`}
                data-ggui-registry-item="primitive"
                data-ggui-registry-name={primitive.name}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <code className="ggui-code">{primitive.name}</code>
                <StatusBadge
                  tone={primitive.source === 'package' ? 'ink' : 'draft'}
                >
                  {primitive.source}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

// ── Empty / status sub-cards ──────────────────────────────────────

function EmptyDeclared(): ReactElement {
  return (
    <div className="ggui-card__body" style={{ padding: '16px 12px' }}>
      <p className="ggui-body" style={{ margin: 0 }}>
        No declared blueprints.
      </p>
      <p className="ggui-muted" style={{ margin: '8px 0 0' }}>
        Add include globs to{' '}
        <code className="ggui-code">ggui.json#blueprints.include</code> and
        colocate each UI with a{' '}
        <code className="ggui-code">ggui.ui.json</code>.
      </p>
    </div>
  );
}

function EmptyCached(): ReactElement {
  return (
    <div className="ggui-card__body" style={{ padding: '16px 12px' }}>
      <p className="ggui-body" style={{ margin: 0 }}>
        No cached generations yet.
      </p>
      <p className="ggui-muted" style={{ margin: '8px 0 0' }}>
        Generate a UI from <code className="ggui-code">/</code> (the
        playground) and the result will land here for future cache hits.
      </p>
    </div>
  );
}

function CachedUnsupported({ message }: { readonly message: string }): ReactElement {
  return (
    <div className="ggui-card__body" style={{ padding: '16px 12px' }}>
      <p className="ggui-body" style={{ margin: 0 }}>
        <StatusBadge tone="signal">unsupported</StatusBadge> Vector store
        doesn&apos;t support enumeration.
      </p>
      <p className="ggui-muted" style={{ margin: '8px 0 0' }}>
        {message}
      </p>
    </div>
  );
}

function EmptyPrimitives(): ReactElement {
  return (
    <div className="ggui-card__body" style={{ padding: '16px 12px' }}>
      <p className="ggui-body" style={{ margin: 0 }}>
        No primitives declared.
      </p>
      <p className="ggui-muted" style={{ margin: '8px 0 0' }}>
        Declare packages or local catalogs in{' '}
        <code className="ggui-code">ggui.json#primitives</code>.
      </p>
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
