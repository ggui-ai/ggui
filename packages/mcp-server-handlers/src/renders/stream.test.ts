/**
 * Tests for `createGguiEmitHandler`.
 *
 * Post-Phase-B (flatten-render-identity): the wire input collapsed
 * from `{sessionId, channel, payload, complete?, stackItemId?}` to
 * `{renderId, channel, payload, complete?}`. `SessionStore` →
 * `RenderStore`. `SessionNotFoundError` → `RenderNotFoundError`.
 *
 * Focused on the factory's wrapping concerns: tenancy gate, the
 * sendEnvelope seam wiring, and the optional observer fan-out.
 * The underlying validation (channel resolution, payload schema,
 * mode derivation, complete-on-non-completable) lives in
 * `handleStream` and is pinned by `handle-stream.test.ts`; this
 * suite checks the factory plumbing, not the helper internals.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentRender } from '@ggui-ai/protocol';
import { InMemoryRenderStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiEmitHandler,
  type StreamObserverNotifier,
} from './stream.js';
import { RenderNotFoundError } from './errors.js';
import type { SendEnvelopeFn } from './handle-stream.js';

const CTX = { appId: 'app-1', requestId: 'r1' };
const NOW_MS = Date.parse('2026-05-11T00:00:00.000Z');

async function seedRender(
  store: InMemoryRenderStore,
  opts: { renderId?: string; appId?: string; streamSpec?: ComponentRender['streamSpec'] } = {},
): Promise<{ renderId: string }> {
  const renderId = opts.renderId ?? 'render-1';
  const appId = opts.appId ?? 'app-1';
  const render: ComponentRender = {
    id: renderId,
    appId,
    type: 'component',
    componentCode: '',
    contentType: 'application/javascript+react',
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
    ...(opts.streamSpec ? { streamSpec: opts.streamSpec } : {}),
  };
  await store.commit({ render, appId });
  return { renderId };
}

describe('createGguiEmitHandler', () => {
  let renderStore: InMemoryRenderStore;

  beforeEach(() => {
    renderStore = new InMemoryRenderStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_emit name + agent audience', () => {
      const handler = createGguiEmitHandler({
        renderStore,
        sendEnvelope: async () => ({}),
      });
      expect(handler.name).toBe('ggui_emit');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('routes through handleStream + sendEnvelope, returns accepted', async () => {
      const { renderId } = await seedRender(renderStore, {
        streamSpec: {
          updates: {
            mode: 'replace',
            schema: {
              type: 'object',
              properties: { tick: { type: 'number' } },
            },
          },
        },
      });
      const sent: unknown[] = [];
      const sendEnvelope: SendEnvelopeFn = async (envelope) => {
        sent.push(envelope);
        return { seq: 42 };
      };
      const handler = createGguiEmitHandler({
        renderStore,
        sendEnvelope,
      });
      const out = await handler.handler(
        {
          renderId,
          channel: 'updates',
          payload: { tick: 1 },
        },
        CTX,
      );
      expect(out.accepted).toBe(true);
      expect(out.seq).toBe(42);
      expect(sent).toHaveLength(1);
      expect((sent[0] as { channel: string }).channel).toBe('updates');
    });
  });

  describe('tenancy + missing', () => {
    it('cross-tenant render throws RenderNotFoundError (no leak)', async () => {
      const { renderId } = await seedRender(renderStore);
      const handler = createGguiEmitHandler({
        renderStore,
        sendEnvelope: async () => ({}),
      });
      await expect(
        handler.handler(
          { renderId, channel: 'updates', payload: {} },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(RenderNotFoundError);
    });

    it('unknown render throws RenderNotFoundError', async () => {
      const handler = createGguiEmitHandler({
        renderStore,
        sendEnvelope: async () => ({}),
      });
      await expect(
        handler.handler(
          { renderId: 'never', channel: 'updates', payload: {} },
          CTX,
        ),
      ).rejects.toBeInstanceOf(RenderNotFoundError);
    });

    it('sendEnvelope NOT invoked when tenancy gate rejects', async () => {
      const { renderId } = await seedRender(renderStore);
      const sent: unknown[] = [];
      const handler = createGguiEmitHandler({
        renderStore,
        sendEnvelope: async (e) => {
          sent.push(e);
          return {};
        },
      });
      await expect(
        handler.handler(
          { renderId, channel: 'updates', payload: {} },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(RenderNotFoundError);
      expect(sent).toHaveLength(0);
    });
  });

  describe('observer notifier seam', () => {
    it('fires after successful emission with appId + channel + complete + accepted', async () => {
      const { renderId } = await seedRender(renderStore, {
        streamSpec: {
          updates: {
            mode: 'append',
            schema: {
              type: 'object',
              properties: { x: { type: 'number' } },
            },
            complete: true,
          },
        },
      });
      const calls: Parameters<StreamObserverNotifier['notifyToolCall']>[0][] = [];
      const handler = createGguiEmitHandler({
        renderStore,
        sendEnvelope: async () => ({ seq: 1 }),
        observerNotifier: {
          notifyToolCall: (args) => {
            calls.push(args);
          },
        },
      });
      await handler.handler(
        {
          renderId,
          channel: 'updates',
          payload: { x: 1 },
          complete: true,
        },
        CTX,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        appId: 'app-1',
        renderId,
        channel: 'updates',
        hasPayload: true,
        complete: true,
        accepted: true,
      });
    });

    it('observer throw is swallowed — emission still succeeds', async () => {
      const { renderId } = await seedRender(renderStore, {
        streamSpec: {
          updates: {
            mode: 'replace',
            schema: {
              type: 'object',
              properties: { v: { type: 'number' } },
            },
          },
        },
      });
      const handler = createGguiEmitHandler({
        renderStore,
        sendEnvelope: async () => ({ seq: 7 }),
        observerNotifier: {
          notifyToolCall: () => {
            throw new Error('observer exploded');
          },
        },
      });
      const out = await handler.handler(
        { renderId, channel: 'updates', payload: { v: 1 } },
        CTX,
      );
      expect(out.accepted).toBe(true);
      expect(out.seq).toBe(7);
    });
  });
});
