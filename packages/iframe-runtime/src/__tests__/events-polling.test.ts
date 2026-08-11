/**
 * `buildEventsPolling` — registry-level events-polling composition for
 * the iframe-runtime (R7). Reads /api/sessions/:sessionId/events with a
 * GguiSessionEvent ledger cursor; dispatches each event by `event.type` to
 * the registered channel handler.
 *
 * Mirrors the dropped R6 snapshot-polling tests with the cursor
 * semantics swapped in.
 */
import { describe, expect, it } from 'vitest';
import type { EventsResponse } from '@ggui-ai/protocol';
import { buildEventsPolling, createSequenceCursor } from '../events-polling.js';

describe('buildEventsPolling', () => {
  it('returns a descriptor with the cursor-aware URL and default interval', () => {
    const desc = buildEventsPolling({
      baseUrl: 'http://ggui.test/api/sessions/rdr-1/events?wsToken=abc',
    });
    expect(desc.intervalMs).toBe(2000);
    // First access — cursor seeded at 0.
    expect(desc.url).toBe(
      'http://ggui.test/api/sessions/rdr-1/events?wsToken=abc&sinceSequence=0&limit=100',
    );
  });

  it('honors initialSinceSequence + limit overrides on the composed URL', () => {
    const desc = buildEventsPolling({
      baseUrl: 'http://ggui.test/api/sessions/rdr-1/events?wsToken=abc',
      initialSinceSequence: 12,
      limit: 50,
    });
    expect(desc.url).toBe(
      'http://ggui.test/api/sessions/rdr-1/events?wsToken=abc&sinceSequence=12&limit=50',
    );
  });

  it('uses ? separator when baseUrl has no query string', () => {
    const desc = buildEventsPolling({
      baseUrl: 'http://ggui.test/api/sessions/rdr-1/events',
    });
    expect(desc.url).toBe(
      'http://ggui.test/api/sessions/rdr-1/events?sinceSequence=0&limit=100',
    );
  });

  it('returns null on parseSnapshot when body is not an EventsResponse', () => {
    const desc = buildEventsPolling({ baseUrl: 'http://x/events' });
    expect(desc.parseSnapshot('not an object')).toBeNull();
    expect(desc.parseSnapshot({ events: 'wrong type' })).toBeNull();
    expect(
      desc.parseSnapshot({ events: [], lastSequence: 0 /* no hasMore */ }),
    ).toBeNull();
  });

  it('returns empty frames map and advances cursor when EventsResponse has no events', () => {
    const desc = buildEventsPolling({
      baseUrl: 'http://x/events',
    });
    expect(desc.url).toBe('http://x/events?sinceSequence=0&limit=100');
    const body: EventsResponse = {
      events: [],
      lastSequence: 5,
      hasMore: false,
    };
    const frames = desc.parseSnapshot(body);
    expect(frames).toEqual({});
    // Cursor advanced even on empty pages.
    expect(desc.url).toBe('http://x/events?sinceSequence=5&limit=100');
  });

  it('dispatches one frame per event type and advances cursor', () => {
    const desc = buildEventsPolling({ baseUrl: 'http://x/events' });
    const body: EventsResponse = {
      events: [
        { seq: 1, timestamp: '2026-01-01T00:00:00Z', type: 'render', data: { session: { id: 'a' } } },
        { seq: 2, timestamp: '2026-01-01T00:00:01Z', type: 'props_update', data: { sessionId: 'a', props: { x: 1 } } },
      ],
      lastSequence: 2,
      hasMore: false,
    };
    const frames = desc.parseSnapshot(body);
    expect(frames).not.toBeNull();
    expect(Object.keys(frames!).sort()).toEqual(['props_update', 'render']);
    expect(frames!['render']?.type).toBe('render');
    expect(frames!['props_update']?.type).toBe('props_update');
    // Cursor advanced.
    expect(desc.url).toBe('http://x/events?sinceSequence=2&limit=100');
  });

  it('emits a synthetic error frame + advances cursor on REPLAY_HORIZON_PASSED', () => {
    // Realistic horizon violation: cursor (3) fell below the replay
    // horizon; the server's high-water mark (7) is ahead of it.
    const desc = buildEventsPolling({
      baseUrl: 'http://x/events',
      initialSinceSequence: 3,
    });
    const body = {
      reason: 'REPLAY_HORIZON_PASSED',
      currentSequence: 7,
    };
    const frames = desc.parseSnapshot(body);
    expect(frames).not.toBeNull();
    expect(frames!['error']?.type).toBe('error');
    const payload = frames!['error']?.payload as {
      code: string;
      details: { currentSequence: number };
    };
    expect(payload.code).toBe('REPLAY_HORIZON_PASSED');
    expect(payload.details.currentSequence).toBe(7);
    // Cursor advanced to the server's high-water mark; next tick
    // fetches forward from there.
    expect(desc.url).toBe('http://x/events?sinceSequence=7&limit=100');
  });

  it('REPLAY_HORIZON adopts a BACKWARD server high-water mark — the self-healing reset', () => {
    // Cursor ahead of the server's high-water mark: a re-minted or
    // reset session whose ledger restarted below the client's cursor.
    // The horizon branch uses cursor.reset() (server-truth override),
    // NOT the monotonic advance() — keeping 99 here would re-ask ahead
    // of the horizon on every tick, a permanent error loop. Only the
    // horizon branch may rewind; normal deliveries stay monotonic
    // (pinned by the SequenceCursor tests below).
    const desc = buildEventsPolling({
      baseUrl: 'http://x/events',
      initialSinceSequence: 99,
    });
    const frames = desc.parseSnapshot({
      reason: 'REPLAY_HORIZON_PASSED',
      currentSequence: 7,
    });
    expect(frames!['error']?.type).toBe('error');
    expect(desc.url).toBe('http://x/events?sinceSequence=7&limit=100');
  });

  it('dedupes when multiple events share a type — last one wins per tick', () => {
    const desc = buildEventsPolling({ baseUrl: 'http://x/events' });
    const body: EventsResponse = {
      events: [
        { seq: 1, timestamp: '2026-01-01T00:00:00Z', type: 'props_update', data: { sessionId: 'a', props: { x: 1 } } },
        { seq: 2, timestamp: '2026-01-01T00:00:01Z', type: 'props_update', data: { sessionId: 'a', props: { x: 2 } } },
      ],
      lastSequence: 2,
      hasMore: false,
    };
    const frames = desc.parseSnapshot(body);
    expect(frames).not.toBeNull();
    expect(Object.keys(frames!)).toEqual(['props_update']);
    const payload = frames!['props_update']?.payload as { props: { x: number } };
    expect(payload.props.x).toBe(2);
  });
});

describe('createSequenceCursor', () => {
  it('seeds at 0 by default', () => {
    expect(createSequenceCursor().get()).toBe(0);
  });

  it('seeds at the supplied value', () => {
    expect(createSequenceCursor(12).get()).toBe(12);
  });

  it('advance is a monotonic max — no-op when seq <= current', () => {
    const cursor = createSequenceCursor();
    cursor.advance(5);
    expect(cursor.get()).toBe(5);
    cursor.advance(3);
    expect(cursor.get()).toBe(5);
    cursor.advance(5);
    expect(cursor.get()).toBe(5);
    cursor.advance(6);
    expect(cursor.get()).toBe(6);
  });
});

describe('buildEventsPolling — shared ladder cursor', () => {
  it('reads the shared cursor per url access — an external advance (SSE delivery) moves the next tick forward', () => {
    const cursor = createSequenceCursor(7);
    const desc = buildEventsPolling({
      baseUrl: 'http://x/events',
      cursor,
    });
    expect(desc.url).toBe('http://x/events?sinceSequence=7&limit=100');
    // Simulate SSE deliveries between polling ticks — the SSE rung
    // advances the shared cursor via RegistrySseOptions.onSequence.
    cursor.advance(42);
    expect(desc.url).toBe('http://x/events?sinceSequence=42&limit=100');
  });

  it("exposes a tick's parseSnapshot advance on the shared cell", () => {
    const cursor = createSequenceCursor(0);
    const desc = buildEventsPolling({
      baseUrl: 'http://x/events',
      cursor,
    });
    const body: EventsResponse = {
      events: [],
      lastSequence: 9,
      hasMore: false,
    };
    expect(desc.parseSnapshot(body)).toEqual({});
    // The polling tick advanced the SHARED cursor, not a private copy.
    expect(cursor.get()).toBe(9);
    expect(desc.url).toBe('http://x/events?sinceSequence=9&limit=100');
  });

  it('ignores initialSinceSequence when a shared cursor is supplied', () => {
    const cursor = createSequenceCursor(4);
    const desc = buildEventsPolling({
      baseUrl: 'http://x/events',
      initialSinceSequence: 99,
      cursor,
    });
    expect(desc.url).toBe('http://x/events?sinceSequence=4&limit=100');
  });

  it('REPLAY_HORIZON_PASSED advances the shared cell to the server high-water mark', () => {
    const cursor = createSequenceCursor(3);
    const desc = buildEventsPolling({
      baseUrl: 'http://x/events',
      cursor,
    });
    const frames = desc.parseSnapshot({
      reason: 'REPLAY_HORIZON_PASSED',
      currentSequence: 7,
    });
    expect(frames!['error']?.type).toBe('error');
    expect(cursor.get()).toBe(7);
  });
});
