/**
 * `/devtools/payloads` — live MCP-tool payload inspector.
 *
 * Subscribes to two server endpoints:
 *   - `GET /ggui/console/payloads/recent?limit=100` (REST) — initial
 *     replay buffer on page mount.
 *   - `GET /ggui/console/payloads/stream` (SSE) — live append.
 *
 * Both routes are admin-gated server-side. The page uses no auth-token
 * client-side; the cookie + admin-HTML gate handle it.
 *
 * Render shape: reverse-chronological list of cards. Each card shows:
 *   - timestamp + direction chip (inbound-push / outbound-update)
 *   - tool name (`ggui_render` / `ggui_update`)
 *   - renderId truncated to 8 chars
 *   - byte size of the payload
 *   - expandable detail panel with pretty-printed JSON in a paper-2
 *     pre-block, max-height 400px scroll cap
 *
 * No virtualization yet — bounded buffer (100) keeps the list short
 * enough for naive React. A scroll surface contains the cards.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { SectionHead } from '../brand/SectionHead.js';

type PayloadDirection = 'inbound-push' | 'outbound-update';

interface PayloadEvent {
  readonly id: string;
  readonly at: number;
  readonly direction: PayloadDirection;
  readonly renderId: string;
  readonly appId: string;
  readonly tool: string;
  readonly payload: unknown;
  readonly byteSize: number;
}

export function Payloads(): ReactElement {
  const [events, setEvents] = useState<readonly PayloadEvent[]>([]);
  const [status, setStatus] = useState<
    'loading' | 'live' | 'reconnecting' | 'error'
  >('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seenIds = useRef<Set<string>>(new Set());

  // Initial fetch + SSE subscription. The SSE stream only delivers
  // future events; we backfill via /recent so the page isn't empty
  // when an operator opens it after pushes have already happened.
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;

    const append = (event: PayloadEvent): void => {
      if (seenIds.current.has(event.id)) return;
      seenIds.current.add(event.id);
      // Newest first — devtools pattern (most recent at top).
      setEvents((prev) => [event, ...prev].slice(0, 500));
    };

    const init = async (): Promise<void> => {
      try {
        const res = await fetch('/ggui/console/payloads/recent?limit=100', {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`recent fetch returned ${res.status}`);
        }
        const body = (await res.json()) as { events: PayloadEvent[] };
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
            : 'Could not load recent payloads.',
        );
        return;
      }

      // Open SSE stream.
      source = new EventSource('/ggui/console/payloads/stream', {
        withCredentials: true,
      });
      source.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as PayloadEvent;
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
        num="DEVTOOLS / 7E"
        title="Payloads."
        mute="Live."
        intro={
          <>
            Every <code className="ggui-code">ggui_render</code> and{' '}
            <code className="ggui-code">ggui_update</code> tool call as it
            lands on the handler — exactly the JSON the agent sent.
            Useful when contract drift or the agent paraphrases an
            intent. Bounded ring buffer — most recent 100 payloads stay
            in memory.
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
            <p className="ggui-muted" data-ggui-payloads-error>
              {errorMessage}
            </p>
          ) : null}
          {events.length === 0 && status !== 'error' ? (
            <p className="ggui-muted">
              No payloads yet. Trigger a{' '}
              <code className="ggui-code">ggui_render</code> from your MCP
              client and it'll appear here as it lands.
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
            data-ggui-payloads-list
          >
            {events.map((event) => (
              <PayloadCard
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

function PayloadCard({
  event,
  expanded,
  onToggle,
}: {
  readonly event: PayloadEvent;
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
  const renderShort =
    event.renderId.length > 8
      ? `${event.renderId.slice(0, 8)}…`
      : event.renderId;
  const directionLabel =
    event.direction === 'inbound-push' ? 'inbound' : 'outbound';

  return (
    <li
      style={{
        border: '1px solid var(--ggui-rule)',
        padding: '10px 12px',
        background: 'var(--ggui-paper)',
      }}
      data-ggui-payloads-event={event.id}
      data-ggui-payloads-direction={event.direction}
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
        <span
          style={{
            fontSize: 11,
            padding: '0 6px',
            border: '1px solid var(--ggui-rule)',
            fontFamily: 'var(--ggui-font-mono)',
          }}
        >
          {directionLabel}
        </span>
        <span style={{ fontFamily: 'var(--ggui-font-mono)', fontSize: 12 }}>
          {event.tool}
        </span>
        <span
          className="ggui-muted"
          style={{ fontSize: 11, fontFamily: 'var(--ggui-font-mono)' }}
        >
          {renderShort}
        </span>
        <span style={{ flex: 1 }} />
        <span className="ggui-muted" style={{ fontSize: 11 }}>
          {formatBytes(event.byteSize)}
        </span>
      </button>
      {expanded ? <PayloadDetail event={event} /> : null}
    </li>
  );
}

function PayloadDetail({
  event,
}: {
  readonly event: PayloadEvent;
}): ReactElement {
  const json = safeStringify(event.payload);
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
      <Section label="render">
        <span
          className="ggui-muted"
          style={{ fontFamily: 'var(--ggui-font-mono)', fontSize: 12 }}
        >
          {event.renderId} · app {event.appId}
        </span>
      </Section>
      <Section label="payload">
        <pre style={preStyle}>{json}</pre>
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

/**
 * `JSON.stringify` with an indent for readability. Wrapped in try/catch
 * because a payload that survived the server's JSON.stringify (for
 * byteSize) can still surprise us if a hosted sink swapped in a custom
 * shape that's not round-trip-safe. Falls back to a `[unstringifiable]`
 * marker rather than crashing the card.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'undefined';
  } catch {
    return '[unstringifiable]';
  }
}

/** Render a byte count as `123 B` / `4.2 KB` / `1.3 MB`. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  maxHeight: 400,
  overflow: 'auto',
};
