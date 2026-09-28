/**
 * Pins the action envelope shape the `ggui_runtime_submit_action`
 * handler accepts. The shape comes from
 * `@ggui-ai/protocol/integrations/mcp-apps::GguiSubmitActionInput`,
 * the canonical contract — these tests catch handler drift if a
 * future edit accidentally widens or narrows shape independently.
 *
 * Post-Phase-B (flatten-render-identity): the wire input collapsed
 * from `{sessionId, stackItemId, appId, …}` to `{sessionId, appId, …}`.
 * The pending-events pipe is keyed by `sessionId`.
 *
 * Empirically critical: the iframe-runtime `emitAudit` helper posts
 * EXACTLY these envelopes via `tools/call`, and a shape mismatch
 * would silently swallow every gesture audit on production hosts
 * (claude.ai, Claude Desktop) because the rejection round-trip is
 * fail-soft client-side.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  ACTIVE_CONSUMER_EXIT_RETENTION_MS,
  InMemoryActiveConsumerRegistry,
  InMemoryGguiSessionStore,
  InMemoryPendingEventConsumer,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { GguiSessionStore, PendingEventConsumer } from '@ggui-ai/mcp-server-core';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import {
  createGguiSubmitActionHandler,
  RECENT_CONSUMER_EXIT_MS,
  YOUNG_RENDER_MS,
} from './submit-action.js';

const baseEnv = {
  sessionId: 'sess_1',
  appId: 'app_1',
  actionId: 'a3f2b1d4',
  firedAt: '2026-05-07T10:00:00.000Z',
};

const ctx = {
  appId: 'app_1',
  requestId: 'req_1',
} as unknown as Parameters<
  ReturnType<typeof createGguiSubmitActionHandler>['handler']
>[1];

describe('createGguiSubmitActionHandler', () => {
  it('registers as app-visible per spec §401 (iframe-only callable)', () => {
    const h = createGguiSubmitActionHandler();
    const meta = h._meta as
      | { ui?: { visibility?: readonly string[] } }
      | undefined;
    expect(meta?.ui?.visibility).toEqual(['app']);
  });

  describe('accepts canonical action envelopes', () => {
    it('appends a dispatch envelope to the pipe (verified via consume)', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      const sessionId = 'render-dispatch-1';
      await consumer.markCreated(sessionId);
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
      });
      const out = await h.handler(
        {
          ...baseEnv,
          sessionId,
          kind: 'dispatch',
          payload: {
            intent: 'submit',
            actionData: { title: 'Team sync' },
            uiContext: { draft: 'wip' },
          },
        },
        ctx,
      );
      // Post-2026-05-13 trim: output is the lean `{ ok: true }` only.
      // The kind/payload/actionId echoes were retired (iframe-runtime
      // reads ok/code only; the envelope state is observable through
      // the pipe drain below).
      expect(out).toEqual({ ok: true });
      const drained = await consumer.consumeAndClear(sessionId, 100);
      expect(drained.events.length).toBe(1);
      expect(drained.events[0]?.envelope).toMatchObject({
        type: 'action',
        sessionId,
        intent: 'submit',
        actionData: { title: 'Team sync' },
        uiContext: { draft: 'wip' },
        actionId: baseEnv.actionId,
      });
    });

    it('accepts an openLink envelope', async () => {
      const h = createGguiSubmitActionHandler();
      const out = await h.handler(
        { ...baseEnv, kind: 'openLink', payload: { url: 'https://example.com' } },
        ctx,
      );
      expect(out).toEqual({ ok: true });
    });

    it('accepts a requestDisplayMode envelope', async () => {
      const h = createGguiSubmitActionHandler();
      const out = await h.handler(
        { ...baseEnv, kind: 'requestDisplayMode', payload: { mode: 'fullscreen' } },
        ctx,
      );
      expect(out).toEqual({ ok: true });
    });

    it('accepts an extension `kind` (forward-compat slot)', async () => {
      const h = createGguiSubmitActionHandler();
      const out = await h.handler(
        { ...baseEnv, kind: 'futureGesture', payload: { foo: 'bar' } },
        ctx,
      );
      expect(out).toEqual({ ok: true });
    });
  });

  describe('declares CONTRACT_VIOLATION on the advertised output (#1358 step 1 — declared, not yet emitted)', () => {
    it('the closed output schema names the code and the `violations` member, so a host that caches it accepts the gate\'s answer next release', () => {
      const h = createGguiSubmitActionHandler();
      const projected = z.toJSONSchema(z.object(h.outputSchema), { io: 'output' });
      // The parse IS the assertion: the object is closed (#1333), the enum
      // carries the new code beside the two it had, and `violations` is an
      // array of the protocol's ContractViolation shape.
      z.object({
        additionalProperties: z.literal(false),
        properties: z.object({
          code: z.object({ enum: z.tuple([z.literal('INVALID_ACTION_KIND'), z.literal('PIPE_NOT_FOUND'), z.literal('CONTRACT_VIOLATION')]) }),
          violations: z.object({
            type: z.literal('array'),
            items: z.object({
              properties: z.object({ field: z.object({ type: z.literal('string') }), message: z.object({ type: z.literal('string') }) }),
            }),
          }),
        }),
      }).parse(projected);
    });
  });

  describe('rejects malformed envelopes with INVALID_ACTION_KIND', () => {
    it.each([
      ['missing kind', { ...baseEnv, payload: { url: 'x' } }],
      ['missing payload', { ...baseEnv, kind: 'openLink' }],
      ['missing actionId', { kind: 'openLink', payload: { url: 'x' }, sessionId: 'r', appId: 'a', firedAt: 't' }],
      [
        'dispatch missing intent',
        { ...baseEnv, kind: 'dispatch', payload: { actionData: {}, uiContext: {} } },
      ],
      [
        'openLink with non-string url',
        { ...baseEnv, kind: 'openLink', payload: { url: 42 } },
      ],
    ])('rejects %s', async (_label, input) => {
      const h = createGguiSubmitActionHandler();
      const out = await h.handler(input as Parameters<typeof h.handler>[0], ctx);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected ok:false');
      expect(out.code).toBe('INVALID_ACTION_KIND');
      expect(out.message).toMatch(/action envelope rejected/);
    });
  });

  describe('PIPE_NOT_FOUND fail-loud cases (2026-05-13 silent-drop fix)', () => {
    // Pre-fix: every one of these returned `ok:true` without appending.
    // The iframe-runtime's dispatch closure saw success and skipped the
    // `ui/message` fallback. The agent's `ggui_consume` long-poll waited
    // for events that would never arrive, and claude.ai eventually
    // canceled the request with a generic transport error. The user
    // saw "Error occurred during tool execution" with no recovery path.
    // Surfacing PIPE_NOT_FOUND here lets the iframe-runtime observe a
    // non-success outcome and post `ui/message` so the gesture reaches
    // the chat surface on the next turn.

    it('rejects kind:dispatch when no pendingEventConsumer is wired — surfaces PIPE_NOT_FOUND', async () => {
      const h = createGguiSubmitActionHandler();
      const out = await h.handler(
        {
          ...baseEnv,
          kind: 'dispatch',
          payload: { intent: 'submit', actionData: null, uiContext: {} },
        },
        ctx,
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected ok:false');
      expect(out.code).toBe('PIPE_NOT_FOUND');
      expect(out.message).toMatch(/no pending-events consumer/);
    });

    it('rejects kind:dispatch when pipe was never markCreated (render closed / never opened)', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      // Intentionally NOT calling markCreated — the pipe is absent.
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
      });
      const out = await h.handler(
        {
          ...baseEnv,
          sessionId: 'orphan-render',
          kind: 'dispatch',
          payload: { intent: 'submit', actionData: null, uiContext: {} },
        },
        ctx,
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected ok:false');
      expect(out.code).toBe('PIPE_NOT_FOUND');
    });

    it('openLink + requestDisplayMode still pass without a pipe (no pipe-append for those kinds)', async () => {
      const h = createGguiSubmitActionHandler();
      const openLink = await h.handler(
        {
          ...baseEnv,
          kind: 'openLink',
          payload: { url: 'https://example.com' },
        },
        ctx,
      );
      expect(openLink.ok).toBe(true);
      const requestMode = await h.handler(
        { ...baseEnv, kind: 'requestDisplayMode', payload: { mode: 'fullscreen' } },
        ctx,
      );
      expect(requestMode.ok).toBe(true);
    });
  });

  describe('consumerPresent on successful dispatch (active-consumer awareness)', () => {
    it('omits consumerPresent when no activeConsumerRegistry is wired', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      const sessionId = 'render-no-registry';
      await consumer.markCreated(sessionId);
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
      });
      const out = await h.handler(
        {
          ...baseEnv,
          sessionId,
          kind: 'dispatch',
          payload: { intent: 'submit', actionData: null, uiContext: {} },
        },
        ctx,
      );
      // Graceful-degrade: without the seam wired the field MUST be
      // absent so the iframe falls back to its 10s claim timer.
      expect(out).toEqual({ ok: true });
    });

    it('reports consumerPresent:false when registry has no entry for the render', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      const sessionId = 'render-no-consumer';
      await consumer.markCreated(sessionId);
      const registry = new InMemoryActiveConsumerRegistry();
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
        activeConsumerRegistry: registry,
        // Tiny grace so the no-consumer case resolves fast in tests —
        // production default is 800ms (doorbell-race window).
        consumerGraceMs: 50,
      });
      const out = await h.handler(
        {
          ...baseEnv,
          sessionId,
          kind: 'dispatch',
          payload: { intent: 'submit', actionData: null, uiContext: {} },
        },
        ctx,
      );
      expect(out).toEqual({ ok: true, consumerPresent: false });
    });

    it('ADAPTIVE: a recent consumer exit arms the long window — a re-poll parking inside flips true', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      const sessionId = 'render-adaptive-midloop';
      await consumer.markCreated(sessionId);
      const registry = new InMemoryActiveConsumerRegistry();
      // Simulate the mid-loop shape: a consume just completed.
      registry.enter(sessionId);
      registry.exit(sessionId);
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
        activeConsumerRegistry: registry,
        // NO consumerGraceMs — the adaptive policy decides.
      });
      const park = setTimeout(() => registry.enter(sessionId), 300);
      try {
        const out = await h.handler(
          {
            ...baseEnv,
            sessionId,
            kind: 'dispatch',
            payload: { intent: 'submit', actionData: null, uiContext: {} },
          },
          ctx,
        );
        expect(out).toEqual({ ok: true, consumerPresent: true });
      } finally {
        clearTimeout(park);
      }
    });

    it('ADAPTIVE: no consumer ever seen + no render row → fast false (idle-card arm, well under the long window)', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      const sessionId = 'render-adaptive-idle';
      await consumer.markCreated(sessionId);
      const registry = new InMemoryActiveConsumerRegistry();
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
        activeConsumerRegistry: registry,
        // No renderStore → age unknown → fast-answer arm (150ms).
      });
      const started = Date.now();
      const out = await h.handler(
        {
          ...baseEnv,
          sessionId,
          kind: 'dispatch',
          payload: { intent: 'submit', actionData: null, uiContext: {} },
        },
        ctx,
      );
      expect(out).toEqual({ ok: true, consumerPresent: false });
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('a consumer parking INSIDE the grace window flips the answer to true (doorbell race, live 2026-08-12)', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      const sessionId = 'render-grace-race';
      await consumer.markCreated(sessionId);
      const registry = new InMemoryActiveConsumerRegistry();
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
        activeConsumerRegistry: registry,
        consumerGraceMs: 800,
      });
      // The live race shape: the agent's consume parks ~380ms after
      // the click. No consumer at submit time; one arrives mid-window.
      const park = setTimeout(() => registry.enter(sessionId), 150);
      try {
        const out = await h.handler(
          {
            ...baseEnv,
            sessionId,
            kind: 'dispatch',
            payload: { intent: 'submit', actionData: null, uiContext: {} },
          },
          ctx,
        );
        expect(out).toEqual({ ok: true, consumerPresent: true });
      } finally {
        clearTimeout(park);
      }
    });

    it('reports consumerPresent:true when a consumer is currently registered for the render', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      const sessionId = 'render-with-consumer';
      await consumer.markCreated(sessionId);
      const registry = new InMemoryActiveConsumerRegistry();
      registry.enter(sessionId);
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
        activeConsumerRegistry: registry,
      });
      const out = await h.handler(
        {
          ...baseEnv,
          sessionId,
          kind: 'dispatch',
          payload: { intent: 'submit', actionData: null, uiContext: {} },
        },
        ctx,
      );
      expect(out).toEqual({ ok: true, consumerPresent: true });
    });

    it('isolates consumer presence by sessionId', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      await consumer.markCreated('render-A');
      await consumer.markCreated('render-B');
      const registry = new InMemoryActiveConsumerRegistry();
      registry.enter('render-A'); // Only A has a consumer.
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
        activeConsumerRegistry: registry,
        consumerGraceMs: 50,
      });
      const outA = await h.handler(
        {
          ...baseEnv,
          sessionId: 'render-A',
          kind: 'dispatch',
          payload: { intent: 'submit', actionData: null, uiContext: {} },
        },
        ctx,
      );
      const outB = await h.handler(
        {
          ...baseEnv,
          sessionId: 'render-B',
          kind: 'dispatch',
          payload: { intent: 'submit', actionData: null, uiContext: {} },
        },
        ctx,
      );
      expect(outA).toEqual({ ok: true, consumerPresent: true });
      expect(outB).toEqual({ ok: true, consumerPresent: false });
    });
  });

  it('returns the lean ok-or-reject discriminated shape', async () => {
    const h = createGguiSubmitActionHandler();
    const ok = await h.handler(
      { ...baseEnv, kind: 'openLink', payload: { url: 'https://example.com' } },
      ctx,
    );
    expect(ok).toEqual({ ok: true });

    const rejected = await h.handler(
      { ...baseEnv } as Parameters<typeof h.handler>[0],
      ctx,
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('expected reject');
    expect(rejected.code).toBe('INVALID_ACTION_KIND');
    expect(typeof rejected.message).toBe('string');
  });

  // ggui#1479 — a dispatch writes only to a session of the caller's own app.
  describe("writes only to a session the caller's app owns (ggui#1479)", () => {
    const sessionId = 'render-owned-by-app_1';
    const card: ComponentGguiSession = {
      type: 'component',
      id: sessionId,
      appId: 'app_1',
      componentCode: '/* card */',
      eventSequence: 0,
      createdAt: 0,
      lastActivityAt: 0,
      expiresAt: 0,
      epoch: 1,
      actionSpec: { confirm: { label: 'Confirm', oneShot: true } },
    };
    const dispatch = {
      ...baseEnv,
      sessionId,
      kind: 'dispatch' as const,
      payload: { intent: 'confirm', actionData: null, uiContext: {} },
    };
    const otherAppCtx = { ...ctx, appId: 'app_other' };

    it("answers another app's credential exactly as it answers a session that does not exist, and writes nothing", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consumer = new InMemoryPendingEventConsumer();
      await consumer.markCreated(sessionId);
      const store = new InMemoryGguiSessionStore();
      await store.commit({ appId: 'app_1', render: card });
      const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store });
      const crossApp = await h.handler(dispatch, otherAppCtx);

      const absent = createGguiSubmitActionHandler({
        pendingEventConsumer: new InMemoryPendingEventConsumer(),
        renderStore: new InMemoryGguiSessionStore(),
      });
      const missing = await absent.handler(dispatch, otherAppCtx);
      expect(missing).toMatchObject({ ok: false, code: 'PIPE_NOT_FOUND' });
      expect(crossApp).toEqual(missing);

      expect((await consumer.consumeAndClear(sessionId, 50)).events).toHaveLength(0);
      expect((await store.listEventsSince(sessionId, 0, 10))?.events ?? []).toHaveLength(0);
      const got = await store.get(sessionId);
      expect(got?.render.type === 'component' ? got.render.spentOneShots : undefined).toBeUndefined();
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[ggui] runtime_cross_app_refused '));
      expect(line).toBeDefined();
      expect(JSON.parse(String(line).slice('[ggui] runtime_cross_app_refused '.length))).toEqual({
        tool: 'ggui_runtime_submit_action',
        sessionId,
        callerAppId: 'app_other',
        ownerAppId: 'app_1',
      });
      warn.mockRestore();
    });

    it("fails closed on a MISSING row: a foreign caller whose target's pipe still accepts appends gets PIPE_NOT_FOUND and nothing is appended", async () => {
      const consumer = new InMemoryPendingEventConsumer();
      await consumer.markCreated(sessionId);
      const store = new InMemoryGguiSessionStore();
      const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store });
      const out = await h.handler(dispatch, otherAppCtx);
      expect(out).toMatchObject({ ok: false, code: 'PIPE_NOT_FOUND' });
      expect((await consumer.consumeAndClear(sessionId, 50)).events).toHaveLength(0);
    });

    it("fails closed on a store that THROWS: PIPE_NOT_FOUND, nothing appended, and the refusal is named", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const consumer = new InMemoryPendingEventConsumer();
      await consumer.markCreated(sessionId);
      const store = new InMemoryGguiSessionStore();
      await store.commit({ appId: 'app_1', render: card });
      vi.spyOn(store, 'get').mockRejectedValue(new Error('throttled'));
      const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store });
      const out = await h.handler(dispatch, otherAppCtx);
      expect(out).toMatchObject({ ok: false, code: 'PIPE_NOT_FOUND' });
      expect((await consumer.consumeAndClear(sessionId, 50)).events).toHaveLength(0);
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[ggui] runtime_ownership_unverified '));
      expect(line).toBeDefined();
      expect(JSON.parse(String(line).slice('[ggui] runtime_ownership_unverified '.length))).toEqual({
        tool: 'ggui_runtime_submit_action',
        sessionId,
        callerAppId: 'app_other',
        reason: 'read-failed',
      });
      warn.mockRestore();
    });

    it("still pipes a dispatch from the session's own app (control)", async () => {
      const consumer = new InMemoryPendingEventConsumer();
      await consumer.markCreated(sessionId);
      const store = new InMemoryGguiSessionStore();
      await store.commit({ appId: 'app_1', render: card });
      const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store });
      expect(await h.handler(dispatch, ctx)).toEqual({ ok: true });
      expect((await consumer.consumeAndClear(sessionId, 50)).events).toHaveLength(1);
    });
  });

  // ggui#1358 step 2 — the relay validates `actionData` against the card's
  // `actionSpec` at receipt, exactly as the WebSocket ingress does. A failing
  // dispatch is answered CONTRACT_VIOLATION and never reaches the pipe, the
  // ledger, or the one-shot spend.
  describe('validates actionData against the card\'s actionSpec at receipt (#1358 step 2)', () => {
    const sessionId = 'render-gated-1';
    const gatedCard: ComponentGguiSession = {
      type: 'component',
      id: sessionId,
      appId: 'app_1',
      componentCode: '/* card */',
      eventSequence: 0,
      createdAt: 0,
      lastActivityAt: 0,
      expiresAt: 0,
      epoch: 1,
      actionSpec: {
        confirm: {
          label: 'Confirm',
          oneShot: true,
          schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
      },
    };
    const dispatchWith = (intent: string, actionData: unknown) => ({
      ...baseEnv,
      sessionId,
      kind: 'dispatch' as const,
      payload: { intent, actionData, uiContext: {} },
    });
    async function boot() {
      const consumer = new InMemoryPendingEventConsumer();
      await consumer.markCreated(sessionId);
      const store = new InMemoryGguiSessionStore();
      await store.commit({ appId: 'app_1', render: gatedCard });
      const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store });
      return { consumer, store, h };
    }

    it('answers CONTRACT_VIOLATION with the violations when actionData fails the declared schema, and writes nothing', async () => {
      const { consumer, store, h } = await boot();
      const out = await h.handler(dispatchWith('confirm', { id: 42 }), ctx);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected a refusal');
      expect(out.code).toBe('CONTRACT_VIOLATION');
      expect(typeof out.message).toBe('string');
      expect(out.violations?.length ?? 0).toBeGreaterThan(0);
      expect(out.violations?.[0]).toMatchObject({ field: expect.any(String), message: expect.any(String) });
      // Nothing reached the pipe, the ledger, or the spend record.
      expect((await consumer.consumeAndClear(sessionId, 50)).events).toHaveLength(0);
      const ledger = await store.listEventsSince(sessionId, 0, 10);
      expect(ledger?.events ?? []).toHaveLength(0);
      const got = await store.get(sessionId);
      expect(got?.render.type === 'component' ? got.render.spentOneShots : undefined).toBeUndefined();
    });

    it('answers CONTRACT_VIOLATION for an action the card never declared', async () => {
      const { consumer, h } = await boot();
      const out = await h.handler(dispatchWith('nope', null), ctx);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected a refusal');
      expect(out.code).toBe('CONTRACT_VIOLATION');
      expect((await consumer.consumeAndClear(sessionId, 50)).events).toHaveLength(0);
    });

    it('accepts a dispatch that satisfies the schema, pipes it, and spends the oneShot (control)', async () => {
      const { consumer, store, h } = await boot();
      expect(await h.handler(dispatchWith('confirm', { id: 'x' }), ctx)).toEqual({ ok: true });
      expect((await consumer.consumeAndClear(sessionId, 50)).events).toHaveLength(1);
      const got = await store.get(sessionId);
      expect(got?.render.type === 'component' ? got.render.spentOneShots : undefined).toEqual({ epoch: 1, actions: ['confirm'] });
    });

    it('does not gate when the card declares no actionSpec (nothing to enforce, as on the live channel)', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      await consumer.markCreated(sessionId);
      const store = new InMemoryGguiSessionStore();
      const { actionSpec: _dropped, ...noSpec } = gatedCard;
      await store.commit({ appId: 'app_1', render: noSpec });
      const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store });
      expect(await h.handler(dispatchWith('anything', { free: true }), ctx)).toEqual({ ok: true });
    });
  });

  // ggui#1223 / #1305 — a pipe-committed dispatch of a `oneShot` action spends
  // its card durably, so a re-served card renders it spent after a reload.
  describe('the committed oneShot spend (#1305)', () => {
    const sessionId = 'render-oneshot-1';
    const oneShotCard: ComponentGguiSession = {
      type: 'component',
      id: sessionId,
      appId: 'app_1',
      componentCode: '/* card */',
      eventSequence: 0,
      createdAt: 0,
      lastActivityAt: 0,
      expiresAt: 0,
      epoch: 1,
      actionSpec: { submit: { label: 'Submit', oneShot: true } },
    };
    const dispatch = {
      ...baseEnv,
      sessionId,
      kind: 'dispatch' as const,
      payload: { intent: 'submit', actionData: null, uiContext: {} },
    };

    it('records the spend on the head card after the pipe append', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      await consumer.markCreated(sessionId);
      const store = new InMemoryGguiSessionStore();
      await store.commit({ appId: 'app_1', render: oneShotCard });
      const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store });
      expect(await h.handler(dispatch, ctx)).toEqual({ ok: true });
      const got = await store.get(sessionId);
      expect(got?.render.type === 'component' ? got.render.spentOneShots : undefined).toEqual({
        epoch: 1,
        actions: ['submit'],
      });
    });

    it('fails OPEN: a store that cannot record still answers ok and names the failure on one warn line', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      await consumer.markCreated(sessionId);
      const inner = new InMemoryGguiSessionStore();
      await inner.commit({ appId: 'app_1', render: oneShotCard });
      const failing: GguiSessionStore = {
        create: (i) => inner.create(i),
        get: (id) => inner.get(id),
        list: (f) => inner.list(f),
        update: (id, p) => inner.update(id, p),
        delete: (id) => inner.delete(id),
        commit: (i) => inner.commit(i),
        appendEvent: (i) => inner.appendEvent(i),
        listEventsSince: (id, since, limit) => inner.listEventsSince(id, since, limit),
        observe: (id, o) => inner.observe(id, o),
        recordSpentOneShot: async (): Promise<void> => {
          throw new Error('store down');
        },
      };
      const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
        renderStore: failing,
        logger: { warn: (msg, data) => warnings.push({ msg, data }) },
      });
      expect(await h.handler(dispatch, ctx)).toEqual({ ok: true });
      expect(warnings).toEqual([
        {
          msg: 'submit_action_spent_oneshot_persist_failed',
          data: { sessionId, action: 'submit', error: 'store down' },
        },
      ]);
      const drained = await consumer.consumeAndClear(sessionId, 100);
      expect(drained.events.length).toBe(1);
    });
  });

  // ggui#1517 — a relay that lost the response retries the same dispatch.
  // The pipe dedupes by `(sessionId, actionId)`; the ledger row is the one
  // effect that is not idempotent, so it is the one a duplicate skips. The
  // spend is idempotent and is re-applied, which closes the window where the
  // original appended and died before spending.
  describe('a retried dispatch (same actionId) is one gesture (ggui#1517)', () => {
    const sessionId = 'render-retry-1';
    const card: ComponentGguiSession = {
      type: 'component',
      id: sessionId,
      appId: 'app_1',
      componentCode: '/* card */',
      eventSequence: 0,
      createdAt: 0,
      lastActivityAt: 0,
      expiresAt: 0,
      epoch: 1,
      actionSpec: { submit: { label: 'Submit', oneShot: true } },
    };
    const dispatch = {
      ...baseEnv,
      sessionId,
      kind: 'dispatch' as const,
      payload: { intent: 'submit', actionData: null, uiContext: {} },
    };

    async function ledgerRows(store: InMemoryGguiSessionStore): Promise<number> {
      const page = await store.listEventsSince(sessionId, 0, 100);
      return (page?.events ?? []).filter((e) => e.type === 'user.submitted').length;
    }

    async function spentOf(store: InMemoryGguiSessionStore) {
      const got = await store.get(sessionId);
      return got?.render.type === 'component' ? got.render.spentOneShots : undefined;
    }

    it('answers ok both times, writes ONE ledger row and ONE pipe entry, and names the repeat', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      consumer.markCreated(sessionId);
      const store = new InMemoryGguiSessionStore();
      await store.commit({ appId: 'app_1', render: card });
      const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: consumer,
        renderStore: store,
        logger: { warn: (msg, data) => warnings.push({ msg, data }) },
      });
      expect(await h.handler(dispatch, ctx)).toEqual({ ok: true });
      expect(await h.handler(dispatch, ctx)).toEqual({ ok: true });
      expect(await ledgerRows(store)).toBe(1);
      expect((await consumer.consumeAndClear(sessionId, 100)).events.length).toBe(1);
      expect(await spentOf(store)).toEqual({ epoch: 1, actions: ['submit'] });
      expect(warnings).toEqual([
        { msg: 'submit_action_duplicate_dispatch', data: { sessionId, actionId: baseEnv.actionId } },
      ]);
    });

    it('re-applies the spend on a duplicate: an original that appended and died before spending is spent by its retry', async () => {
      const consumer = new InMemoryPendingEventConsumer();
      consumer.markCreated(sessionId);
      const store = new InMemoryGguiSessionStore();
      await store.commit({ appId: 'app_1', render: card });
      // The original's append landed; its ledger write and spend never ran.
      await consumer.append(sessionId, {
        id: baseEnv.actionId,
        envelope: {
          type: 'action',
          sessionId,
          intent: 'submit',
          actionData: null,
          uiContext: {},
          actionId: baseEnv.actionId,
          firedAt: baseEnv.firedAt,
        },
        createdAt: baseEnv.firedAt,
      });
      const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store });
      expect(await h.handler(dispatch, ctx)).toEqual({ ok: true });
      expect(await spentOf(store)).toEqual({ epoch: 1, actions: ['submit'] });
      expect(await ledgerRows(store)).toBe(0);
      expect((await consumer.consumeAndClear(sessionId, 100)).events.length).toBe(1);
    });

    it('an adapter written against the pre-outcome port (append returns nothing) gets the ledger and the spend on every call', async () => {
      const inner = new InMemoryPendingEventConsumer();
      inner.markCreated(sessionId);
      const preOutcome: PendingEventConsumer = {
        consumeAndClear: (id, ttlMs) => inner.consumeAndClear(id, ttlMs),
        append: async (id, event): Promise<void> => {
          await inner.append(id, event);
        },
      };
      const store = new InMemoryGguiSessionStore();
      await store.commit({ appId: 'app_1', render: card });
      const warnings: Array<{ msg: string; data?: Record<string, unknown> }> = [];
      const h = createGguiSubmitActionHandler({
        pendingEventConsumer: preOutcome,
        renderStore: store,
        logger: { warn: (msg, data) => warnings.push({ msg, data }) },
      });
      expect(await h.handler(dispatch, ctx)).toEqual({ ok: true });
      expect(await h.handler(dispatch, ctx)).toEqual({ ok: true });
      // No outcome is read as 'appended': today's behaviour, never a suppression.
      expect(await ledgerRows(store)).toBe(2);
      expect(await spentOf(store)).toEqual({ epoch: 1, actions: ['submit'] });
      expect(warnings).toEqual([]);
    });
  });
});

describe('the grace choice and the consumer registry\'s exit retention (ggui#1485)', () => {
  async function seededStore(sessionId: string, createdAt: number): Promise<InMemoryGguiSessionStore> {
    const store = new InMemoryGguiSessionStore();
    const render: ComponentGguiSession = {
      type: 'component',
      id: sessionId,
      appId: 'app_1',
      componentCode: '/* card */',
      eventSequence: 0,
      createdAt,
      lastActivityAt: createdAt,
      expiresAt: Date.UTC(2100, 0, 1),
    };
    await store.commit({ appId: 'app_1', render });
    return store;
  }

  it('the registry retains an exit at least as long as either window the grace compares against', () => {
    expect(ACTIVE_CONSUMER_EXIT_RETENTION_MS).toBeGreaterThanOrEqual(Math.max(RECENT_CONSUMER_EXIT_MS, YOUNG_RENDER_MS));
  });

  it('reads the render\'s age off the gate\'s own row: one store read per dispatch, and a young render still gets the long window', async () => {
    const consumer = new InMemoryPendingEventConsumer();
    const sessionId = 'render-grace-young';
    await consumer.markCreated(sessionId);
    const store = await seededStore(sessionId, Date.now() - 1_000);
    const get = vi.spyOn(store, 'get');
    const registry = new InMemoryActiveConsumerRegistry();
    const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, activeConsumerRegistry: registry, renderStore: store });
    // A consume parking at 300 ms is inside the young-render window (2 s) and outside the idle one (150 ms).
    const park = setTimeout(() => registry.enter(sessionId), 300);
    try {
      const out = await h.handler(
        { ...baseEnv, sessionId, kind: 'dispatch', payload: { intent: 'submit', actionData: null, uiContext: {} } },
        ctx,
      );
      expect(out).toEqual({ ok: true, consumerPresent: true });
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(park);
    }
  });

  it('an old render with no exit on record gets the short window, from the same single read', async () => {
    const consumer = new InMemoryPendingEventConsumer();
    const sessionId = 'render-grace-old';
    await consumer.markCreated(sessionId);
    const store = await seededStore(sessionId, Date.now() - 2 * YOUNG_RENDER_MS);
    const get = vi.spyOn(store, 'get');
    const h = createGguiSubmitActionHandler({
      pendingEventConsumer: consumer,
      activeConsumerRegistry: new InMemoryActiveConsumerRegistry(),
      renderStore: store,
    });
    const started = Date.now();
    const out = await h.handler(
      { ...baseEnv, sessionId, kind: 'dispatch', payload: { intent: 'submit', actionData: null, uiContext: {} } },
      ctx,
    );
    expect(out).toEqual({ ok: true, consumerPresent: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
