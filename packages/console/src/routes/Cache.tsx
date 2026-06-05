/**
 * `/devtools/cache` — live blueprint-cache decision inspector.
 *
 * Subscribes to two server endpoints:
 *   - `GET /ggui/console/cache/recent?limit=100` (REST) — initial
 *     replay buffer on page mount.
 *   - `GET /ggui/console/cache/stream` (SSE) — live append.
 *
 * Both routes are admin-gated server-side. The page uses no auth-token
 * client-side; the cookie + admin-HTML gate handle it.
 *
 * GguiSession shape: reverse-chronological list of cards. Each card shows:
 *   - timestamp + scope
 *   - outcome pill (MATCH / MISS / SYNTH / legacy HIT)
 *   - strategy chip when present (exact-key / semantic)
 *   - top-1 candidate score + duration
 *   - intent (truncated to one line)
 *   - expandable detail panel with full intent / expected key /
 *     threshold / candidate list (each with score + cached intent) /
 *     winning blueprint id (if match) / human-readable reason
 *
 * No virtualization — bounded buffer (200) keeps the list short
 * enough for naive React.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { SectionHead } from "../brand/SectionHead.js";

// Mirror of CacheTraceDecision in
// packages/mcp-server-handlers/src/renders/cache-trace-sink.ts.
// The union spans two emitter paths:
//   - Matcher — `match-*` / `no-match*` / synth.
//   - Legacy generation-cache fallback — `hit` / `miss-*`. Will be
//     removed once cache-backed-negotiator.ts is deleted.
// Kept in sync by hand because the console is a closed package and
// the type lives in handlers — a deferred protocol concern (cache
// trace stream isn't yet contract-bar; if it becomes one, lift the
// type into a shared package).
type CacheTraceDecision =
  | "match-exact"
  | "match-semantic"
  | "match-skip-low-cosine"
  | "match-skip-no-llm"
  | "no-match"
  | "no-match-low-confidence"
  | "no-match-judge-defense"
  | "no-match-empty-intent"
  | "synth-ok"
  | "synth-fail"
  | "push-classify"
  | "hit"
  | "miss-empty-intent"
  | "miss-empty-scope"
  | "miss-below-threshold"
  | "miss-key-mismatch"
  | "miss-empty-code";

type CacheTraceStrategy = "exact-key" | "semantic";

/** Filter buckets surfaced as a chip row above the event list. */
type StrategyFilter = "all" | CacheTraceStrategy | "no-strategy";

/** Classification of agent's render-time `contract` against the
 *  handshake's `plan.contract` canonical key. */
type AgentClassification = "confirm" | "override";

/** Filter buckets for the agent-classification chip row. */
type ClassificationFilter = "all" | AgentClassification;

interface CacheTraceCandidate {
  readonly key: string;
  readonly score: number;
  readonly cachedIntent?: string;
}

interface CacheTraceValidatorFinding {
  readonly kind: string;
  readonly severity: "warn" | "error";
  readonly hint: string;
}

interface CacheTraceEvent {
  readonly id: string;
  readonly at: number;
  readonly durationMs: number;
  readonly scope: string;
  readonly intent: string;
  readonly expectedKey: string;
  readonly threshold: number;
  readonly decision: CacheTraceDecision;
  readonly strategy?: CacheTraceStrategy;
  readonly candidates: ReadonlyArray<CacheTraceCandidate>;
  readonly winningBlueprintId?: string;
  readonly validatorFindings?: ReadonlyArray<CacheTraceValidatorFinding>;
  readonly cosineNoveltyDistance?: number;
  readonly agentClassification?: AgentClassification;
  readonly reason: string;
}

/**
 * Outcome class used by the pill renderer + winningBlueprintId chip.
 * Collapses every decision code into one of five buckets so the row
 * stays glanceable; the full `decision` text appears in the detail
 * panel for operators who want it.
 */
type Outcome = "match" | "miss" | "synth-ok" | "synth-fail" | "classify";

function classify(decision: CacheTraceDecision): Outcome {
  if (decision === "synth-ok") return "synth-ok";
  if (decision === "synth-fail") return "synth-fail";
  if (decision === "push-classify") return "classify";
  // Matcher hits + legacy generation-cache hit collapse to "match".
  if (decision === "match-exact" || decision === "match-semantic") return "match";
  if (decision === "hit") return "match";
  // Everything else (match-skip-*, no-match*, miss-*) is a miss.
  return "miss";
}

export function Cache(): ReactElement {
  const [events, setEvents] = useState<readonly CacheTraceEvent[]>([]);
  const [status, setStatus] = useState<"loading" | "live" | "reconnecting" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<StrategyFilter>("all");
  const [classificationFilter, setClassificationFilter] = useState<ClassificationFilter>("all");
  const seenIds = useRef<Set<string>>(new Set());

  // Initial fetch + SSE subscription. The SSE stream only delivers
  // future events; we backfill via /recent so the page isn't empty
  // when an operator opens it after generation has already happened.
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    const append = (event: CacheTraceEvent): void => {
      if (seenIds.current.has(event.id)) return;
      seenIds.current.add(event.id);
      // Newest first — devtools pattern (most recent at top).
      setEvents((prev) => [event, ...prev].slice(0, 500));
    };

    const init = async (): Promise<void> => {
      try {
        const res = await fetch("/ggui/console/cache/recent?limit=100", {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!res.ok) {
          throw new Error(`recent fetch returned ${res.status}`);
        }
        const body = (await res.json()) as { events: CacheTraceEvent[] };
        if (cancelled) return;
        // The recent endpoint returns oldest-first; reverse for the UI.
        const initial = [...body.events].reverse();
        for (const event of initial) seenIds.current.add(event.id);
        setEvents(initial);
        setStatus("live");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Could not load recent cache trace.");
        return;
      }

      // Open SSE stream.
      source = new EventSource("/ggui/console/cache/stream", {
        withCredentials: true,
      });
      source.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as CacheTraceEvent;
          append(event);
        } catch {
          // Ignore — SSE message we couldn't parse (heartbeat / proxy chatter).
        }
      };
      source.onerror = () => {
        // Browser auto-reconnects; surface that state in the pill.
        setStatus("reconnecting");
      };
      source.onopen = () => {
        setStatus("live");
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

  const counts = countByStrategy(events);
  const classificationCounts = countByClassification(events);
  const afterStrategy =
    filter === "all"
      ? events
      : filter === "no-strategy"
        ? events.filter((e) => e.strategy === undefined)
        : events.filter((e) => e.strategy === filter);
  const visible =
    classificationFilter === "all"
      ? afterStrategy
      : afterStrategy.filter((e) => e.agentClassification === classificationFilter);

  return (
    <section className="ggui-section">
      <SectionHead
        num="DEVTOOLS / 7C"
        title="Cache decisions."
        mute="Live."
        intro={
          <>
            Every blueprint-cache lookup the matcher runs — query intent, threshold, top-k candidate
            similarity scores, and the outcome (MATCH on canonical-key equality or judge accept;
            MISS on no-match buckets; SYNTH for cold-path contract synthesis; PUSH for paired-push
            confirm-vs-override classification). Quality-overlay chips surface validator findings on
            synth output, cosine novelty distance from the registry, and the agent's
            confirm-vs-override rate against the handshake's provisional. Filter by strategy or
            agent disposition to slice the stream. Bounded ring buffer — most recent 200 events stay
            in memory.
          </>
        }
      />

      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">events</span>
          <span className="ggui-card__num">
            {status === "loading"
              ? "connecting…"
              : status === "live"
                ? `live · ${events.length}`
                : status === "reconnecting"
                  ? "reconnecting…"
                  : "error"}
          </span>
        </div>
        <div className="ggui-card__body">
          {errorMessage ? (
            <p className="ggui-muted" data-ggui-cache-trace-error>
              {errorMessage}
            </p>
          ) : null}
          <StrategyFilterRow filter={filter} onFilter={setFilter} counts={counts} />
          <ClassificationFilterRow
            filter={classificationFilter}
            onFilter={setClassificationFilter}
            counts={classificationCounts}
          />
          {events.length === 0 && status !== "error" ? (
            <p className="ggui-muted">
              No cache lookups yet. Trigger a generation (push a prompt through your MCP client) and
              decisions will appear here as they fire.
            </p>
          ) : null}
          {events.length > 0 && visible.length === 0 ? (
            <p className="ggui-muted">No events for this strategy. Try a different filter.</p>
          ) : null}
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 12,
            }}
            data-ggui-cache-trace-list
          >
            {visible.map((event) => (
              <CacheCard
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

interface StrategyCounts {
  readonly all: number;
  readonly "exact-key": number;
  readonly semantic: number;
  readonly "no-strategy": number;
}

function countByStrategy(events: readonly CacheTraceEvent[]): StrategyCounts {
  let exactKey = 0;
  let semantic = 0;
  let noStrategy = 0;
  for (const e of events) {
    if (e.strategy === "exact-key") exactKey += 1;
    else if (e.strategy === "semantic") semantic += 1;
    else noStrategy += 1;
  }
  return {
    all: events.length,
    "exact-key": exactKey,
    semantic,
    "no-strategy": noStrategy,
  };
}

interface ClassificationCounts {
  readonly all: number;
  readonly confirm: number;
  readonly override: number;
}

function countByClassification(events: readonly CacheTraceEvent[]): ClassificationCounts {
  let confirm = 0;
  let override = 0;
  for (const e of events) {
    if (e.agentClassification === "confirm") confirm += 1;
    else if (e.agentClassification === "override") override += 1;
  }
  // The "all" bucket reflects the same superset the strategy chip row
  // does so the two chip rows compose without disagreeing on totals.
  return { all: events.length, confirm, override };
}

function StrategyFilterRow({
  filter,
  onFilter,
  counts,
}: {
  readonly filter: StrategyFilter;
  readonly onFilter: (next: StrategyFilter) => void;
  readonly counts: StrategyCounts;
}): ReactElement {
  const items: ReadonlyArray<{
    readonly key: StrategyFilter;
    readonly label: string;
  }> = [
    { key: "all", label: "all" },
    { key: "exact-key", label: "exact-key" },
    { key: "semantic", label: "semantic" },
    { key: "no-strategy", label: "no-strategy" },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        marginBottom: 12,
        flexWrap: "wrap",
      }}
      data-ggui-cache-trace-filter
    >
      <span
        className="ggui-muted"
        style={{
          fontSize: 11,
          fontFamily: "var(--ggui-font-mono)",
          textTransform: "uppercase",
          marginRight: 4,
        }}
      >
        strategy
      </span>
      {items.map((item) => {
        const isActive = filter === item.key;
        const count = counts[item.key];
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onFilter(item.key)}
            style={{
              all: "unset",
              cursor: "pointer",
              fontFamily: "var(--ggui-font-mono)",
              fontSize: 11,
              padding: "2px 8px",
              border: "1px solid var(--ggui-rule)",
              background: isActive ? "var(--ggui-ink)" : "transparent",
              color: isActive ? "var(--ggui-paper)" : "var(--ggui-ink)",
              letterSpacing: "0.05em",
            }}
            data-ggui-cache-trace-filter-key={item.key}
            data-ggui-cache-trace-filter-active={isActive ? "true" : "false"}
          >
            {item.label} · {count}
          </button>
        );
      })}
    </div>
  );
}

function ClassificationFilterRow({
  filter,
  onFilter,
  counts,
}: {
  readonly filter: ClassificationFilter;
  readonly onFilter: (next: ClassificationFilter) => void;
  readonly counts: ClassificationCounts;
}): ReactElement {
  const items: ReadonlyArray<{
    readonly key: ClassificationFilter;
    readonly label: string;
  }> = [
    { key: "all", label: "all" },
    { key: "confirm", label: "confirm" },
    { key: "override", label: "override" },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        alignItems: "center",
        marginBottom: 12,
        flexWrap: "wrap",
      }}
      data-ggui-cache-trace-classification-filter
    >
      <span
        className="ggui-muted"
        style={{
          fontSize: 11,
          fontFamily: "var(--ggui-font-mono)",
          textTransform: "uppercase",
          marginRight: 4,
        }}
      >
        agent
      </span>
      {items.map((item) => {
        const isActive = filter === item.key;
        const count = counts[item.key];
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onFilter(item.key)}
            style={{
              all: "unset",
              cursor: "pointer",
              fontFamily: "var(--ggui-font-mono)",
              fontSize: 11,
              padding: "2px 8px",
              border: "1px solid var(--ggui-rule)",
              background: isActive ? "var(--ggui-ink)" : "transparent",
              color: isActive ? "var(--ggui-paper)" : "var(--ggui-ink)",
              letterSpacing: "0.05em",
            }}
            data-ggui-cache-trace-classification-key={item.key}
            data-ggui-cache-trace-classification-active={isActive ? "true" : "false"}
          >
            {item.label} · {count}
          </button>
        );
      })}
    </div>
  );
}

function CacheCard({
  event,
  expanded,
  onToggle,
}: {
  readonly event: CacheTraceEvent;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  const at = new Date(event.at);
  const time = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const outcome = classify(event.decision);
  const showWinner = outcome === "match" && event.winningBlueprintId;
  const top = event.candidates[0];
  const topScore = top ? top.score.toFixed(3) : "—";
  // Single-line intent preview for the collapsed row. Cap visually so
  // a long intent doesn't push the score/decision off the right edge.
  const intentPreview = event.intent.length > 80 ? `${event.intent.slice(0, 80)}…` : event.intent;

  return (
    <li
      style={{
        border: "1px solid var(--ggui-rule)",
        padding: "10px 12px",
        background: "var(--ggui-paper)",
      }}
      data-ggui-cache-trace-event={event.id}
      data-ggui-cache-trace-decision={event.decision}
      {...(event.strategy ? { "data-ggui-cache-trace-strategy": event.strategy } : {})}
      {...(event.agentClassification
        ? {
            "data-ggui-cache-trace-classification": event.agentClassification,
          }
        : {})}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          gap: 12,
          alignItems: "baseline",
          width: "100%",
        }}
      >
        <span className="ggui-muted" style={{ fontSize: 11, fontFamily: "var(--ggui-font-mono)" }}>
          {time}
        </span>
        <DecisionPill outcome={outcome} />
        {event.strategy ? <StrategyChip strategy={event.strategy} /> : null}
        {event.agentClassification ? (
          <ClassificationChip classification={event.agentClassification} />
        ) : null}
        {event.validatorFindings && event.validatorFindings.length > 0 ? (
          <ValidatorFindingsBadge
            count={event.validatorFindings.length}
            severity={
              event.validatorFindings.some((f) => f.severity === "error") ? "error" : "warn"
            }
          />
        ) : null}
        <span
          style={{
            fontFamily: "var(--ggui-font-mono)",
            fontSize: 12,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {intentPreview || <span className="ggui-muted">(empty intent)</span>}
        </span>
        <span className="ggui-muted" style={{ fontSize: 11, fontFamily: "var(--ggui-font-mono)" }}>
          top {topScore}
        </span>
        <span className="ggui-muted" style={{ fontSize: 11 }}>
          {event.durationMs}ms
        </span>
        {showWinner ? (
          <span
            style={{
              fontFamily: "var(--ggui-font-mono)",
              fontSize: 11,
              padding: "0 6px",
              border: "1px solid var(--ggui-rule)",
            }}
          >
            {event.winningBlueprintId}
          </span>
        ) : null}
      </button>
      {expanded ? <CacheDetail event={event} /> : null}
    </li>
  );
}

function DecisionPill({ outcome }: { readonly outcome: Outcome }): ReactElement {
  // Avoids color reliance — the brand kit's restricted palette has no
  // red/green tokens, and adding them just for this surface would
  // invite design drift. Filled = a positive event (match landed,
  // synth produced a contract, agent confirmed the suggestion). Outline
  // = a miss / failure / divergence.
  const filled = outcome === "match" || outcome === "synth-ok";
  const label =
    outcome === "match"
      ? "MATCH"
      : outcome === "synth-ok"
        ? "SYNTH"
        : outcome === "synth-fail"
          ? "SYNTH"
          : outcome === "classify"
            ? "PUSH"
            : "MISS";
  return (
    <span
      style={{
        fontFamily: "var(--ggui-font-mono)",
        fontSize: 11,
        padding: "0 8px",
        border: "1px solid var(--ggui-rule)",
        background: filled ? "var(--ggui-ink)" : "transparent",
        color: filled ? "var(--ggui-paper)" : "var(--ggui-ink)",
        letterSpacing: "0.05em",
      }}
      data-ggui-cache-trace-outcome={outcome}
    >
      {label}
    </span>
  );
}

function StrategyChip({ strategy }: { readonly strategy: CacheTraceStrategy }): ReactElement {
  return (
    <span
      style={{
        fontFamily: "var(--ggui-font-mono)",
        fontSize: 10,
        padding: "0 6px",
        border: "1px dashed var(--ggui-rule)",
        background: "transparent",
        color: "var(--ggui-ink)",
        letterSpacing: "0.05em",
        textTransform: "lowercase",
      }}
    >
      {strategy}
    </span>
  );
}

function ClassificationChip({
  classification,
}: {
  readonly classification: AgentClassification;
}): ReactElement {
  // Filled `confirm` mirrors the DecisionPill's "positive event" axis
  // — agent echoed the negotiator's suggestion. Outlined `override`
  // signals divergence; both are valid and the chip stays neutral on
  // judgment, but the visual weight tracks reuse-rate skim-readability.
  const filled = classification === "confirm";
  return (
    <span
      style={{
        fontFamily: "var(--ggui-font-mono)",
        fontSize: 10,
        padding: "0 6px",
        border: "1px solid var(--ggui-rule)",
        background: filled ? "var(--ggui-ink)" : "transparent",
        color: filled ? "var(--ggui-paper)" : "var(--ggui-ink)",
        letterSpacing: "0.05em",
      }}
      data-ggui-cache-trace-classification-chip={classification}
    >
      {classification}
    </span>
  );
}

function ValidatorFindingsBadge({
  count,
  severity,
}: {
  readonly count: number;
  readonly severity: "warn" | "error";
}): ReactElement {
  return (
    <span
      title={
        severity === "error"
          ? "Validator emitted at least one error finding — synth dropped the contract."
          : "Validator emitted warning findings — contract was returned but flagged."
      }
      style={{
        fontFamily: "var(--ggui-font-mono)",
        fontSize: 10,
        padding: "0 6px",
        border: severity === "error" ? "1px solid var(--ggui-ink)" : "1px dashed var(--ggui-rule)",
        background: "transparent",
        color: "var(--ggui-ink)",
        letterSpacing: "0.05em",
      }}
      data-ggui-cache-trace-validator-severity={severity}
    >
      {severity === "error" ? "err" : "warn"} · {count}
    </span>
  );
}

function CacheDetail({ event }: { readonly event: CacheTraceEvent }): ReactElement {
  return (
    <div
      style={{
        marginTop: 10,
        paddingTop: 10,
        borderTop: "1px solid var(--ggui-rule)",
        display: "grid",
        gap: 12,
      }}
    >
      <Section label="reason">
        <p style={{ margin: 0, fontSize: 13 }}>{event.reason}</p>
      </Section>
      <Section label="decision class">
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "baseline",
            fontFamily: "var(--ggui-font-mono)",
            fontSize: 12,
          }}
        >
          <span>{event.decision}</span>
          {event.strategy ? (
            <span className="ggui-muted">· strategy = {event.strategy}</span>
          ) : null}
          {event.agentClassification ? (
            <span className="ggui-muted">· classification = {event.agentClassification}</span>
          ) : null}
        </div>
      </Section>
      {event.agentClassification ? (
        <Section label="agent classification">
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "baseline",
              fontFamily: "var(--ggui-font-mono)",
              fontSize: 12,
            }}
          >
            <ClassificationChip classification={event.agentClassification} />
            <span className="ggui-muted">
              {event.agentClassification === "confirm"
                ? "agent render contract canonicalizes to the handshake plan key"
                : "agent render contract diverges from the handshake plan key"}
            </span>
          </div>
        </Section>
      ) : null}
      {event.cosineNoveltyDistance !== undefined ? (
        <Section label="cosine novelty distance">
          <div
            style={{ fontFamily: "var(--ggui-font-mono)", fontSize: 12 }}
            title="1 - top.cosine. Higher = farther from any registered blueprint. Track over time to spot synth fragmentation."
          >
            {event.cosineNoveltyDistance.toFixed(3)}
          </div>
        </Section>
      ) : null}
      {event.validatorFindings && event.validatorFindings.length > 0 ? (
        <Section label={`validator findings (${event.validatorFindings.length})`}>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {event.validatorFindings.map((f, i) => (
              <li
                key={`${f.kind}-${i}`}
                style={{
                  padding: "4px 0",
                  borderBottom:
                    i < (event.validatorFindings?.length ?? 0) - 1
                      ? "1px solid var(--ggui-rule)"
                      : "none",
                  display: "grid",
                  gap: 2,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "baseline",
                  }}
                >
                  <ValidatorFindingsBadge count={1} severity={f.severity} />
                  <span
                    style={{
                      fontFamily: "var(--ggui-font-mono)",
                      fontSize: 12,
                    }}
                  >
                    {f.kind}
                  </span>
                </div>
                <div style={{ fontSize: 12 }}>{f.hint}</div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section label="intent">
        <pre style={preStyle}>{event.intent || "(empty)"}</pre>
      </Section>
      <Section label="scope / threshold">
        <div style={{ fontFamily: "var(--ggui-font-mono)", fontSize: 12 }}>
          <div>
            scope = <strong>{event.scope}</strong>
          </div>
          <div>
            threshold = <strong>{event.threshold}</strong>
          </div>
          <div>
            expectedKey = <strong>{event.expectedKey || "(none)"}</strong>
          </div>
          {event.winningBlueprintId ? (
            <div>
              winningBlueprintId = <strong>{event.winningBlueprintId}</strong>
            </div>
          ) : null}
        </div>
      </Section>
      <Section label={`candidates (${event.candidates.length})`}>
        {event.candidates.length === 0 ? (
          <p className="ggui-muted" style={{ margin: 0, fontSize: 12 }}>
            No candidates returned by the vector store.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {event.candidates.map((c, i) => {
              const isWinner =
                event.winningBlueprintId !== undefined && c.key === event.winningBlueprintId;
              return (
                <li
                  key={`${c.key}-${i}`}
                  style={{
                    padding: "4px 0",
                    borderBottom:
                      i < event.candidates.length - 1 ? "1px solid var(--ggui-rule)" : "none",
                    display: "grid",
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "baseline",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--ggui-font-mono)",
                        fontSize: 12,
                        fontWeight: isWinner ? 600 : 400,
                      }}
                    >
                      {c.key}
                    </span>
                    {isWinner ? (
                      <span className="ggui-muted" style={{ fontSize: 10 }}>
                        (winner)
                      </span>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <span
                      style={{
                        fontFamily: "var(--ggui-font-mono)",
                        fontSize: 12,
                      }}
                    >
                      {c.score.toFixed(3)}
                    </span>
                  </div>
                  {c.cachedIntent ? (
                    <div
                      className="ggui-muted"
                      style={{
                        fontSize: 11,
                        fontFamily: "var(--ggui-font-mono)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {c.cachedIntent}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
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
          fontFamily: "var(--ggui-font-mono)",
          textTransform: "uppercase",
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
  background: "var(--ggui-paper-2, #efeee8)",
  border: "1px solid var(--ggui-rule)",
  fontFamily: "var(--ggui-font-mono)",
  fontSize: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 360,
  overflow: "auto",
};
