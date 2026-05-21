/**
 * `/devtools/llm-trace` — live LLM call inspector.
 *
 * Subscribes to two server endpoints:
 *   - `GET /ggui/console/llm-trace/recent?limit=100` (REST) — initial
 *     replay buffer on page mount.
 *   - `GET /ggui/console/llm-trace/stream` (SSE) — live append.
 *
 * Both routes are admin-gated server-side. The page uses no auth-token
 * client-side; the cookie + admin-HTML gate handle it.
 *
 * Render shape: reverse-chronological list of cards. Each card shows:
 *   - timestamp + provider/model
 *   - kind chip (callText / callTools / callWithTools)
 *   - duration + token counts (in / out / cache-read / cache-write)
 *   - expandable detail panel with system prompt / user prompt /
 *     tool defs / response text or tool calls / error
 *
 * No virtualization yet — bounded buffer (200) keeps the list short
 * enough for naive React. A scroll surface contains the cards;
 * autoscroll-to-top on new event when the user is at the top.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { SectionHead } from '../brand/SectionHead.js';

interface LlmTraceEvent {
  readonly id: string;
  readonly at: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly provider: 'anthropic' | 'openai' | 'google' | 'openrouter';
  readonly model: string;
  readonly kind: 'callText' | 'callTools' | 'callWithTools' | 'callStructured';
  readonly systemPrompt?: string;
  readonly userPrompt?: string;
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
  }>;
  readonly result?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreated?: number;
    readonly cacheRead?: number;
    readonly text?: string;
    readonly toolCalls?: ReadonlyArray<{
      readonly name: string;
      readonly input: unknown;
    }>;
    readonly turnsUsed?: number;
  };
  readonly error?: { readonly message: string };
}

export function LlmTrace(): ReactElement {
  const [events, setEvents] = useState<readonly LlmTraceEvent[]>([]);
  const [status, setStatus] = useState<
    'loading' | 'live' | 'reconnecting' | 'error'
  >('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seenIds = useRef<Set<string>>(new Set());

  // Initial fetch + SSE subscription. The SSE stream only delivers
  // future events; we backfill via /recent so the page isn't empty
  // when an operator opens it after generation has already happened.
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    const append = (event: LlmTraceEvent): void => {
      if (seenIds.current.has(event.id)) return;
      seenIds.current.add(event.id);
      // Newest first — devtools pattern (most recent at top).
      setEvents((prev) => [event, ...prev].slice(0, 500));
    };

    const init = async (): Promise<void> => {
      try {
        const res = await fetch('/ggui/console/llm-trace/recent?limit=100', {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`recent fetch returned ${res.status}`);
        }
        const body = (await res.json()) as { events: LlmTraceEvent[] };
        if (cancelled) return;
        // The recent endpoint returns oldest-first; reverse for the UI.
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
            : 'Could not load recent LLM trace.',
        );
        return;
      }

      // Open SSE stream.
      source = new EventSource('/ggui/console/llm-trace/stream', {
        withCredentials: true,
      });
      source.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as LlmTraceEvent;
          append(event);
        } catch {
          // Ignore — SSE message we couldn't parse (heartbeat / proxy chatter).
        }
      };
      source.onerror = () => {
        // Browser auto-reconnects; surface that state in the pill.
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
        num="DEVTOOLS / 7A"
        title="LLM trace."
        mute="Live."
        intro={
          <>
            Every LLM call the harness makes during generation —
            system prompt, user prompt, tool defs, completion, token
            counts. Anthropic only for now; OpenAI / Google / OpenRouter
            slot in later. Bounded ring buffer — most recent 200 events
            stay in memory.
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
            <p className="ggui-muted" data-ggui-llm-trace-error>
              {errorMessage}
            </p>
          ) : null}
          {events.length === 0 && status !== 'error' ? (
            <p className="ggui-muted">
              No LLM calls yet. Trigger a generation (push a prompt
              through your MCP client) and they'll appear here as they
              fire.
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
            data-ggui-llm-trace-list
          >
            {events.map((event) => (
              <TraceCard
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

function TraceCard({
  event,
  expanded,
  onToggle,
}: {
  readonly event: LlmTraceEvent;
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
  const tokens = event.result
    ? `${event.result.inputTokens} in · ${event.result.outputTokens} out` +
      (event.result.cacheRead
        ? ` · ${event.result.cacheRead} cache hit`
        : '') +
      (event.result.cacheCreated
        ? ` · ${event.result.cacheCreated} cache write`
        : '')
    : '—';
  const status = event.error ? 'error' : 'ok';

  return (
    <li
      style={{
        border: '1px solid var(--ggui-rule)',
        padding: '10px 12px',
        background: 'var(--ggui-paper)',
      }}
      data-ggui-llm-trace-event={event.id}
      data-ggui-llm-trace-status={status}
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
        }}
      >
        <span
          className="ggui-muted"
          style={{ fontSize: 11, fontFamily: 'var(--ggui-font-mono)' }}
        >
          {time}
        </span>
        <span style={{ fontFamily: 'var(--ggui-font-mono)', fontSize: 12 }}>
          {event.provider}/{event.model}
        </span>
        <span
          className="ggui-muted"
          style={{ fontSize: 11, fontFamily: 'var(--ggui-font-mono)' }}
        >
          {event.kind}
        </span>
        <span style={{ flex: 1 }} />
        <span className="ggui-muted" style={{ fontSize: 11 }}>
          {event.durationMs}ms
        </span>
        <span className="ggui-muted" style={{ fontSize: 11 }}>
          {tokens}
        </span>
        {event.error ? (
          <span
            style={{
              fontSize: 11,
              padding: '0 6px',
              border: '1px solid var(--ggui-rule)',
            }}
          >
            error
          </span>
        ) : null}
      </button>
      {expanded ? <TraceDetail event={event} /> : null}
    </li>
  );
}

function TraceDetail({
  event,
}: {
  readonly event: LlmTraceEvent;
}): ReactElement {
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
      {event.systemPrompt ? (
        <Section label="system prompt">
          <pre style={preStyle}>{event.systemPrompt}</pre>
        </Section>
      ) : null}
      {event.userPrompt ? (
        <Section label="user prompt">
          <pre style={preStyle}>{event.userPrompt}</pre>
        </Section>
      ) : null}
      {event.tools && event.tools.length > 0 ? (
        <Section label={`tools (${event.tools.length})`}>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {event.tools.map((t) => (
              <li
                key={t.name}
                style={{
                  fontFamily: 'var(--ggui-font-mono)',
                  fontSize: 12,
                  padding: '2px 0',
                }}
              >
                <strong>{t.name}</strong>
                <span className="ggui-muted"> — {t.description}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {event.result?.text ? (
        <Section label="completion text">
          <pre style={preStyle}>{event.result.text}</pre>
        </Section>
      ) : null}
      {event.result?.toolCalls && event.result.toolCalls.length > 0 ? (
        <Section label={`tool calls (${event.result.toolCalls.length})`}>
          <pre style={preStyle}>
            {JSON.stringify(event.result.toolCalls, null, 2)}
          </pre>
        </Section>
      ) : null}
      {event.result?.turnsUsed ? (
        <Section label="agentic turns">
          <span className="ggui-muted">{event.result.turnsUsed}</span>
        </Section>
      ) : null}
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
