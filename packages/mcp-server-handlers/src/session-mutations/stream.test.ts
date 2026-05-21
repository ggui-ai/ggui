/**
 * Tests for `createGguiEmitHandler` — Phase 2.4 part 4.
 *
 * Focused on the factory's wrapping concerns: tenancy gate, the
 * sendEnvelope seam wiring, and the optional observer fan-out.
 * The underlying validation (channel resolution, payload schema,
 * mode derivation, complete-on-non-completable) lives in
 * `handleStream` and is pinned by `handle-stream.test.ts`; this
 * suite checks the factory plumbing, not the helper internals.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiEmitHandler,
  type StreamObserverNotifier,
} from './stream.js';
import { SessionNotFoundError } from './errors.js';
import type { SendEnvelopeFn } from './handle-stream.js';

const CTX = { appId: 'app-1', requestId: 'r1' };

describe('createGguiEmitHandler', () => {
  let sessionStore: InMemorySessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_emit name + agent audience', () => {
      const handler = createGguiEmitHandler({
        sessionStore,
        sendEnvelope: async () => ({}),
      });
      expect(handler.name).toBe('ggui_emit');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('routes through handleStream + sendEnvelope, returns accepted', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-1',
        type: 'component',
        componentCode: '',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-11T00:00:00.000Z',
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
        sessionStore,
        sendEnvelope,
      });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
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
    it('cross-tenant session throws SessionNotFoundError (no leak)', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiEmitHandler({
        sessionStore,
        sendEnvelope: async () => ({}),
      });
      await expect(
        handler.handler(
          { sessionId: 'sess-1', channel: 'updates', payload: {} },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('unknown session throws SessionNotFoundError', async () => {
      const handler = createGguiEmitHandler({
        sessionStore,
        sendEnvelope: async () => ({}),
      });
      await expect(
        handler.handler(
          { sessionId: 'never', channel: 'updates', payload: {} },
          CTX,
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('sendEnvelope NOT invoked when tenancy gate rejects', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const sent: unknown[] = [];
      const handler = createGguiEmitHandler({
        sessionStore,
        sendEnvelope: async (e) => {
          sent.push(e);
          return {};
        },
      });
      await expect(
        handler.handler(
          { sessionId: 'sess-1', channel: 'updates', payload: {} },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(sent).toHaveLength(0);
    });
  });

  describe('observer notifier seam', () => {
    it('fires after successful emission with appId + channel + complete + accepted', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-1',
        type: 'component',
        componentCode: '',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-11T00:00:00.000Z',
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
        sessionStore,
        sendEnvelope: async () => ({ seq: 1 }),
        observerNotifier: {
          notifyToolCall: (args) => {
            calls.push(args);
          },
        },
      });
      await handler.handler(
        {
          sessionId: 'sess-1',
          channel: 'updates',
          payload: { x: 1 },
          complete: true,
        },
        CTX,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        appId: 'app-1',
        sessionId: 'sess-1',
        channel: 'updates',
        hasPayload: true,
        complete: true,
        accepted: true,
      });
    });

    it('observer throw is swallowed — emission still succeeds', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-1',
        type: 'component',
        componentCode: '',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-11T00:00:00.000Z',
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
        sessionStore,
        sendEnvelope: async () => ({ seq: 7 }),
        observerNotifier: {
          notifyToolCall: () => {
            throw new Error('observer exploded');
          },
        },
      });
      const out = await handler.handler(
        { sessionId: 'sess-1', channel: 'updates', payload: { v: 1 } },
        CTX,
      );
      expect(out.accepted).toBe(true);
      expect(out.seq).toBe(7);
    });
  });
});
