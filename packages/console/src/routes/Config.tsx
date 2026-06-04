/**
 * Config viewer — `/admin/config` (admin-cookie-gated).
 *
 * **Read-only manifest debug surface.** VSCode-settings-style view of
 * `ggui.json` — left rail navigates top-level fields, right pane
 * shows the schema description (from Zod `.describe()` surfaced via
 * JSON Schema), the current value, the default, and the raw schema.
 *
 * After the 2026-05-03 two-zone IA reorg this page lives under
 * `/admin/config` and is framed honestly as a debug view, not the
 * place to author config. Sections that have a dedicated authoring
 * surface (`theme` → Appearance, `mcpMounts` → Tools, etc.) get
 * cross-link CTAs in their panels and `theme` is dropped from the
 * rail entirely — operators authoring a theme should be on
 * `/admin/theme`, not staring at a frozen JSON dump.
 *
 * Three honest source states the page must render distinctly:
 *
 *   1. found + valid    → header shows path + "loaded" pill,
 *      sections render with current values and defaults.
 *   2. found + invalid  → header shows path + "validation failed"
 *      pill + the parser's error message; raw JSON shown below for
 *      inspection. No section view (the manifest can't be trusted).
 *   3. not found        → header shows the searched-from path +
 *      "no manifest" pill + a hint about creating one. Schema
 *      sections still render so operators can browse what would
 *      be configurable.
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-config-source={'found-valid'|'found-invalid'|'missing'}`
 *     on the page root for tests to discriminate.
 *   - `data-ggui-config-section={name}` on each section in the rail
 *     and the corresponding panel.
 *   - `data-ggui-config-active-section={name}` on the rail for
 *     the currently-selected section.
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
 * Sections excluded from the rail — they have a dedicated authoring
 * surface elsewhere in the admin shell. `theme` lives on
 * `/admin/theme` (preset picker + DTCG override editor), so showing
 * a frozen JSON dump here adds no signal and tempts operators into
 * hand-editing the manifest field.
 */
const HIDDEN_SECTIONS = new Set<string>(['theme']);

interface CrossLink {
  readonly path: string;
  readonly label: string;
  readonly mute: string;
}

/**
 * Sections that have a dedicated authoring/inspection page surface
 * a CTA at the top of their panel. The mute string explains why the
 * Config dump is the wrong place for that work.
 */
const SECTION_CROSS_LINKS: Record<string, CrossLink> = {
  blueprints: {
    path: '/admin/blueprints',
    label: 'browse blueprints →',
    mute: 'The Blueprints page renders every entry with its primitives + props.',
  },
  primitives: {
    path: '/admin/blueprints',
    label: 'browse primitives →',
    mute: 'Primitives surface alongside blueprints on the Blueprints page.',
  },
  mcpMounts: {
    path: '/admin/tools',
    label: 'open Tools →',
    mute: 'The Tools page lists every mounted MCP tool with its handler + schema.',
  },
  storage: {
    path: '/admin/status',
    label: 'open Status →',
    mute: 'The Status dashboard shows render + vector-store backends as live wiring.',
  },
  agent: {
    path: '/admin/status',
    label: 'open Status →',
    mute: 'The Status dashboard shows agent + generation wiring.',
  },
};

interface FieldSchema {
  readonly type?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly properties?: Record<string, FieldSchema>;
  readonly items?: unknown;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly required?: readonly string[];
}

interface RootSchema extends FieldSchema {
  readonly properties?: Record<string, FieldSchema>;
}

type ConfigResponse =
  | {
      readonly source: { readonly found: false; readonly searchedFrom: string };
      readonly schema: RootSchema;
    }
  | {
      readonly source: {
        readonly found: true;
        readonly path: string;
        readonly error?: { readonly message: string };
      };
      readonly manifest?: Record<string, unknown>;
      readonly raw?: string;
      readonly schema: RootSchema;
    };

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: ConfigResponse }
  | { readonly kind: 'error'; readonly message: string };

export function Config(): ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/ggui/console/config', {
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
        const body = (await res.json()) as ConfigResponse;
        setState({ kind: 'ready', data: body });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: String(err) });
      }
    })();
    return () => controller.abort();
  }, []);

  if (state.kind === 'loading') {
    return (
      <section className="ggui-section">
        <SectionHead
          num="01 / config"
          title="ggui.json viewer."
          mute="Probing project root."
        />
        <StatusCard title="loading" num="CFG / 01" tone="draft">
          Loading config…
        </StatusCard>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section className="ggui-section">
        <SectionHead
          num="01 / config"
          title="ggui.json viewer."
          mute="Endpoint unreachable."
        />
        <StatusCard title="error" num="ERR / 01" tone="signal">
          Couldn&apos;t load config — {state.message}.
        </StatusCard>
      </section>
    );
  }
  return <ConfigBody data={state.data} />;
}

function ConfigBody({ data }: { readonly data: ConfigResponse }): ReactElement {
  const sectionNames = useMemo(
    () =>
      Object.keys(data.schema.properties ?? {}).filter(
        (name) => !HIDDEN_SECTIONS.has(name),
      ),
    [data.schema],
  );
  const [active, setActive] = useState<string>(
    sectionNames[0] ?? '',
  );

  const sourceKind: 'found-valid' | 'found-invalid' | 'missing' =
    data.source.found
      ? data.source.error
        ? 'found-invalid'
        : 'found-valid'
      : 'missing';

  return (
    <section className="ggui-section" data-ggui-config-source={sourceKind}>
      <SectionHead
        num="01 / admin / config"
        title="ggui.json — read-only manifest view."
        mute={renderSourceMute(data)}
        intro={
          <>
            Debug view of every top-level field your{' '}
            <code className="ggui-code">ggui.json</code> can carry.
            Descriptions come from the Zod schema; the value column
            shows what your manifest currently sets (or the schema default
            when omitted). To <strong>author</strong> theme, paired keys,
            OAuth providers, etc., use the dedicated pages in the admin
            sub-nav — this page is just for inspection.
          </>
        }
      />

      <SourceCard data={data} />

      {sourceKind === 'found-invalid' ? null : (
        <div className="ggui-config-stack">
          <SectionTabs
            sections={sectionNames}
            active={active}
            onSelect={setActive}
          />
          <SectionPanel data={data} active={active} />
        </div>
      )}

      {data.source.found && 'raw' in data && data.raw ? (
        <RawJsonCard raw={data.raw} />
      ) : null}
    </section>
  );
}

function renderSourceMute(data: ConfigResponse): ReactNode {
  if (!data.source.found) return 'No ggui.json reachable.';
  if (data.source.error) return 'Validation failed.';
  return 'Loaded from disk.';
}

function SourceCard({
  data,
}: {
  readonly data: ConfigResponse;
}): ReactElement {
  if (!data.source.found) {
    return (
      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">no manifest</span>
          <span className="ggui-card__num">SRC / 01</span>
        </div>
        <div className="ggui-card__body">
          <p className="ggui-body">
            <StatusBadge tone="ink">missing</StatusBadge>
          </p>
          <p className="ggui-muted">
            No <code className="ggui-code">ggui.json</code> walked up from{' '}
            <code className="ggui-code">{data.source.searchedFrom}</code>. The
            schema below shows what would be configurable; create a{' '}
            <code className="ggui-code">ggui.json</code> at the project root and
            reload.
          </p>
        </div>
      </div>
    );
  }
  if (data.source.error) {
    return (
      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">validation failed</span>
          <span className="ggui-card__num">SRC / 01</span>
        </div>
        <div className="ggui-card__body">
          <p className="ggui-body">
            <StatusBadge tone="signal">invalid</StatusBadge>
          </p>
          <p className="ggui-muted">
            <code className="ggui-code">{data.source.path}</code>
          </p>
          <pre className="ggui-config-error">{data.source.error.message}</pre>
        </div>
      </div>
    );
  }
  return (
    <div className="ggui-card">
      <div className="ggui-card__head">
        <span className="ggui-card__title">source</span>
        <span className="ggui-card__num">SRC / 01</span>
      </div>
      <div className="ggui-card__body">
        <p className="ggui-body">
          <StatusBadge tone="live">loaded</StatusBadge>
        </p>
        <p className="ggui-muted">
          <code className="ggui-code">{data.source.path}</code>
        </p>
      </div>
    </div>
  );
}

function SectionTabs({
  sections,
  active,
  onSelect,
}: {
  readonly sections: readonly string[];
  readonly active: string;
  readonly onSelect: (name: string) => void;
}): ReactElement {
  return (
    <nav
      aria-label="config sections"
      data-ggui-config-active-section={active}
    >
      <ul className="ggui-config-tabs" role="tablist">
        {sections.map((name) => (
          <li key={name} data-ggui-config-section={name} role="presentation">
            <button
              type="button"
              role="tab"
              onClick={() => onSelect(name)}
              aria-selected={name === active ? 'true' : 'false'}
              aria-current={name === active ? 'true' : undefined}
              className={`ggui-config-tabs__btn${name === active ? ' is-active' : ''}`}
            >
              {name}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SectionPanel({
  data,
  active,
}: {
  readonly data: ConfigResponse;
  readonly active: string;
}): ReactElement {
  const fieldSchema = data.schema.properties?.[active];
  const currentValue =
    data.source.found && 'manifest' in data && data.manifest
      ? data.manifest[active]
      : undefined;
  const isRequired = data.schema.required?.includes(active) ?? false;
  if (!fieldSchema) {
    return (
      <div className="ggui-config-panel">
        <p className="ggui-muted">No schema for &quot;{active}&quot;.</p>
      </div>
    );
  }
  const crossLink = SECTION_CROSS_LINKS[active];
  return (
    <div className="ggui-config-panel" data-ggui-config-section={active}>
      <div className="ggui-config-panel__head">
        <span className="ggui-config-panel__name">
          <code className="ggui-code">{active}</code>
        </span>
        {isRequired ? (
          <StatusBadge tone="signal">required</StatusBadge>
        ) : (
          <StatusBadge tone="ink">optional</StatusBadge>
        )}
        <span className="ggui-config-panel__type">
          {summarizeType(fieldSchema)}
        </span>
      </div>
      {crossLink ? <CrossLinkRow link={crossLink} /> : null}
      {fieldSchema.description ? (
        <p className="ggui-body" style={{ margin: '12px 0' }}>
          {fieldSchema.description}
        </p>
      ) : (
        <p className="ggui-muted">
          No description on the schema — file a bug if this is a known field.
        </p>
      )}
      <ValueRow
        label="current"
        value={currentValue}
        absentNote="not set in your manifest — schema default applies"
      />
      {fieldSchema.default !== undefined ? (
        <ValueRow label="default" value={fieldSchema.default} />
      ) : (
        <ValueRow
          label="default"
          value={undefined}
          absentNote="no default — must be set explicitly when used"
        />
      )}
      {fieldSchema.enum ? (
        <ValueRow label="allowed" value={fieldSchema.enum} />
      ) : null}
      <div style={{ marginTop: 16 }}>
        <div
          className="ggui-stack__entry-meta"
          style={{ marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.12em' }}
        >
          schema
        </div>
        <pre className="ggui-config-schema">
          {JSON.stringify(fieldSchema, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function summarizeType(schema: FieldSchema): string {
  if (schema.const !== undefined) return `literal "${String(schema.const)}"`;
  if (schema.enum) return `enum (${schema.enum.length})`;
  if (schema.type === 'array') return 'array';
  if (schema.type === 'object') return 'object';
  if (typeof schema.type === 'string') return schema.type;
  return 'unknown';
}

function CrossLinkRow({ link }: { readonly link: CrossLink }): ReactElement {
  return (
    <div
      data-ggui-config-cross-link={link.path}
      style={{
        marginTop: 8,
        padding: '10px 12px',
        background: 'var(--ggui-paper-2)',
        border: '1px solid var(--ggui-line-1)',
        borderRadius: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <button
        type="button"
        className="ggui-btn ggui-btn--ghost"
        onClick={() => navigateTo(link.path)}
        style={{ fontSize: 12 }}
      >
        {link.label}
      </button>
      <span className="ggui-muted" style={{ fontSize: 12, flex: 1 }}>
        {link.mute}
      </span>
    </div>
  );
}

function ValueRow({
  label,
  value,
  absentNote,
}: {
  readonly label: string;
  readonly value: unknown;
  readonly absentNote?: string;
}): ReactElement {
  return (
    <div className="ggui-config-value-row">
      <div
        className="ggui-stack__entry-meta"
        style={{ marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.12em' }}
      >
        {label}
      </div>
      {value === undefined ? (
        <p className="ggui-muted" style={{ margin: 0 }}>
          {absentNote ?? '—'}
        </p>
      ) : (
        <pre className="ggui-config-value">{JSON.stringify(value, null, 2)}</pre>
      )}
    </div>
  );
}

function RawJsonCard({ raw }: { readonly raw: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="ggui-card" style={{ marginTop: 24 }}>
      <div className="ggui-card__head">
        <span className="ggui-card__title">raw ggui.json</span>
        <span className="ggui-card__num">RAW / 01</span>
      </div>
      <div className="ggui-card__body">
        <button
          type="button"
          className="ggui-btn ggui-btn--ghost"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? 'hide' : 'show'} raw bytes
        </button>
        {open ? (
          <pre className="ggui-config-raw" data-ggui-config-raw>
            {raw}
          </pre>
        ) : null}
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
  readonly tone: 'draft' | 'signal' | 'ink' | 'live';
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
