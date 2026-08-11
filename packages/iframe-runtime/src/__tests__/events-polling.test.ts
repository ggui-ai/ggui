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
import type { EventsResponse, GguiRuntimePullInput } from '@ggui-ai/protocol';
import {
  buildBridgePolling,
  buildEventsPolling,
  createSequenceCursor,
} from '../events-polling.js';

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

  it("maps the ledger's canonical 'ui.updated' onto the 'props_update' frame type", () => {
    // The ledger speaks the event taxonomy; the handler map speaks
    // frame types. ggui_update appends 'ui.updated' (transport-ladder
    // ruling 19) — the parse core is the single translation point, so
    // pull rungs repaint through the same props_update handler the
    // WS/SSE push planes use.
    const desc = buildEventsPolling({ baseUrl: 'http://x/events' });
    const frames = desc.parseSnapshot({
      events: [
        {
          seq: 1,
          timestamp: '2026-01-01T00:00:00Z',
          type: 'ui.updated',
          data: { sessionId: 'a', props: { x: 9 } },
        },
      ],
      lastSequence: 1,
      hasMore: false,
    });
    expect(frames).not.toBeNull();
    expect(frames!['ui.updated']).toBeUndefined();
    expect(frames!['props_update']).toEqual({
      type: 'props_update',
      payload: { sessionId: 'a', props: { x: 9 } },
    });
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

describe('buildBridgePolling — bridge-pull terminal rung', () => {
  /**
   * Recording `callTool` fake — captures every `(name, args)` pair and
   * replays the queued CallToolResult shapes in order (last one
   * repeats when the queue drains).
   */
  function makeCallTool(results: readonly unknown[]): {
    callTool: (
      name: 'ggui_runtime_pull',
      args: GguiRuntimePullInput,
    ) => Promise<unknown>;
    calls: Array<{ name: string; args: GguiRuntimePullInput }>;
  } {
    const queue = [...results];
    const calls: Array<{ name: string; args: GguiRuntimePullInput }> = [];
    return {
      calls,
      callTool: (name, args) => {
        calls.push({ name, args: { ...args } });
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return Promise.resolve(next);
      },
    };
  }

  const emptyPage = (lastSequence: number): EventsResponse => ({
    events: [],
    lastSequence,
    hasMore: false,
  });

  it('is a fetchBody carrier — NO url key, default 3000ms interval', () => {
    const { callTool } = makeCallTool([{ structuredContent: emptyPage(0) }]);
    const desc = buildBridgePolling({
      callTool,
      sessionId: 'render_001',
      cursor: createSequenceCursor(0),
    });
    // Exactly-one-of contract on RegistryPollingOptions: the bridge
    // rung supplies fetchBody and must not carry a url key at all.
    expect('url' in desc).toBe(false);
    expect(desc.fetchBody).toBeTypeOf('function');
    expect(desc.intervalMs).toBe(3000);
    expect(desc.parseSnapshot).toBeTypeOf('function');
  });

  it('honors the intervalMs override', () => {
    const { callTool } = makeCallTool([{ structuredContent: emptyPage(0) }]);
    const desc = buildBridgePolling({
      callTool,
      sessionId: 'render_001',
      cursor: createSequenceCursor(0),
      intervalMs: 15_000,
    });
    expect(desc.intervalMs).toBe(15_000);
  });

  it('calls ggui_runtime_pull with the shared cursor per tick — parseSnapshot advances the next pull', async () => {
    const cursor = createSequenceCursor(7);
    const { callTool, calls } = makeCallTool([
      { structuredContent: emptyPage(12) },
    ]);
    const desc = buildBridgePolling({
      callTool,
      sessionId: 'render_001',
      cursor,
    });

    const body = await desc.fetchBody!();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('ggui_runtime_pull');
    expect(calls[0]?.args).toEqual({
      sessionId: 'render_001',
      sinceSequence: 7,
      // Subscription mode is the default posture: hot pulls carry the
      // server-side hold (ruling 20).
      wait: 20,
    });

    // The transport hands the resolved body to parseSnapshot — the
    // SAME EventsResponse core as the HTTP rung, advancing the SHARED
    // cursor to lastSequence.
    expect(desc.parseSnapshot(body)).toEqual({});
    expect(cursor.get()).toBe(12);

    // Next tick pulls from the advanced cursor.
    await desc.fetchBody!();
    expect(calls[1]?.args).toEqual({
      sessionId: 'render_001',
      sinceSequence: 12,
      wait: 20,
    });
  });

  it('threads limit verbatim when set; omits the key entirely when unset (exact-optional)', async () => {
    const cursor = createSequenceCursor(0);
    const withLimit = makeCallTool([{ structuredContent: emptyPage(0) }]);
    await buildBridgePolling({
      callTool: withLimit.callTool,
      sessionId: 'render_001',
      cursor,
      limit: 25,
    }).fetchBody!();
    expect(withLimit.calls[0]?.args.limit).toBe(25);

    const withoutLimit = makeCallTool([{ structuredContent: emptyPage(0) }]);
    await buildBridgePolling({
      callTool: withoutLimit.callTool,
      sessionId: 'render_001',
      cursor,
    }).fetchBody!();
    expect(
      withoutLimit.calls[0] !== undefined && 'limit' in withoutLimit.calls[0].args,
    ).toBe(false);
  });

  it('unwraps the spec-canonical structuredContent tier', async () => {
    const page: EventsResponse = {
      events: [
        {
          seq: 1,
          timestamp: '2026-01-01T00:00:00Z',
          type: 'props_update',
          data: { sessionId: 'render_001', props: { x: 1 } },
        },
      ],
      lastSequence: 1,
      hasMore: false,
    };
    const { callTool } = makeCallTool([
      { content: [{ type: 'text', text: 'ok' }], structuredContent: page },
    ]);
    const desc = buildBridgePolling({
      callTool,
      sessionId: 'render_001',
      cursor: createSequenceCursor(0),
    });
    const body = await desc.fetchBody!();
    expect(body).toEqual(page);
    const frames = desc.parseSnapshot(body);
    expect(frames!['props_update']?.type).toBe('props_update');
  });

  it('unwraps the text-only normalized tier — the claude.ai relay shape', async () => {
    // claude.ai's live relay behavior (#471 retest): the CallToolResult
    // arrives normalized down to its text block — no structuredContent.
    // The shared 3-tier unwrap parses the JSON out of content[0].text.
    const page: EventsResponse = {
      events: [
        {
          seq: 3,
          timestamp: '2026-01-01T00:00:02Z',
          type: 'props_update',
          data: { sessionId: 'render_001', props: { x: 3 } },
        },
      ],
      lastSequence: 3,
      hasMore: false,
    };
    const { callTool } = makeCallTool([
      { content: [{ type: 'text', text: JSON.stringify(page) }] },
    ]);
    const cursor = createSequenceCursor(0);
    const desc = buildBridgePolling({
      callTool,
      sessionId: 'render_001',
      cursor,
    });
    const body = await desc.fetchBody!();
    expect(body).toEqual(page);
    const frames = desc.parseSnapshot(body);
    expect(frames!['props_update']?.type).toBe('props_update');
    expect(cursor.get()).toBe(3);
  });

  it('unwraps the bare-result tier — fields directly on the CallToolResult', async () => {
    const page = emptyPage(5);
    const { callTool } = makeCallTool([page]);
    const cursor = createSequenceCursor(0);
    const desc = buildBridgePolling({
      callTool,
      sessionId: 'render_001',
      cursor,
    });
    const body = await desc.fetchBody!();
    expect(desc.parseSnapshot(body)).toEqual({});
    expect(cursor.get()).toBe(5);
  });

  it('a non-object result unwraps to null and parseSnapshot treats it as no change', async () => {
    const { callTool } = makeCallTool(['not an object']);
    const desc = buildBridgePolling({
      callTool,
      sessionId: 'render_001',
      cursor: createSequenceCursor(0),
    });
    const body = await desc.fetchBody!();
    expect(body).toBeNull();
    expect(desc.parseSnapshot(body)).toBeNull();
  });

  it('REPLAY_HORIZON_PASSED as a NORMAL result resets the shared cursor via cursor.reset()', async () => {
    // Cursor ahead of the server's high-water mark (re-minted/reset
    // session ledger) — the horizon arm arrives as a normal tool
    // result, not an error, and must REWIND the cursor (reset, not
    // monotonic advance) so the next pull lands inside the window.
    const cursor = createSequenceCursor(99);
    const { callTool, calls } = makeCallTool([
      {
        structuredContent: { reason: 'REPLAY_HORIZON_PASSED', currentSequence: 7 },
      },
    ]);
    const desc = buildBridgePolling({
      callTool,
      sessionId: 'render_001',
      cursor,
    });
    const body = await desc.fetchBody!();
    const frames = desc.parseSnapshot(body);
    expect(frames!['error']?.type).toBe('error');
    const payload = frames!['error']?.payload as {
      code: string;
      details: { currentSequence: number };
    };
    expect(payload.code).toBe('REPLAY_HORIZON_PASSED');
    expect(cursor.get()).toBe(7);
    // Next pull resumes inside the replayable window.
    await desc.fetchBody!();
    expect(calls[1]?.args.sinceSequence).toBe(7);
  });

  it("shares the parse core with the HTTP rung — 'ui.updated' maps onto 'props_update' here too", async () => {
    const { callTool } = makeCallTool([
      {
        structuredContent: {
          events: [
            {
              seq: 2,
              timestamp: '2026-01-01T00:00:01Z',
              type: 'ui.updated',
              data: { sessionId: 'render_001', props: { x: 2 } },
            },
          ],
          lastSequence: 2,
          hasMore: false,
        },
      },
    ]);
    const desc = buildBridgePolling({
      callTool,
      sessionId: 'render_001',
      cursor: createSequenceCursor(0),
    });
    const frames = desc.parseSnapshot(await desc.fetchBody!());
    expect(frames!['props_update']?.type).toBe('props_update');
    expect(frames!['ui.updated']).toBeUndefined();
  });

  describe('subscription mode (transport-ladder ruling 20)', () => {
    const eventPage = (seq: number): EventsResponse => ({
      events: [
        {
          seq,
          timestamp: '2026-01-01T00:00:00Z',
          type: 'ui.updated',
          data: { sessionId: 's', props: { seq } },
        },
      ],
      lastSequence: seq,
      hasMore: false,
    });
    const emptyAt = (lastSequence: number): EventsResponse => ({
      events: [],
      lastSequence,
      hasMore: false,
    });

    it('hot pulls carry wait; nextDelayMs chains immediately on events', async () => {
      const { callTool, calls } = makeCallTool([eventPage(1)]);
      const desc = buildBridgePolling({
        callTool,
        sessionId: 's',
        cursor: createSequenceCursor(0),
        holdSeconds: 20,
      });
      const body = await desc.fetchBody!();
      expect(calls[0]?.args.wait).toBe(20);
      expect(desc.nextDelayMs!(body)).toBe(0);
    });

    it('demotes to idle pacing after 3 consecutive empty holds, drops wait, re-promotes on events', async () => {
      const { callTool, calls } = makeCallTool([emptyAt(0)]);
      const desc = buildBridgePolling({
        callTool,
        sessionId: 's',
        cursor: createSequenceCursor(0),
        idleIntervalMs: 15_000,
      });
      // Three empty holds: first two stay hot (immediate re-hold)…
      expect(desc.nextDelayMs!(await desc.fetchBody!())).toBe(0);
      expect(desc.nextDelayMs!(await desc.fetchBody!())).toBe(0);
      // …the third demotes to idle pacing.
      expect(desc.nextDelayMs!(await desc.fetchBody!())).toBe(15_000);
      // Idle pulls are un-held — no wait key at all (exact-optional).
      await desc.fetchBody!();
      expect('wait' in calls[3]!.args).toBe(false);
      // An event re-promotes to subscription mode…
      expect(desc.nextDelayMs!(eventPage(1))).toBe(0);
      // …and the next pull holds again.
      await desc.fetchBody!();
      expect(calls[4]?.args.wait).toBe(20);
    });

    it('horizon body → immediate re-pull; garbage body → idle pacing', () => {
      const { callTool } = makeCallTool([emptyAt(0)]);
      const desc = buildBridgePolling({
        callTool,
        sessionId: 's',
        cursor: createSequenceCursor(0),
        idleIntervalMs: 9000,
      });
      expect(
        desc.nextDelayMs!({ reason: 'REPLAY_HORIZON_PASSED', currentSequence: 4 }),
      ).toBe(0);
      expect(desc.nextDelayMs!('not a page')).toBe(9000);
    });
  });
});
