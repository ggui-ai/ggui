/**
 * `/devtools/timeline` — session event time-travel inspector.
 *
 * Two-pane layout:
 *
 *   - **Left**: session picker. Fetches
 *     `GET /ggui/console/timeline/sessions` once on mount; rows show
 *     sessionId / appId / status / event-cursor metadata, sorted
 *     most-recent-`lastActivityAt` first. Click a row to load its
 *     event log into the right pane.
 *   - **Right**: scrubber over the picked session's event log.
 *     Slider walks `seq` from 1..N; current event card shows the
 *     full `SessionEvent.data` JSON in a `<pre>`. Prev / next /
 *     jump-to-start / jump-to-end buttons. Empty state when no
 *     events.
 *
 * Useful for debugging "what was the UI state at event N?" without
 * a live tail — replay is a snapshot, the operator picks a frozen
 * point in history. Unlike the live LLM-trace inspector, this view
 * does not use SSE: a moving end-of-stream would defeat the
 * scrubber's semantics.
 *
 * Test contract (data-attrs):
 *   - `data-ggui-timeline-pane="sessions"` — left list
 *   - `data-ggui-timeline-session-id={id}` — each session row
 *   - `data-ggui-timeline-pane="events"` — right pane
 *   - `data-ggui-timeline-event-seq={seq}` — current event card
 *   - `data-ggui-timeline-scrubber` — the slider
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';

interface TimelineSessionSummary {
  readonly sessionId: string;
  readonly appId: string;
  readonly stackSize: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly status: 'active' | 'completed' | 'expired';
  readonly streamSeq: number;
}

interface TimelineSessionsResponse {
  readonly sessions: readonly TimelineSessionSummary[];
  readonly total: number;
}

interface TimelineSessionEvent {
  readonly seq: number;
  readonly type: string;
  readonly timestamp: number;
  readonly data: unknown;
}

interface TimelineEventsResponse {
  readonly sessionId: string;
  readonly events: readonly TimelineSessionEvent[];
  readonly streamSeq: number;
  readonly status: 'active' | 'completed' | 'expired' | 'unknown';
}

type SessionsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: TimelineSessionsResponse }
  | { readonly kind: 'error'; readonly message: string };

type EventsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly sessionId: string }
  | {
      readonly kind: 'ready';
      readonly sessionId: string;
      readonly data: TimelineEventsResponse;
    }
  | {
      readonly kind: 'error';
      readonly sessionId: string;
      readonly message: string;
    };

export function Timeline(): ReactElement {
  const [sessions, setSessions] = useState<SessionsState>({ kind: 'loading' });
  const [events, setEvents] = useState<EventsState>({ kind: 'idle' });
  const [pickedSessionId, setPickedSessionId] = useState<string | null>(null);
  const [scrubIndex, setScrubIndex] = useState(0);

  // Fetch the session picker once on mount.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch('/ggui/console/timeline/sessions', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (!res.ok) {
          setSessions({
            kind: 'error',
            message: `server returned ${res.status}`,
          });
          return;
        }
        const body = (await res.json()) as TimelineSessionsResponse;
        setSessions({ kind: 'ready', data: body });
      } catch (err) {
        if (controller.signal.aborted) return;
        setSessions({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => controller.abort();
  }, []);

  // Fetch events whenever the picked session changes.
  const pickSession = useCallback((sessionId: string) => {
    setPickedSessionId(sessionId);
    setScrubIndex(0);
    setEvents({ kind: 'loading', sessionId });
  }, []);

  useEffect(() => {
    if (!pickedSessionId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/ggui/console/timeline/${encodeURIComponent(pickedSessionId)}/events`,
          {
            signal: controller.signal,
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          },
        );
        // 404 carries a well-formed body so we render a hint
        // instead of erroring.
        const body = (await res.json()) as TimelineEventsResponse;
        if (!res.ok && res.status !== 404) {
          setEvents({
            kind: 'error',
            sessionId: pickedSessionId,
            message: `server returned ${res.status}`,
          });
          return;
        }
        setEvents({
          kind: 'ready',
          sessionId: pickedSessionId,
          data: body,
        });
        // Default to the latest event so the operator sees the
        // most-recent state on selection.
        setScrubIndex(Math.max(0, body.events.length - 1));
      } catch (err) {
        if (controller.signal.aborted) return;
        setEvents({
          kind: 'error',
          sessionId: pickedSessionId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => controller.abort();
  }, [pickedSessionId]);

  return (
    <section className="ggui-section">
      <SectionHead
        num="DEVTOOLS / 7D"
        title="Session timeline."
        mute="Snapshot."
        intro={
          <>
            Pick a session, then step through its event log
            chronologically. Each event carries the full
            <code className="ggui-code"> SessionEvent.data </code>
            payload — useful for answering &ldquo;what was the UI
            state at event N?&rdquo; without a live tail.
          </>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(260px, 320px) 1fr',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <SessionsPane
          state={sessions}
          pickedSessionId={pickedSessionId}
          onPick={pickSession}
        />
        <EventsPane
          state={events}
          scrubIndex={scrubIndex}
          onScrub={setScrubIndex}
        />
      </div>
    </section>
  );
}

// ── Sessions pane ─────────────────────────────────────────────────────

function SessionsPane({
  state,
  pickedSessionId,
  onPick,
}: {
  readonly state: SessionsState;
  readonly pickedSessionId: string | null;
  readonly onPick: (sessionId: string) => void;
}): ReactElement {
  return (
    <div className="ggui-card" data-ggui-timeline-pane="sessions">
      <div className="ggui-card__head">
        <span className="ggui-card__title">sessions</span>
        <span className="ggui-card__num">
          {state.kind === 'loading'
            ? 'loading…'
            : state.kind === 'error'
              ? 'error'
              : `${state.data.sessions.length} / ${state.data.total}`}
        </span>
      </div>
      <div className="ggui-card__body" style={{ padding: 0 }}>
        {state.kind === 'loading' ? (
          <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
            Loading sessions…
          </p>
        ) : state.kind === 'error' ? (
          <p
            className="ggui-muted"
            style={{ margin: 0, padding: 12 }}
            data-ggui-timeline-sessions-error
          >
            Couldn&apos;t load sessions — {state.message}.
          </p>
        ) : state.data.sessions.length === 0 ? (
          <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
            No sessions yet. Render from an agent (
            <code className="ggui-code">ggui_render</code>) to create one.
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              maxHeight: 520,
              overflowY: 'auto',
            }}
          >
            {state.data.sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                selected={session.sessionId === pickedSessionId}
                onClick={() => onPick(session.sessionId)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  selected,
  onClick,
}: {
  readonly session: TimelineSessionSummary;
  readonly selected: boolean;
  readonly onClick: () => void;
}): ReactElement {
  const shortId = session.sessionId.slice(0, 12);
  const tone =
    session.status === 'active'
      ? 'live'
      : session.status === 'expired'
        ? 'signal'
        : 'ink';
  return (
    <li
      data-ggui-timeline-session-id={session.sessionId}
      data-ggui-timeline-session-selected={selected ? 'true' : 'false'}
      style={{
        borderBottom: '1px solid var(--ggui-rule)',
      }}
    >
      <button
        type="button"
        onClick={onClick}
        style={{
          all: 'unset',
          cursor: 'pointer',
          width: '100%',
          padding: '10px 12px',
          display: 'block',
          background: selected ? 'var(--ggui-paper-2, #efeee8)' : 'transparent',
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'baseline',
            marginBottom: 4,
          }}
        >
          <code
            className="ggui-code"
            style={{ fontSize: 12, fontFamily: 'var(--ggui-font-mono)' }}
          >
            {shortId}…
          </code>
          <StatusBadge tone={tone}>{session.status}</StatusBadge>
        </div>
        <div className="ggui-muted" style={{ fontSize: 11 }}>
          app <code className="ggui-code">{session.appId}</code> · stack{' '}
          {session.stackSize} · stream {session.streamSeq}
        </div>
        <div className="ggui-muted" style={{ fontSize: 11, marginTop: 2 }}>
          last {formatRelative(session.lastActivityAt)}
        </div>
      </button>
    </li>
  );
}

// ── Events pane ───────────────────────────────────────────────────────

function EventsPane({
  state,
  scrubIndex,
  onScrub,
}: {
  readonly state: EventsState;
  readonly scrubIndex: number;
  readonly onScrub: (index: number) => void;
}): ReactElement {
  if (state.kind === 'idle') {
    return (
      <div className="ggui-card" data-ggui-timeline-pane="events">
        <div className="ggui-card__head">
          <span className="ggui-card__title">timeline</span>
          <span className="ggui-card__num">DEV / 7D</span>
        </div>
        <div className="ggui-card__body">
          <p className="ggui-muted">
            Pick a session on the left to load its event log.
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div className="ggui-card" data-ggui-timeline-pane="events">
        <div className="ggui-card__head">
          <span className="ggui-card__title">timeline</span>
          <span className="ggui-card__num">loading…</span>
        </div>
        <div className="ggui-card__body">
          <p className="ggui-muted">
            Loading events for{' '}
            <code className="ggui-code">{shorten(state.sessionId)}</code>…
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="ggui-card" data-ggui-timeline-pane="events">
        <div className="ggui-card__head">
          <span className="ggui-card__title">timeline</span>
          <span className="ggui-card__num">error</span>
        </div>
        <div className="ggui-card__body">
          <p className="ggui-muted" data-ggui-timeline-events-error>
            Couldn&apos;t load events — {state.message}.
          </p>
        </div>
      </div>
    );
  }

  return <EventsLoaded state={state} scrubIndex={scrubIndex} onScrub={onScrub} />;
}

function EventsLoaded({
  state,
  scrubIndex,
  onScrub,
}: {
  readonly state: Extract<EventsState, { kind: 'ready' }>;
  readonly scrubIndex: number;
  readonly onScrub: (index: number) => void;
}): ReactElement {
  const { events, status, streamSeq } = state.data;
  const total = events.length;
  const safeIndex = useMemo(() => {
    if (total === 0) return 0;
    return Math.max(0, Math.min(scrubIndex, total - 1));
  }, [scrubIndex, total]);
  const current = total > 0 ? events[safeIndex] : null;

  const goPrev = useCallback(() => {
    if (total === 0) return;
    onScrub(Math.max(0, safeIndex - 1));
  }, [onScrub, safeIndex, total]);
  const goNext = useCallback(() => {
    if (total === 0) return;
    onScrub(Math.min(total - 1, safeIndex + 1));
  }, [onScrub, safeIndex, total]);
  const goStart = useCallback(() => onScrub(0), [onScrub]);
  const goEnd = useCallback(() => {
    if (total === 0) return;
    onScrub(total - 1);
  }, [onScrub, total]);

  return (
    <div className="ggui-card" data-ggui-timeline-pane="events">
      <div className="ggui-card__head">
        <span className="ggui-card__title">
          <code className="ggui-code">{shorten(state.sessionId)}</code>
        </span>
        <span className="ggui-card__num">
          {total === 0 ? 'no events' : `${safeIndex + 1} / ${total}`}
        </span>
      </div>
      <div className="ggui-card__body">
        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            marginBottom: 12,
            flexWrap: 'wrap',
          }}
        >
          <span className="ggui-muted" style={{ fontSize: 12 }}>
            status{' '}
            <code className="ggui-code">{status}</code>
          </span>
          <span className="ggui-muted" style={{ fontSize: 12 }}>
            stream cursor{' '}
            <code className="ggui-code">{streamSeq}</code>
          </span>
          <span className="ggui-muted" style={{ fontSize: 12 }}>
            inbound events{' '}
            <code className="ggui-code">{total}</code>
          </span>
        </div>

        {total === 0 ? (
          <p className="ggui-muted">
            No events recorded for this session yet. Inbound user
            actions, tool calls, and UI mutations land here as the
            agent runs — open the iframe and interact to populate.
          </p>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                marginBottom: 12,
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                onClick={goStart}
                disabled={safeIndex === 0}
                className="ggui-btn ggui-btn--ghost"
                data-ggui-timeline-jump="start"
              >
                ⟪ start
              </button>
              <button
                type="button"
                onClick={goPrev}
                disabled={safeIndex === 0}
                className="ggui-btn ggui-btn--ghost"
                data-ggui-timeline-jump="prev"
              >
                ‹ prev
              </button>
              <input
                type="range"
                min={0}
                max={total - 1}
                value={safeIndex}
                onChange={(e) => onScrub(Number(e.target.value))}
                aria-label="event scrubber"
                data-ggui-timeline-scrubber
                style={{ flex: 1, minWidth: 160 }}
              />
              <button
                type="button"
                onClick={goNext}
                disabled={safeIndex >= total - 1}
                className="ggui-btn ggui-btn--ghost"
                data-ggui-timeline-jump="next"
              >
                next ›
              </button>
              <button
                type="button"
                onClick={goEnd}
                disabled={safeIndex >= total - 1}
                className="ggui-btn ggui-btn--ghost"
                data-ggui-timeline-jump="end"
              >
                end ⟫
              </button>
            </div>
            {current ? <EventCard event={current} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

function EventCard({
  event,
}: {
  readonly event: TimelineSessionEvent;
}): ReactElement {
  return (
    <div
      data-ggui-timeline-event-seq={event.seq}
      data-ggui-timeline-event-type={event.type}
      style={{
        border: '1px solid var(--ggui-rule)',
        padding: '10px 12px',
        background: 'var(--ggui-paper)',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'baseline',
          marginBottom: 8,
        }}
      >
        <span
          className="ggui-muted"
          style={{ fontSize: 11, fontFamily: 'var(--ggui-font-mono)' }}
        >
          seq {event.seq}
        </span>
        <span style={{ fontFamily: 'var(--ggui-font-mono)', fontSize: 12 }}>
          {event.type}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="ggui-muted"
          style={{ fontSize: 11, fontFamily: 'var(--ggui-font-mono)' }}
        >
          {formatTime(event.timestamp)}
        </span>
      </div>
      <pre style={preStyle}>{safeStringify(event.data)}</pre>
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
  maxHeight: 420,
  overflow: 'auto',
};

// ── Helpers ───────────────────────────────────────────────────────────

function shorten(id: string): string {
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toISOString().slice(11, 23); // HH:MM:SS.mmm
  } catch {
    return String(ms);
  }
}

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
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
