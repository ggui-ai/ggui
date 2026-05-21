/**
 * MCP tool inspector — mounted at `/tools` (NOT `/mcp` — that path
 * is the MCP JSON-RPC transport endpoint and would shadow the SPA
 * route). Page is still framed as the "MCP tool inspector" in copy
 * + the nav label reads 'mcp' for operator readability.
 *
 * Operator-facing "what tools does my server expose?" — same
 * inventory the MCP `tools/list` JSON-RPC method surfaces, rendered
 * as expandable cards instead of curl output.
 *
 * Scope (list-only):
 *
 *   - Read-only inventory from `GET /ggui/console/mcp/tools`. Each
 *     row shows name + optional title + description; clicking the
 *     card expands inline JSON Schema for input + output.
 *   - Filter input substring-matches name + description.
 *   - Test invoke is DEFERRED — see plan §4.B.1. Calling a tool
 *     from the console needs a same-origin bearer claim story
 *     (console session cookie currently authenticates only the
 *     live-channel WS upgrade), and that security surface is its own
 *     slice.
 *
 * Layout follows the same `ggui-stack` entry-card grammar the
 * Blueprints + Sessions pages use, so all the index pages read as
 * one surface.
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-mcp-list` on the column container.
 *   - `data-ggui-mcp-tool-name={name}` on every row.
 *   - `data-ggui-mcp-tool-expanded={'true'|'false'}` on every row
 *     (so browser specs can assert click → expansion).
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

interface ToolInfo {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
}

interface ToolsResponse {
  readonly tools: readonly ToolInfo[];
  readonly total: number;
}

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: ToolsResponse }
  | { readonly kind: 'error'; readonly message: string };

export function McpInspector(): ReactElement {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/ggui/console/mcp/tools', {
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
        const body = (await res.json()) as ToolsResponse;
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
    if (needle.length === 0) return state.data.tools;
    return state.data.tools.filter((t) =>
      [t.name, t.title ?? '', t.description]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [state, needle]);

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / mcp"
        title="Registered MCP tools."
        mute="Read-only inventory."
        intro={
          <>
            Every tool this server registered with the MCP runtime —
            same set <code className="ggui-code">tools/list</code>{' '}
            returns over JSON-RPC, rendered as expandable cards.
            Click a row to see its input + output JSON Schema.{' '}
            <span className="ggui-muted">
              Test-invoke from the browser is deferred — for now, exercise
              tools via your paired MCP client.
            </span>
          </>
        }
      />

      {state.kind === 'loading' ? (
        <StatusCard title="loading" num="MCP / 01" tone="draft">
          Loading tool inventory…
        </StatusCard>
      ) : state.kind === 'error' ? (
        <StatusCard title="error" num="ERR / 01" tone="signal">
          Couldn&apos;t load tools — {state.message}.
        </StatusCard>
      ) : (
        <>
          <div className="ggui-form" style={{ marginBottom: 20 }}>
            <label className="ggui-label" htmlFor="ggui-mcp-filter">
              filter
            </label>
            <div className="ggui-field">
              <input
                id="ggui-mcp-filter"
                name="filter"
                aria-label="filter tools"
                placeholder="substring match over name, title, description…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          </div>
          <ToolList
            all={state.data.tools}
            shown={filtered ?? state.data.tools}
            filterActive={needle.length > 0}
          />
        </>
      )}
    </section>
  );
}

function ToolList({
  all,
  shown,
  filterActive,
}: {
  readonly all: readonly ToolInfo[];
  readonly shown: readonly ToolInfo[];
  readonly filterActive: boolean;
}): ReactElement {
  if (all.length === 0) {
    return (
      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">empty</span>
          <span className="ggui-card__num">MCP / 00</span>
        </div>
        <div className="ggui-card__body">
          <p className="ggui-body">No tools registered.</p>
          <p className="ggui-muted">
            This server booted without any handlers — unusual for a
            full <code className="ggui-code">ggui serve</code>.
            Check the boot config.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div data-ggui-mcp-list className="ggui-stack" aria-label="mcp tools">
      <div className="ggui-stack__head">
        <span className="ggui-stack__num">MCP</span>
        <span className="ggui-stack__label">registered tools</span>
        <span className="ggui-stack__count">
          {shown.length}
          {filterActive && shown.length !== all.length ? ` / ${all.length}` : ''}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          No tools match the filter.
        </p>
      ) : (
        <ul className="ggui-stack__list">
          {shown.map((tool, index) => (
            <ToolRow key={tool.name} tool={tool} index={index + 1} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolRow({
  tool,
  index,
}: {
  readonly tool: ToolInfo;
  readonly index: number;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <li
      data-ggui-mcp-tool-name={tool.name}
      data-ggui-mcp-tool-expanded={expanded ? 'true' : 'false'}
      className="ggui-stack__entry"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        style={{
          background: 'transparent',
          border: 0,
          padding: 0,
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          color: 'inherit',
          font: 'inherit',
        }}
      >
        <div className="ggui-stack__entry-head">
          <span className="ggui-stack__entry-num">
            {`MCP / ${String(index).padStart(2, '0')}`}
          </span>
          <span className="ggui-stack__entry-title">
            <code className="ggui-code">{tool.name}</code>
          </span>
          {tool.title ? (
            <StatusBadge tone="ink">{tool.title}</StatusBadge>
          ) : null}
          <span
            className="ggui-muted"
            style={{ marginLeft: 'auto', fontFamily: 'var(--ggui-mono)', fontSize: 11 }}
          >
            {expanded ? '−' : '+'}
          </span>
        </div>
        {tool.description ? (
          <p className="ggui-body" style={{ margin: '8px 0 0' }}>
            {tool.description}
          </p>
        ) : null}
      </button>
      {expanded ? (
        <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
          <SchemaBlock label="input" schema={tool.inputSchema} />
          <SchemaBlock label="output" schema={tool.outputSchema} />
        </div>
      ) : null}
    </li>
  );
}

function SchemaBlock({
  label,
  schema,
}: {
  readonly label: string;
  readonly schema: unknown;
}): ReactElement {
  return (
    <div>
      <div
        className="ggui-stack__entry-meta"
        style={{ marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.12em' }}
      >
        {label}
      </div>
      <pre
        data-ggui-mcp-schema={label}
        style={{
          margin: 0,
          padding: 12,
          background: 'var(--ggui-paper-2)',
          border: '1px solid var(--ggui-line-2)',
          borderRadius: 2,
          fontFamily: 'var(--ggui-mono)',
          fontSize: 11,
          lineHeight: 1.5,
          overflow: 'auto',
          maxHeight: 320,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {JSON.stringify(schema, null, 2)}
      </pre>
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
