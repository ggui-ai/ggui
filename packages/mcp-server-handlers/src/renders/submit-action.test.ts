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
import { describe, it, expect } from 'vitest';
import {
  InMemoryActiveConsumerRegistry,
  InMemoryPendingEventConsumer,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiSubmitActionHandler } from './submit-action.js';

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
});
