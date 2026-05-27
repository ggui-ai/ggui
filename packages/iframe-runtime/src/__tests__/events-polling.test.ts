/**
 * `buildEventsPolling` — registry-level events-polling composition for
 * the iframe-runtime (R7). Reads /api/renders/:renderId/events with a
 * SessionEvent ledger cursor; dispatches each event by `event.type` to
 * the registered channel handler.
 *
 * Mirrors the dropped R6 snapshot-polling tests with the cursor
 * semantics swapped in.
 */
import { describe, expect, it } from 'vitest';
import type { EventsResponse } from '@ggui-ai/protocol';
import { buildEventsPolling } from '../events-polling.js';

describe('buildEventsPolling', () => {
  it('returns a descriptor with the cursor-aware URL and default interval', () => {
    const desc = buildEventsPolling({
      baseUrl: 'http://ggui.test/api/renders/rdr-1/events?wsToken=abc',
    });
    expect(desc.intervalMs).toBe(2000);
    // First access — cursor seeded at 0.
    expect(desc.url).toBe(
      'http://ggui.test/api/renders/rdr-1/events?wsToken=abc&sinceSequence=0&limit=100',
    );
  });

  it('honors initialSinceSequence + limit overrides on the composed URL', () => {
    const desc = buildEventsPolling({
      baseUrl: 'http://ggui.test/api/renders/rdr-1/events?wsToken=abc',
      initialSinceSequence: 12,
      limit: 50,
    });
    expect(desc.url).toBe(
      'http://ggui.test/api/renders/rdr-1/events?wsToken=abc&sinceSequence=12&limit=50',
    );
  });

  it('uses ? separator when baseUrl has no query string', () => {
    const desc = buildEventsPolling({
      baseUrl: 'http://ggui.test/api/renders/rdr-1/events',
    });
    expect(desc.url).toBe(
      'http://ggui.test/api/renders/rdr-1/events?sinceSequence=0&limit=100',
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
        { sequence: 1, emittedAt: '2026-01-01T00:00:00Z', type: 'render', payload: { render: { id: 'a' } } },
        { sequence: 2, emittedAt: '2026-01-01T00:00:01Z', type: 'props_update', payload: { renderId: 'a', props: { x: 1 } } },
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

  it('emits a synthetic error frame + resets cursor on REPLAY_HORIZON_PASSED', () => {
    const desc = buildEventsPolling({
      baseUrl: 'http://x/events',
      initialSinceSequence: 99,
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
    // Cursor reset to the server's high-water mark; next tick fetches
    // forward from there.
    expect(desc.url).toBe('http://x/events?sinceSequence=7&limit=100');
  });

  it('dedupes when multiple events share a type — last one wins per tick', () => {
    const desc = buildEventsPolling({ baseUrl: 'http://x/events' });
    const body: EventsResponse = {
      events: [
        { sequence: 1, emittedAt: '2026-01-01T00:00:00Z', type: 'props_update', payload: { renderId: 'a', props: { x: 1 } } },
        { sequence: 2, emittedAt: '2026-01-01T00:00:01Z', type: 'props_update', payload: { renderId: 'a', props: { x: 2 } } },
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
