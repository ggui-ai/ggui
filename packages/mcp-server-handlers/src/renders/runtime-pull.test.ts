import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { GguiSessionEvent } from '@ggui-ai/protocol';
import {
  RUNTIME_PULL_MAX_LIMIT,
  RUNTIME_PULL_MAX_WAIT_SECONDS,
  runtimePullInputSchema,
  runtimePullInputShape,
  runtimePullOutputSchema,
} from '@ggui-ai/protocol';
import type { ComponentGguiSession, EventsResponse } from '@ggui-ai/protocol';
import { createGguiRuntimePullHandler } from './runtime-pull.js';
import { GguiSessionNotFoundError } from './errors.js';

/**
 * Tests for `createGguiRuntimePullHandler` — the terminal bridge-pull
 * rung's server side. Pins:
 *
 *   - declaration meta (name, audience, `_meta.ui.visibility: ['app']`
 *     — without it MCP Apps hosts reject iframe-issued tools/call and
 *     the terminal rung goes dark);
 *   - uniform-404 tenancy (unknown = cross-app = deleted mid-read);
 *   - cursor paging + hasMore + empty-page lastSequence advance;
 *   - limit clamp at RUNTIME_PULL_MAX_LIMIT (clamped, not rejected);
 *   - replay horizon in BOTH directions as a NORMAL result arm;
 *   - shape alignment with the protocol's `runtimePullOutputSchema`
 *     union (EventsResponse byte-parity with the /events route).
 */

const NOW_MS = Date.parse('2026-08-11T00:00:00.000Z');
const APP = 'app-1';
const SESSION = 'render-pull-1';

async function seedRender(
  store: InMemoryGguiSessionStore,
  opts: { sessionId?: string; appId?: string; eventCount?: number } = {},
): Promise<{ sessionId: string }> {
  const sessionId = opts.sessionId ?? SESSION;
  const appId = opts.appId ?? APP;
  const render: ComponentGguiSession = {
    id: sessionId,
    appId,
    type: 'component',
    componentCode: 'export default () => null;',
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
  };
  await store.commit({ render, appId });
  for (let i = 1; i <= (opts.eventCount ?? 0); i += 1) {
    await store.appendEvent({
      sessionId,
      type: 'ui.updated',
      data: { i },
    });
  }
  return { sessionId };
}

const ctx = { appId: APP, requestId: 'r-pull' } as const;

/** What the handler puts on the wire: the two protocol arms flattened into one optional-field object. */
type RuntimePullWire = Awaited<ReturnType<ReturnType<typeof createGguiRuntimePullHandler>['handler']>>;

/**
 * Narrowing helper — parses the flattened wire result against the protocol's
 * own union (parity by construction on every call) and fails the test loudly
 * when the wrong arm came back.
 */
function expectPage(out: RuntimePullWire): EventsResponse {
  const parsed = runtimePullOutputSchema.parse(out);
  if ('reason' in parsed) {
    throw new Error(`expected a normal page, got horizon arm: ${JSON.stringify(out)}`);
  }
  return parsed;
}

describe('createGguiRuntimePullHandler', () => {
  let store: InMemoryGguiSessionStore;

  beforeEach(() => {
    store = new InMemoryGguiSessionStore();
  });

  describe('declaration metadata (pin)', () => {
    it('exposes the canonical tool name ggui_runtime_pull on the runtime audience', () => {
      const h = createGguiRuntimePullHandler({ renderStore: store });
      expect(h.name).toBe('ggui_runtime_pull');
      expect(h.audience).toEqual(['runtime']);
      expect(h.title).toBe('[runtime] Pull Events');
    });

    it('stamps _meta.ui.visibility = ["app"] (spec §401 — iframe-callable only)', () => {
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const meta = h._meta as
        | { ui?: { visibility?: readonly string[] } }
        | undefined;
      expect(meta?.ui?.visibility).toEqual(['app']);
    });

    it('registers the protocol-authored input shape verbatim (SSoT — no parallel copy)', () => {
      const h = createGguiRuntimePullHandler({ renderStore: store });
      expect(h.inputSchema).toBe(runtimePullInputShape);
    });
  });

  describe('tenancy — uniform not-found', () => {
    it('throws GguiSessionNotFoundError for an unknown sessionId', async () => {
      const h = createGguiRuntimePullHandler({ renderStore: store });
      await expect(
        h.handler({ sessionId: 'nope' }, ctx),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });

    it('cross-app read is byte-identical to never-existed (no existence leak)', async () => {
      await seedRender(store, { eventCount: 2 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const crossTenant = await h
        .handler({ sessionId: SESSION }, { appId: 'other-app', requestId: 'r-x' })
        .then(
          () => {
            throw new Error('expected a throw');
          },
          (err: unknown) => err,
        );
      expect(crossTenant).toBeInstanceOf(GguiSessionNotFoundError);
      if (!(crossTenant instanceof GguiSessionNotFoundError)) {
        throw new Error('unreachable — asserted above');
      }
      // Same class AND same message as a genuine miss for the same id.
      expect(crossTenant.message).toBe(
        new GguiSessionNotFoundError(SESSION).message,
      );
    });

    it('render deleted between tenancy read and ledger read → same uniform not-found', async () => {
      await seedRender(store, { eventCount: 1 });
      // Stub the race: get() resolves, listEventsSince() misses.
      const racing: typeof store = Object.create(store);
      racing.listEventsSince = async () => null;
      const h = createGguiRuntimePullHandler({ renderStore: racing });
      await expect(
        h.handler({ sessionId: SESSION }, ctx),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });
  });

  describe('cursor paging', () => {
    it('sinceSequence omitted defaults to 0 — full replay', async () => {
      await seedRender(store, { eventCount: 3 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const out = expectPage(await h.handler({ sessionId: SESSION }, ctx));
      expect(out.events.map((e: GguiSessionEvent) => e.seq)).toEqual([1, 2, 3]);
      expect(out.lastSequence).toBe(3);
      expect(out.hasMore).toBe(false);
    });

    it('returns only events with seq > sinceSequence', async () => {
      await seedRender(store, { eventCount: 5 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const out = expectPage(
        await h.handler({ sessionId: SESSION, sinceSequence: 3 }, ctx),
      );
      expect(out.events.map((e: GguiSessionEvent) => e.seq)).toEqual([4, 5]);
      expect(out.lastSequence).toBe(5);
      expect(out.hasMore).toBe(false);
    });

    it('empty page at the high-water mark still advances the cursor via lastSequence', async () => {
      await seedRender(store, { eventCount: 5 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const out = expectPage(
        await h.handler({ sessionId: SESSION, sinceSequence: 5 }, ctx),
      );
      expect(out.events).toEqual([]);
      expect(out.lastSequence).toBe(5);
      expect(out.hasMore).toBe(false);
    });

    it('hasMore=true when limit truncates; walking the cursor drains the ledger', async () => {
      await seedRender(store, { eventCount: 5 });
      const h = createGguiRuntimePullHandler({ renderStore: store });

      const page1 = expectPage(
        await h.handler({ sessionId: SESSION, sinceSequence: 0, limit: 2 }, ctx),
      );
      expect(page1.events.map((e: GguiSessionEvent) => e.seq)).toEqual([1, 2]);
      expect(page1.hasMore).toBe(true);
      expect(page1.lastSequence).toBe(5);

      const page2 = expectPage(
        await h.handler({ sessionId: SESSION, sinceSequence: 2, limit: 2 }, ctx),
      );
      expect(page2.events.map((e: GguiSessionEvent) => e.seq)).toEqual([3, 4]);
      expect(page2.hasMore).toBe(true);

      const page3 = expectPage(
        await h.handler({ sessionId: SESSION, sinceSequence: 4, limit: 2 }, ctx),
      );
      expect(page3.events.map((e: GguiSessionEvent) => e.seq)).toEqual([5]);
      expect(page3.hasMore).toBe(false);
    });
  });

  describe('limit clamp', () => {
    it(`clamps limit above ${RUNTIME_PULL_MAX_LIMIT} instead of rejecting`, async () => {
      await seedRender(store, { eventCount: RUNTIME_PULL_MAX_LIMIT + 20 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const out = expectPage(
        await h.handler(
          { sessionId: SESSION, sinceSequence: 0, limit: 500 },
          ctx,
        ),
      );
      expect(out.events).toHaveLength(RUNTIME_PULL_MAX_LIMIT);
      expect(out.hasMore).toBe(true);
      expect(out.lastSequence).toBe(RUNTIME_PULL_MAX_LIMIT + 20);
    });

    it(`limit omitted defaults to ${RUNTIME_PULL_MAX_LIMIT}`, async () => {
      await seedRender(store, { eventCount: RUNTIME_PULL_MAX_LIMIT + 1 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const out = expectPage(await h.handler({ sessionId: SESSION }, ctx));
      expect(out.events).toHaveLength(RUNTIME_PULL_MAX_LIMIT);
      expect(out.hasMore).toBe(true);
    });

    it('rejects limit < 1 and negative sinceSequence at the zod boundary', async () => {
      await seedRender(store, { eventCount: 1 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      await expect(
        h.handler({ sessionId: SESSION, limit: 0 }, ctx),
      ).rejects.toThrow();
      await expect(
        h.handler({ sessionId: SESSION, sinceSequence: -1 }, ctx),
      ).rejects.toThrow();
    });
  });

  describe('replay horizon — NORMAL result arm, both directions', () => {
    it('sinceSequence above lastSequence → REPLAY_HORIZON_PASSED with currentSequence', async () => {
      await seedRender(store, { eventCount: 5 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const out = await h.handler(
        { sessionId: SESSION, sinceSequence: 99 },
        ctx,
      );
      expect(out).toEqual({
        reason: 'REPLAY_HORIZON_PASSED',
        currentSequence: 5,
      });
    });

    it('sinceSequence below the retention horizon → REPLAY_HORIZON_PASSED', async () => {
      await seedRender(store, { eventCount: 5 });
      // In-memory keeps full history (horizonSeq=0); overlay a bounded
      // retention window (horizonSeq=3 — seqs 1..3 evicted) on the
      // read path to exercise the eviction direction.
      const horizon = 3;
      const unbounded = store.listEventsSince.bind(store);
      const bounded: typeof store = Object.create(store);
      bounded.listEventsSince = async (id, since, limit) => {
        const r = await unbounded(id, since, limit);
        if (r === null) return null;
        return {
          ...r,
          horizonSeq: horizon,
          events: r.events.filter((e) => e.seq > horizon),
        };
      };
      const h = createGguiRuntimePullHandler({ renderStore: bounded });

      const evicted = await h.handler(
        { sessionId: SESSION, sinceSequence: 2 },
        ctx,
      );
      expect(evicted).toEqual({
        reason: 'REPLAY_HORIZON_PASSED',
        currentSequence: 5,
      });

      // AT the horizon is still replayable (route parity: only
      // sinceSequence < horizonSeq trips the gate — events with
      // seq <= horizonSeq are the evicted ones).
      const atHorizon = expectPage(
        await h.handler({ sessionId: SESSION, sinceSequence: horizon }, ctx),
      );
      expect(atHorizon.events.map((e: GguiSessionEvent) => e.seq)).toEqual([4, 5]);
    });
  });

  describe('alignment with the protocol union (EventsResponse parity)', () => {
    it('flat outputSchema keys are exactly the union of the protocol arms (updateInputSchema posture)', () => {
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const flatKeys = Object.keys(h.outputSchema).sort();
      const armKeys = new Set<string>();
      for (const arm of runtimePullOutputSchema.options) {
        for (const k of Object.keys(arm.shape)) armKeys.add(k);
      }
      expect(flatKeys).toEqual([...armKeys].sort());
    });

    it('a real page output round-trips runtimePullOutputSchema key-for-key', async () => {
      await seedRender(store, { eventCount: 2 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const out = await h.handler({ sessionId: SESSION }, ctx);
      const parsed = runtimePullOutputSchema.parse(out);
      expect(parsed).toEqual(out);
      expect(Object.keys(out).sort()).toEqual(
        ['events', 'hasMore', 'lastSequence'],
      );
    });

    it('a real horizon output round-trips runtimePullOutputSchema key-for-key', async () => {
      await seedRender(store, { eventCount: 1 });
      const h = createGguiRuntimePullHandler({ renderStore: store });
      const out = await h.handler(
        { sessionId: SESSION, sinceSequence: 42 },
        ctx,
      );
      const parsed = runtimePullOutputSchema.parse(out);
      expect(parsed).toEqual(out);
      expect(Object.keys(out).sort()).toEqual(['currentSequence', 'reason']);
    });
  });

  describe('subscription-mode hold (wait — transport-ladder ruling 20)', () => {
    it('wait omitted → immediate empty page, no hold', async () => {
      await seedRender(store, { eventCount: 2 });
      const h = createGguiRuntimePullHandler({
        renderStore: store,
        waitProbeIntervalMs: 10,
      });
      const started = Date.now();
      const out = expectPage(
        await h.handler({ sessionId: SESSION, sinceSequence: 2 }, ctx),
      );
      expect(out.events).toEqual([]);
      expect(out.lastSequence).toBe(2);
      // No hold: resolves well under one probe interval's worth of
      // slack (generous bound to stay flake-free on CI).
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('an empty hold elapses and returns a NORMAL empty page', async () => {
      await seedRender(store, { eventCount: 1 });
      const h = createGguiRuntimePullHandler({
        renderStore: store,
        waitProbeIntervalMs: 10,
      });
      const started = Date.now();
      const out = expectPage(
        await h.handler(
          { sessionId: SESSION, sinceSequence: 1, wait: 0.05 },
          ctx,
        ),
      );
      expect(out.events).toEqual([]);
      expect(out.hasMore).toBe(false);
      // The hold actually held (≥ the 50ms wait, minus timer slop).
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    });

    it('an event landing mid-hold ends the hold early with that event', async () => {
      await seedRender(store, { eventCount: 1 });
      const h = createGguiRuntimePullHandler({
        renderStore: store,
        waitProbeIntervalMs: 10,
      });
      const append = setTimeout(() => {
        void store.appendEvent({
          sessionId: SESSION,
          type: 'ui.updated',
          data: { sessionId: SESSION, props: { fresh: true } },
        });
      }, 30);
      try {
        const started = Date.now();
        const out = expectPage(
          await h.handler(
            { sessionId: SESSION, sinceSequence: 1, wait: 5 },
            ctx,
          ),
        );
        // Ended on the event, nowhere near the 5s hold budget.
        expect(Date.now() - started).toBeLessThan(2000);
        expect(out.events).toHaveLength(1);
        expect(out.events[0]?.type).toBe('ui.updated');
        expect(out.lastSequence).toBe(2);
      } finally {
        clearTimeout(append);
      }
    });

    it('a horizon violation returns immediately even with a hold requested', async () => {
      await seedRender(store, { eventCount: 2 });
      const h = createGguiRuntimePullHandler({
        renderStore: store,
        waitProbeIntervalMs: 10,
      });
      const started = Date.now();
      const out = await h.handler(
        { sessionId: SESSION, sinceSequence: 99, wait: 5 },
        ctx,
      );
      expect('reason' in out && out.reason).toBe('REPLAY_HORIZON_PASSED');
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('schema accepts over-ceiling wait values (handler clamps, tolerant reader)', () => {
      const parsed = runtimePullInputSchema.parse({
        sessionId: 'render_x',
        wait: 999,
      });
      expect(parsed.wait).toBe(999);
      expect(RUNTIME_PULL_MAX_WAIT_SECONDS).toBe(20);
    });
  });
});
