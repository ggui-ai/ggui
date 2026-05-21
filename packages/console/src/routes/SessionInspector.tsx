/**
 * `SessionInspector` — contract + activity + test-action panels for
 * a single stack entry on `/s/<shortCode>`.
 *
 * Three collapsible sub-panels render under each rendered stack
 * entry — the painted UI keeps the visual lead, operators opt in to
 * the inspector when they need it.
 *
 * Read inputs:
 *
 *   - `entry`: the stack item — surfaces its `actionSpec`,
 *     `streamSpec`, `agentTools` catalog, and `clientCapabilities`
 *     declarations in the contract panel and the action dropdown in
 *     the test-action form.
 *   - `entryIndex`: stack position; used in the entry header copy +
 *     the test-fire `<select>` `id` so multi-entry stacks don't
 *     collide.
 *   - `activity`: shared session-wide ring buffer of dispatch / stream
 *     events. Held in-memory, FIFO-evicted at 200 entries — a bounded
 *     buffer keeps paint cost bounded on chatty MCPs.
 *   - `onFireAction`: the same `SessionApi.action` the rendered UI
 *     calls — operator-typed JSON flows through the same wire so
 *     server-side validation behaves identically.
 *
 * No write to the cache, no mutation of the stack — pure observation
 * + manual fire.
 */
import {
  useCallback,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { StackItem } from '@ggui-ai/protocol';
import { StatusBadge } from '../brand/StatusBadge.js';

/**
 * Maximum number of activity events retained per session. FIFO
 * eviction at this cap keeps the inspector's render cost bounded
 * even on chatty MCPs (see plan §6.4).
 */
export const MAX_ACTIVITY_EVENTS = 200;

/**
 * Discriminated union over the live wire signal we surface in the
 * activity log. Each event carries its own arrival timestamp + a
 * locally-unique id so React keys are stable under FIFO eviction.
 *
 * C12 extension: `'observe'` carries an opaque `ObservabilityEvent`
 * (declared in `@ggui-ai/iframe-runtime`) for each of the four emission
 * kinds — `wired-tool-invoked` / `contract-error-emitted` /
 * `schema-version-mismatch` / `subscribe-failed`. The console does
 * NOT import the type; it pattern-matches on the nested `kind`
 * string through {@link ObservabilityEventShape} so the package
 * stays free of an `@ggui-ai/iframe-runtime` dependency. C9.5 wires the
 * real `onObserve` prop on `<McpAppIframe>` into `pushActivity` on
 * the `SessionViewer`.
 */
export type ActivityEvent =
  | {
      readonly kind: 'dispatch';
      readonly id: string;
      readonly at: number;
      readonly stackIndex: number;
      readonly data: unknown;
    }
  | {
      readonly kind: 'response';
      readonly id: string;
      readonly at: number;
      readonly data: unknown;
      readonly response: unknown;
    }
  | {
      readonly kind: 'stream';
      readonly id: string;
      readonly at: number;
      readonly payload: unknown;
    }
  | {
      readonly kind: 'observe';
      readonly id: string;
      readonly at: number;
      /**
       * Opaque {@link ObservabilityEvent} from `@ggui-ai/iframe-runtime`.
       * Console pattern-matches on `.event.kind` for tab filtering
       * (see {@link observabilityCategoryOf}) but does NOT narrow
       * further — the emission shape is the renderer's protocol-
       * adjacent contract, not console's.
       */
      readonly event: ObservabilityEventShape;
    };

/**
 * Minimum structural view of `@ggui-ai/iframe-runtime`'s `ObservabilityEvent`
 * that the console consumes. Declared here so console does not take a
 * dependency on `@ggui-ai/iframe-runtime` — an important boundary because
 * the renderer ships react + design + wire + protocol inline and this
 * package would balloon.
 *
 * The shape is a discriminated union with extensible string kinds;
 * every emission declared in `observability.ts` carries at minimum a
 * `kind` string. Unknown fields flow through as `unknown` — console
 * only reads `event.kind` and serializes the whole value for display.
 *
 * Note on the index signature: `ObservabilityEventShape` is NOT a
 * plain structural supertype of every concrete `ObservabilityEvent`
 * arm in `@ggui-ai/iframe-runtime` — the narrow arms (e.g.
 * `WiredToolInvokedEvent`) lack the `[field: string]: unknown` tail,
 * so TS treats them as non-assignable. Consumers routing a
 * `<McpAppIframe onObserve>` handler's `ObservabilityEvent` into a
 * `ObservabilityEventShape` sink go through
 * {@link toObservabilityEventShape} which converts at the boundary
 * (runtime: shallow copy — observability events are opaque JSON
 * objects by contract).
 */
export interface ObservabilityEventShape {
  readonly kind: string;
  readonly [field: string]: unknown;
}

/**
 * Compile-time bridge from `@ggui-ai/iframe-runtime`'s narrow
 * `ObservabilityEvent` union into console's open-index
 * {@link ObservabilityEventShape}. Runtime is a shallow copy.
 *
 * Why copy instead of alias: an observability event the renderer
 * hands us IS a JSON-serializable plain object, so a fresh record
 * with the same fields is equivalent for every console use-case
 * (ring-buffer display, JSON-stringify). Copying lets TS see the
 * result as `ObservabilityEventShape` via object-spread widening —
 * no `as` cast, no index-signature gymnastics.
 *
 * Parameter type is `{kind: string}` — the common supertype of
 * every concrete `ObservabilityEvent` arm AND of
 * `ObservabilityEventShape` itself — so this helper accepts
 * renderer-emitted events, shape-typed replays, and tests that
 * hand-roll plain `{kind: '...'}` literals.
 */
export function toObservabilityEventShape(
  event: { readonly kind: string },
): ObservabilityEventShape {
  // Narrow-to-open: fan the narrow event out into an open index
  // bag keyed by string. `Object.entries` + `Object.fromEntries`
  // roundtrip gives us `Record<string, unknown>` as the spread
  // base, which plus the explicit `kind` satisfies
  // `ObservabilityEventShape`.
  const bag: Record<string, unknown> = Object.fromEntries(
    Object.entries(event),
  );
  return { ...bag, kind: event.kind };
}


/**
 * Bucketed tabs above the activity panel. `All` is always populated;
 * the other four filter on `ActivityEvent` kind + (for observability
 * rows) the nested `event.kind`.
 *
 * Order is load-bearing — the activity panel renders tabs in this
 * order so operators build muscle memory across sessions. Changing
 * the order is a UX decision, not a refactor.
 */
export type ActivityTab =
  | 'All'
  | 'Actions'
  | 'Errors'
  | 'Version'
  | 'Subscribe';

/** Tab order + copy. Drives the tab strip render. */
export const ACTIVITY_TABS: readonly ActivityTab[] = [
  'All',
  'Actions',
  'Errors',
  'Version',
  'Subscribe',
] as const;

/**
 * Classify an observability event's `kind` into one of the filter
 * buckets. Unknown kinds fall through to `undefined` — those rows
 * surface only under the `All` tab so forward-compat emission (a
 * renderer shipping a new event kind before the console knows it)
 * stays observable instead of silently hidden.
 */
function observabilityCategoryOf(
  eventKind: string,
): 'Actions' | 'Errors' | 'Version' | 'Subscribe' | undefined {
  if (eventKind === 'wired-tool-invoked') return 'Actions';
  if (eventKind === 'contract-error-emitted') return 'Errors';
  if (eventKind === 'schema-version-mismatch') return 'Version';
  if (eventKind === 'subscribe-failed') return 'Subscribe';
  return undefined;
}

/**
 * True when `event` belongs in the given tab's view. `All` always
 * passes. The other tabs slot activity by this rule:
 *
 *   - `Actions` — `dispatch`/`response` rows (user-fired actions) +
 *     `observe[wired-tool-invoked]`.
 *   - `Errors` — `observe[contract-error-emitted]` (more kinds can
 *     land here as the emission surface grows).
 *   - `Version` — `observe[schema-version-mismatch]`.
 *   - `Subscribe` — `observe[subscribe-failed]` + stream rows
 *     (stream traffic is the other primary signal an operator uses
 *     to diagnose a flaky subscribe).
 */
export function activityEventMatchesTab(
  event: ActivityEvent,
  tab: ActivityTab,
): boolean {
  if (tab === 'All') return true;
  if (event.kind === 'observe') {
    const category = observabilityCategoryOf(event.event.kind);
    return category === tab;
  }
  if (tab === 'Actions') {
    return event.kind === 'dispatch' || event.kind === 'response';
  }
  if (tab === 'Subscribe') {
    return event.kind === 'stream';
  }
  return false;
}

export interface SessionInspectorProps {
  readonly entry: StackItem;
  readonly entryIndex: number;
  readonly activity: readonly ActivityEvent[];
  readonly onFireAction: (data: unknown) => void;
}

export function SessionInspector({
  entry,
  entryIndex,
  activity,
  onFireAction,
}: SessionInspectorProps): ReactElement {
  return (
    <div
      data-ggui-inspect
      data-ggui-inspect-entry-index={entryIndex}
      style={{
        marginTop: 16,
        borderTop: '1px solid var(--ggui-border, #e5e5e5)',
        paddingTop: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <ContractPanel entry={entry} />
      <ActivityPanel activity={activity} />
      <TestActionPanel
        entry={entry}
        entryIndex={entryIndex}
        onFireAction={onFireAction}
      />
    </div>
  );
}

// ── Contract ──────────────────────────────────────────────────────

function ContractPanel({ entry }: { readonly entry: StackItem }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeContract(entry);
  return (
    <Disclosure
      label="contract"
      tag="CTR"
      sub={summary.sub}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      data-ggui-inspect-contract
    >
      {summary.empty ? (
        <p className="ggui-muted" style={{ margin: 0 }}>
          No contract declared on this stack entry. The generated UI
          fires no actions and consumes no streams. (If this looks
          wrong, the generation may have skipped the contract block.)
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gap: 12,
          }}
        >
          {entry.actionSpec ? (
            <ContractSection
              num="ACT"
              label="actionSpec"
              kind="actions"
              entries={Object.entries(entry.actionSpec).map(
                ([name, a]) => {
                  // Every action is agent-routed. The optional
                  // `nextStep` field names the tool the agent SHOULD
                  // invoke on its next turn; surfaced as a hint in the
                  // contract panel.
                  const dispatchHint = a.nextStep
                    ? `→ agent: ${a.nextStep}`
                    : '→ agent';
                  return {
                    name,
                    detail: a.description ?? a.label ?? dispatchHint,
                  };
                },
              )}
            />
          ) : null}
          {entry.streamSpec ? (
            <ContractSection
              num="STR"
              label="streamSpec"
              kind="channels"
              entries={Object.entries(entry.streamSpec).map(
                ([name, c]) => ({
                  name,
                  detail: `${c.mode ?? 'append'}${c.replay ? ` · replay ${c.replay}` : ''}`,
                }),
              )}
            />
          ) : null}
          {entry.propsSpec ? (
            <ContractSection
              num="PRP"
              label="propsSpec"
              kind="props"
              entries={Object.entries(entry.propsSpec.properties ?? {}).map(
                ([name, p]) => ({
                  name,
                  detail: p.description ?? '—',
                }),
              )}
            />
          ) : null}
        </div>
      )}
    </Disclosure>
  );
}

interface ContractEntryRow {
  readonly name: string;
  readonly detail: string;
}

function ContractSection({
  num,
  label,
  kind,
  entries,
}: {
  readonly num: string;
  readonly label: string;
  readonly kind: string;
  readonly entries: readonly ContractEntryRow[];
}): ReactElement {
  return (
    <div
      data-ggui-inspect-contract-section={label}
      className="ggui-card"
    >
      <div className="ggui-card__head">
        <span className="ggui-card__title">{label}</span>
        <span className="ggui-card__num">
          {num} · {entries.length} {kind}
        </span>
      </div>
      <div className="ggui-card__body" style={{ padding: '8px 12px' }}>
        {entries.length === 0 ? (
          <p className="ggui-muted" style={{ margin: 0 }}>
            No {kind} declared.
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 6,
            }}
          >
            {entries.map((e) => (
              <li
                key={e.name}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'baseline',
                }}
              >
                <code className="ggui-code">{e.name}</code>
                <span className="ggui-muted" style={{ fontSize: '0.85em' }}>
                  {e.detail}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface ContractSummary {
  readonly empty: boolean;
  readonly sub: string;
}

function summarizeContract(entry: StackItem): ContractSummary {
  const parts: string[] = [];
  const actionCount = Object.keys(entry.actionSpec ?? {}).length;
  const channelCount = Object.keys(entry.streamSpec ?? {}).length;
  const propCount = Object.keys(entry.propsSpec?.properties ?? {}).length;
  if (actionCount > 0) {
    parts.push(`${actionCount} action${actionCount === 1 ? '' : 's'}`);
  }
  if (channelCount > 0) {
    parts.push(`${channelCount} channel${channelCount === 1 ? '' : 's'}`);
  }
  if (propCount > 0) {
    parts.push(`${propCount} prop${propCount === 1 ? '' : 's'}`);
  }
  return parts.length === 0
    ? { empty: true, sub: 'no contract' }
    : { empty: false, sub: parts.join(' · ') };
}

// ── Activity ──────────────────────────────────────────────────────

function ActivityPanel({
  activity,
}: {
  readonly activity: readonly ActivityEvent[];
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<ActivityTab>('All');
  const counts = useMemo(() => {
    let dispatch = 0;
    let response = 0;
    let stream = 0;
    let observe = 0;
    for (const e of activity) {
      if (e.kind === 'dispatch') dispatch++;
      else if (e.kind === 'response') response++;
      else if (e.kind === 'stream') stream++;
      else observe++;
    }
    return { dispatch, response, stream, observe };
  }, [activity]);
  // Per-tab counts for the tab-strip badges. Recomputed alongside
  // `counts` so both drain the same single traversal style.
  const perTabCounts = useMemo(() => {
    const out: Record<ActivityTab, number> = {
      All: activity.length,
      Actions: 0,
      Errors: 0,
      Version: 0,
      Subscribe: 0,
    };
    for (const e of activity) {
      for (const t of ACTIVITY_TABS) {
        if (t === 'All') continue;
        if (activityEventMatchesTab(e, t)) {
          out[t] += 1;
        }
      }
    }
    return out;
  }, [activity]);
  const filtered = useMemo(
    () =>
      tab === 'All'
        ? activity
        : activity.filter((e) => activityEventMatchesTab(e, tab)),
    [activity, tab],
  );
  const observeSegment = counts.observe > 0 ? ` ${counts.observe}⟵obs` : '';
  const sub = `${activity.length}/${MAX_ACTIVITY_EVENTS} · ${counts.dispatch}⟶ ${counts.response}⟵ack ${counts.stream}⟵str${observeSegment}`;
  return (
    <Disclosure
      label="activity"
      tag="ACT"
      sub={sub}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      data-ggui-inspect-activity
    >
      <div
        role="tablist"
        aria-label="activity filters"
        data-ggui-inspect-activity-tabs
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        {ACTIVITY_TABS.map((name) => {
          const selected = tab === name;
          const n = perTabCounts[name];
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={selected}
              data-ggui-inspect-activity-tab={name}
              data-ggui-inspect-activity-tab-selected={
                selected ? 'true' : 'false'
              }
              onClick={() => setTab(name)}
              style={{
                padding: '4px 10px',
                borderRadius: 3,
                border: '1px solid var(--ggui-border, #e5e5e5)',
                background: selected
                  ? 'var(--ggui-surface-ink, #111)'
                  : 'var(--ggui-surface-mute, #fff)',
                color: selected ? 'var(--ggui-surface-mute, #fff)' : 'inherit',
                cursor: 'pointer',
                font: 'inherit',
                fontSize: '0.85em',
              }}
            >
              {name}
              <span
                className="ggui-muted"
                style={{
                  marginLeft: 6,
                  fontSize: '0.85em',
                  color: selected
                    ? 'var(--ggui-surface-mute, #ddd)'
                    : undefined,
                }}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>
      {filtered.length === 0 ? (
        <p className="ggui-muted" style={{ margin: 0 }}>
          {tab === 'All'
            ? 'No activity yet. Dispatches from the rendered UI and stream chunks from the server will appear here in arrival order.'
            : `No ${tab.toLowerCase()} activity yet.`}
        </p>
      ) : (
        <ul
          data-ggui-inspect-activity-list
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
          {[...filtered].reverse().map((event) => (
            <ActivityRow key={event.id} event={event} />
          ))}
        </ul>
      )}
    </Disclosure>
  );
}

/**
 * Pick the arrow / tone / preview-source for an activity row. Extracted
 * from `ActivityRow` so C12's `observe` branch doesn't inflate the
 * render body. Each helper stays narrow — a single switch-case per
 * concern — and the union exhaustiveness keeps TS narrowing honest.
 */
function rowArrow(event: ActivityEvent): string {
  if (event.kind === 'dispatch') return '⟶';
  if (event.kind === 'response') return '⟵ack';
  if (event.kind === 'stream') return '⟵str';
  return '⟵obs';
}

function rowTone(
  event: ActivityEvent,
): 'ink' | 'draft' | 'signal' {
  if (event.kind === 'stream') return 'draft';
  if (event.kind === 'observe') {
    // Errors + version mismatches land in the `signal` tone so the
    // operator's eye catches them against the ink-dense row stream.
    if (event.event.kind === 'contract-error-emitted') return 'signal';
    if (event.event.kind === 'schema-version-mismatch') return 'signal';
    return 'draft';
  }
  return 'ink';
}

function rowPreviewSource(event: ActivityEvent): unknown {
  if (event.kind === 'response') return event.response;
  if (event.kind === 'dispatch') return event.data;
  if (event.kind === 'stream') return event.payload;
  return event.event;
}

function ActivityRow({ event }: { readonly event: ActivityEvent }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const arrow = rowArrow(event);
  const tone = rowTone(event);
  const previewSource = rowPreviewSource(event);
  return (
    <li
      data-ggui-inspect-event
      data-ggui-inspect-event-direction={event.kind}
      style={{
        padding: '4px 8px',
        borderRadius: 3,
        background: 'var(--ggui-surface-subtle, #f8f8f8)',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'baseline',
          background: 'transparent',
          border: 'none',
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          padding: 0,
          width: '100%',
          textAlign: 'left',
        }}
        aria-expanded={expanded}
      >
        <span
          className="ggui-muted"
          style={{ fontSize: '0.8em', minWidth: 80 }}
        >
          {formatTimeOnly(event.at)}
        </span>
        <StatusBadge tone={tone}>{arrow}</StatusBadge>
        <code
          className="ggui-code"
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {previewLabel(previewSource)}
        </code>
      </button>
      {expanded ? (
        <pre
          style={{
            margin: '6px 0 0',
            padding: 8,
            background: 'var(--ggui-surface-mute, #fff)',
            borderRadius: 3,
            overflow: 'auto',
            maxHeight: 160,
            fontSize: '0.8em',
          }}
        >
          {safeStringify(previewSource)}
        </pre>
      ) : null}
    </li>
  );
}

function formatTimeOnly(at: number): string {
  try {
    const d = new Date(at);
    return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
  } catch {
    return String(at);
  }
}

function previewLabel(value: unknown): string {
  const s = safeStringify(value);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ── Test action ───────────────────────────────────────────────────

function TestActionPanel({
  entry,
  entryIndex,
  onFireAction,
}: {
  readonly entry: StackItem;
  readonly entryIndex: number;
  readonly onFireAction: (data: unknown) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const actionNames = Object.keys(entry.actionSpec ?? {});
  const [selected, setSelected] = useState<string>(actionNames[0] ?? '');
  const [payloadText, setPayloadText] = useState('{}');
  const [parseError, setParseError] = useState<string | null>(null);
  const [lastFired, setLastFired] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadText);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : String(err));
        return;
      }
      setParseError(null);
      // Fire through the same dispatcher the rendered UI uses. The
      // wire shape includes the action name in the data payload by
      // convention — operators paste the full envelope here so we
      // don't synthesize a wrapper that might not match what the
      // rendered UI sends.
      onFireAction(parsed);
      setLastFired(selected || '(unnamed)');
    },
    [payloadText, onFireAction, selected],
  );

  const sub =
    actionNames.length === 0
      ? 'no actions to fire'
      : `${actionNames.length} action${actionNames.length === 1 ? '' : 's'}`;

  return (
    <Disclosure
      label="test action"
      tag="TST"
      sub={sub}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      data-ggui-inspect-test
    >
      {actionNames.length === 0 ? (
        <p className="ggui-muted" style={{ margin: 0 }}>
          The generated UI declared no actions. Test-fire is disabled
          for this entry.
        </p>
      ) : (
        <form
          data-ggui-inspect-test-form
          onSubmit={handleSubmit}
          className="ggui-form"
          style={{ display: 'grid', gap: 8 }}
        >
          <label
            className="ggui-label"
            htmlFor={`ggui-inspect-action-${entryIndex}`}
          >
            action
          </label>
          <div className="ggui-field">
            <select
              id={`ggui-inspect-action-${entryIndex}`}
              data-ggui-inspect-test-action-select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {actionNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <label
            className="ggui-label"
            htmlFor={`ggui-inspect-payload-${entryIndex}`}
          >
            payload (JSON)
          </label>
          <div className="ggui-field">
            <textarea
              id={`ggui-inspect-payload-${entryIndex}`}
              data-ggui-inspect-test-payload
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
              data-ggui-inspect-test-parse-error
            >
              <StatusBadge tone="signal">parse error</StatusBadge>{' '}
              {parseError}
            </p>
          ) : null}
          {lastFired && !parseError ? (
            <p
              className="ggui-muted"
              style={{ margin: 0 }}
              data-ggui-inspect-test-last-fired={lastFired}
            >
              fired <code className="ggui-code">{lastFired}</code> · response
              will appear in the activity panel.
            </p>
          ) : null}
          <div>
            <button
              type="submit"
              data-ggui-inspect-test-submit
              className="ggui-btn"
            >
              fire →
            </button>
          </div>
        </form>
      )}
    </Disclosure>
  );
}

// ── Disclosure shell ──────────────────────────────────────────────

function Disclosure({
  label,
  tag,
  sub,
  expanded,
  onToggle,
  children,
  ...rest
}: {
  readonly label: string;
  readonly tag: string;
  readonly sub: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
  readonly [extra: `data-${string}`]: string | true;
}): ReactElement {
  return (
    <div className="ggui-card" {...rest}>
      <button
        type="button"
        onClick={onToggle}
        className="ggui-card__head"
        aria-expanded={expanded}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <span className="ggui-card__title">
          {expanded ? '▾' : '▸'} {label}
        </span>
        <span className="ggui-card__num">
          {tag} · {sub}
        </span>
      </button>
      {expanded ? (
        <div className="ggui-card__body" style={{ padding: '12px 16px' }}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
