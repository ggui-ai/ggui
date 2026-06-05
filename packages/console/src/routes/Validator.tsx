/**
 * `/devtools/validator` — live validator-tier results inspector.
 *
 * Subscribes to two server endpoints:
 *   - `GET /ggui/console/validator/recent?limit=100` (REST) — initial
 *     replay buffer on page mount.
 *   - `GET /ggui/console/validator/stream` (SSE) — live append.
 *
 * Both routes are admin-gated server-side. The page uses no auth-token
 * client-side; the cookie + admin-HTML gate handle it.
 *
 * GguiSession shape: reverse-chronological list of cards. Each card shows:
 *   - timestamp + harness id (truncated) + workflow id
 *   - per-tier issue chips (axis / tier-0 / runtime-render / LLM)
 *   - duration + total issue count + outcome pill (pass / has-fails / has-warns)
 *   - expandable detail panel grouped by tier, each issue showing
 *     category, severity, description, fix, line.
 *
 * No virtualization yet — bounded buffer (200) keeps the list short
 * enough for naive React. A scroll surface contains the cards.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { SectionHead } from '../brand/SectionHead.js';

type EvalTier = 0 | 1 | 2;
type EvalOutcome = 'fail' | 'warn' | 'pass';
type Priority = 'P0' | 'P1' | 'P2';

interface EvalIssue {
  readonly tier: EvalTier;
  readonly result: EvalOutcome;
  readonly category: string;
  readonly priority?: Priority;
  readonly subcategory?: string;
  readonly severity?: 'critical' | 'major';
  readonly description: string;
  readonly fix: string;
  readonly line?: number;
}

interface ValidatorTraceEvent {
  readonly id: string;
  readonly at: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly harnessId: string;
  readonly classification: Record<string, string>;
  readonly workflowId: string;
  readonly hadCompiledCode: boolean;
  readonly skippedRuntimeRender: boolean;
  readonly summary: {
    readonly totalIssues: number;
    readonly axisIssues: number;
    readonly tierIssues: number;
    readonly llmIssues: number;
    readonly runtimeRenderIssues: number;
    readonly firedCheckIds: readonly string[];
  };
  readonly issues: readonly EvalIssue[];
  readonly sourceCode?: string;
  readonly prompt?: string;
  readonly error?: { readonly message: string };
}

export function Validator(): ReactElement {
  const [events, setEvents] = useState<readonly ValidatorTraceEvent[]>([]);
  const [status, setStatus] = useState<
    'loading' | 'live' | 'reconnecting' | 'error'
  >('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seenIds = useRef<Set<string>>(new Set());

  // Initial fetch + SSE subscription. Same pattern as LlmTrace —
  // /recent backfills any events that fired before the operator opened
  // the page; /stream delivers future events live.
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    const append = (event: ValidatorTraceEvent): void => {
      if (seenIds.current.has(event.id)) return;
      seenIds.current.add(event.id);
      setEvents((prev) => [event, ...prev].slice(0, 500));
    };

    const init = async (): Promise<void> => {
      try {
        const res = await fetch('/ggui/console/validator/recent?limit=100', {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`recent fetch returned ${res.status}`);
        }
        const body = (await res.json()) as { events: ValidatorTraceEvent[] };
        if (cancelled) return;
        const initial = [...body.events].reverse();
        for (const event of initial) seenIds.current.add(event.id);
        setEvents(initial);
        setStatus('live');
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Could not load recent validator trace.',
        );
        return;
      }

      source = new EventSource('/ggui/console/validator/stream', {
        withCredentials: true,
      });
      source.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as ValidatorTraceEvent;
          append(event);
        } catch {
          // Ignore — SSE message we couldn't parse (heartbeat / proxy chatter).
        }
      };
      source.onerror = () => {
        setStatus('reconnecting');
      };
      source.onopen = () => {
        setStatus('live');
      };
    };

    void init();

    return () => {
      cancelled = true;
      if (source) source.close();
    };
  }, []);

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <section className="ggui-section">
      <SectionHead
        num="DEVTOOLS / 7B"
        title="Validator tier results."
        mute="Live."
        intro={
          <>
            Every <code className="ggui-code">runCheck()</code> the
            harness performs during generation — which axis-checks fired,
            which tier-0 deterministic checks failed, what the runtime-
            render probe surfaced, what the LLM evaluator flagged.
            Bounded ring buffer — most recent 200 events stay in memory.
          </>
        }
      />

      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">events</span>
          <span className="ggui-card__num">
            {status === 'loading'
              ? 'connecting…'
              : status === 'live'
                ? `live · ${events.length}`
                : status === 'reconnecting'
                  ? 'reconnecting…'
                  : 'error'}
          </span>
        </div>
        <div className="ggui-card__body">
          {errorMessage ? (
            <p className="ggui-muted" data-ggui-validator-error>
              {errorMessage}
            </p>
          ) : null}
          {events.length === 0 && status !== 'error' ? (
            <p className="ggui-muted">
              No validator runs yet. Trigger a generation (push a prompt
              through your MCP client) and tier results will appear here
              as they fire.
            </p>
          ) : null}
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 12,
            }}
            data-ggui-validator-list
          >
            {events.map((event) => (
              <ValidatorCard
                key={event.id}
                event={event}
                expanded={expanded.has(event.id)}
                onToggle={() => toggle(event.id)}
              />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ValidatorCard({
  event,
  expanded,
  onToggle,
}: {
  readonly event: ValidatorTraceEvent;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  const at = new Date(event.at);
  const time = at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const fails = event.issues.filter((i) => i.result === 'fail').length;
  const warns = event.issues.filter((i) => i.result === 'warn').length;
  const outcome: 'pass' | 'warn' | 'fail' =
    fails > 0 ? 'fail' : warns > 0 ? 'warn' : 'pass';
  const harnessShort =
    event.harnessId.length > 12
      ? event.harnessId.slice(0, 12) + '…'
      : event.harnessId;

  return (
    <li
      style={{
        border: '1px solid var(--ggui-rule)',
        padding: '10px 12px',
        background: 'var(--ggui-paper)',
      }}
      data-ggui-validator-event={event.id}
      data-ggui-validator-outcome={outcome}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          gap: 12,
          alignItems: 'baseline',
          width: '100%',
          flexWrap: 'wrap',
        }}
      >
        <span
          className="ggui-muted"
          style={{ fontSize: 11, fontFamily: 'var(--ggui-font-mono)' }}
        >
          {time}
        </span>
        <span
          style={{ fontFamily: 'var(--ggui-font-mono)', fontSize: 12 }}
          title={event.harnessId}
        >
          {harnessShort}
        </span>
        <span
          className="ggui-muted"
          style={{ fontSize: 11, fontFamily: 'var(--ggui-font-mono)' }}
        >
          {event.workflowId}
        </span>
        <TierChip label="axis" count={event.summary.axisIssues} />
        <TierChip label="tier-0" count={event.summary.tierIssues} />
        <TierChip
          label="probe"
          count={event.summary.runtimeRenderIssues}
          dimmed={event.skippedRuntimeRender}
        />
        <TierChip label="llm" count={event.summary.llmIssues} />
        <span style={{ flex: 1 }} />
        <span className="ggui-muted" style={{ fontSize: 11 }}>
          {event.durationMs}ms
        </span>
        <OutcomePill outcome={outcome} fails={fails} warns={warns} />
      </button>
      {expanded ? <ValidatorDetail event={event} /> : null}
    </li>
  );
}

function TierChip({
  label,
  count,
  dimmed,
}: {
  readonly label: string;
  readonly count: number;
  readonly dimmed?: boolean;
}): ReactElement {
  const hasIssues = count > 0;
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: 'var(--ggui-font-mono)',
        padding: '0 6px',
        border: '1px solid var(--ggui-rule)',
        opacity: dimmed ? 0.4 : hasIssues ? 1 : 0.7,
      }}
    >
      {label} {count}
    </span>
  );
}

function OutcomePill({
  outcome,
  fails,
  warns,
}: {
  readonly outcome: 'pass' | 'warn' | 'fail';
  readonly fails: number;
  readonly warns: number;
}): ReactElement {
  const text =
    outcome === 'pass'
      ? 'pass'
      : outcome === 'warn'
        ? `${warns} warn`
        : `${fails} fail`;
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: 'var(--ggui-font-mono)',
        padding: '0 6px',
        border: '1px solid var(--ggui-rule)',
      }}
      data-ggui-validator-pill={outcome}
    >
      {text}
    </span>
  );
}

function ValidatorDetail({
  event,
}: {
  readonly event: ValidatorTraceEvent;
}): ReactElement {
  // Group issues by tier label for the per-tier breakdown the slice
  // promised. firedCheckIds + the per-tier counts on `summary` already
  // describe what ran; here we render WHAT each tier reported.
  const byTier = groupIssuesByTier(event.issues);

  return (
    <div
      style={{
        marginTop: 10,
        paddingTop: 10,
        borderTop: '1px solid var(--ggui-rule)',
        display: 'grid',
        gap: 12,
      }}
    >
      {event.error ? (
        <Section label="error">
          <pre style={preStyle}>{event.error.message}</pre>
        </Section>
      ) : null}
      <Section label="harness">
        <div
          style={{ fontFamily: 'var(--ggui-font-mono)', fontSize: 12 }}
        >
          <div>id: {event.harnessId}</div>
          <div>workflow: {event.workflowId}</div>
          <div>
            compiled: {event.hadCompiledCode ? 'yes' : 'no — checks skipped'}
          </div>
          <div>
            runtime-render: {event.skippedRuntimeRender ? 'skipped' : 'ran'}
          </div>
        </div>
      </Section>
      <Section label="classification">
        <div
          style={{ fontFamily: 'var(--ggui-font-mono)', fontSize: 12 }}
        >
          {Object.entries(event.classification).map(([axis, value]) => (
            <div key={axis}>
              {axis}: {String(value)}
            </div>
          ))}
        </div>
      </Section>
      {event.summary.firedCheckIds.length > 0 ? (
        <Section
          label={`fired check ids (${event.summary.firedCheckIds.length})`}
        >
          <pre style={preStyle}>
            {event.summary.firedCheckIds.join('\n')}
          </pre>
        </Section>
      ) : null}
      {byTier.axis.length > 0 ? (
        <Section label={`axis issues (${byTier.axis.length})`}>
          <IssueList issues={byTier.axis} />
        </Section>
      ) : null}
      {byTier.tier0.length > 0 ? (
        <Section label={`tier-0 issues (${byTier.tier0.length})`}>
          <IssueList issues={byTier.tier0} />
        </Section>
      ) : null}
      {byTier.tier1.length > 0 ? (
        <Section label={`tier-1 issues (${byTier.tier1.length})`}>
          <IssueList issues={byTier.tier1} />
        </Section>
      ) : null}
      {byTier.tier2.length > 0 ? (
        <Section label={`tier-2 issues (${byTier.tier2.length})`}>
          <IssueList issues={byTier.tier2} />
        </Section>
      ) : null}
      {event.prompt ? (
        <Section label="prompt">
          <pre style={preStyle}>{event.prompt}</pre>
        </Section>
      ) : null}
      {event.sourceCode ? (
        <Section label="source under check">
          <pre style={preStyle}>{event.sourceCode}</pre>
        </Section>
      ) : null}
    </div>
  );
}

interface TierGroups {
  readonly axis: readonly EvalIssue[];
  readonly tier0: readonly EvalIssue[];
  readonly tier1: readonly EvalIssue[];
  readonly tier2: readonly EvalIssue[];
}

/**
 * Heuristic split: axis-checks emit issues with `subcategory` starting
 * with the axis name (e.g. `axis.state.merge`). Tier 0/1/2 use the
 * EvalIssue's `tier` field. We surface "axis" separately because the
 * operator's first triage question is "did MY axis-check fire?" — the
 * tier is implicit context, axis-vs-not is the real signal.
 */
function groupIssuesByTier(issues: readonly EvalIssue[]): TierGroups {
  const axis: EvalIssue[] = [];
  const tier0: EvalIssue[] = [];
  const tier1: EvalIssue[] = [];
  const tier2: EvalIssue[] = [];
  for (const issue of issues) {
    const isAxis =
      typeof issue.subcategory === 'string' &&
      issue.subcategory.startsWith('axis.');
    if (isAxis) {
      axis.push(issue);
      continue;
    }
    if (issue.tier === 0) tier0.push(issue);
    else if (issue.tier === 1) tier1.push(issue);
    else tier2.push(issue);
  }
  return { axis, tier0, tier1, tier2 };
}

function IssueList({
  issues,
}: {
  readonly issues: readonly EvalIssue[];
}): ReactElement {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
      {issues.map((issue, idx) => (
        <li
          key={idx}
          style={{
            border: '1px solid var(--ggui-rule)',
            padding: '6px 8px',
            background: 'var(--ggui-paper-2, #efeee8)',
          }}
          data-ggui-validator-issue={issue.category}
          data-ggui-validator-issue-result={issue.result}
        >
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'baseline',
              flexWrap: 'wrap',
              fontSize: 11,
              fontFamily: 'var(--ggui-font-mono)',
            }}
          >
            <span
              style={{
                padding: '0 4px',
                border: '1px solid var(--ggui-rule)',
              }}
            >
              {issue.result}
            </span>
            <span style={{ fontWeight: 500 }}>{issue.category}</span>
            {issue.subcategory ? (
              <span className="ggui-muted">{issue.subcategory}</span>
            ) : null}
            {issue.priority ? (
              <span className="ggui-muted">{issue.priority}</span>
            ) : null}
            {issue.severity ? (
              <span className="ggui-muted">{issue.severity}</span>
            ) : null}
            {typeof issue.line === 'number' ? (
              <span className="ggui-muted">line {issue.line}</span>
            ) : null}
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>{issue.description}</div>
          {issue.fix ? (
            <div
              className="ggui-muted"
              style={{ fontSize: 12, marginTop: 2 }}
            >
              fix: {issue.fix}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement | string;
}): ReactElement {
  return (
    <div>
      <div
        className="ggui-muted"
        style={{
          fontSize: 11,
          fontFamily: 'var(--ggui-font-mono)',
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 8,
  background: 'var(--ggui-paper-2, #efeee8)',
  border: '1px solid var(--ggui-rule)',
  fontFamily: 'var(--ggui-font-mono)',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 360,
  overflow: 'auto',
};
