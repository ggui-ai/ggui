/**
 * Tests for `createGguiListRendersHandler`.
 *
 * Phase B (flatten-render-identity): replaces the prior
 * `list-sessions.test.ts` — the wire shape collapsed from a per-
 * summary {sessionId, stackItemCount, …} to a flat {renderId, …}.
 * The handler still gates by ctx.appId (+ optional ctx.userId) and
 * supports host-conversation filtering via hostName + hostSessionId.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentRender } from '@ggui-ai/protocol';
import { InMemoryRenderStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiListRendersHandler,
  type ListRendersMintSeam,
} from './list-renders.js';

const NOW_MS = Date.parse('2026-05-09T00:00:00.000Z');

async function seedRender(
  store: InMemoryRenderStore,
  opts: {
    renderId?: string;
    appId?: string;
    userId?: string;
    hostName?: string;
    hostSessionId?: string;
    createdAt?: number;
  } = {},
): Promise<{ renderId: string }> {
  const renderId = opts.renderId ?? 'render-1';
  const appId = opts.appId ?? 'app-1';
  const render: ComponentRender = {
    id: renderId,
    appId,
    type: 'component',
    componentCode: '',
    eventSequence: 0,
    createdAt: opts.createdAt ?? NOW_MS,
    lastActivityAt: opts.createdAt ?? NOW_MS,
    expiresAt: (opts.createdAt ?? NOW_MS) + 60_000,
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    ...(opts.hostName !== undefined && opts.hostSessionId !== undefined
      ? {
          hostSession: {
            hostName: opts.hostName,
            hostSessionId: opts.hostSessionId,
          },
        }
      : {}),
  };
  await store.commit({
    render,
    appId,
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    ...(opts.hostName !== undefined && opts.hostSessionId !== undefined
      ? {
          hostSession: {
            hostName: opts.hostName,
            hostSessionId: opts.hostSessionId,
          },
        }
      : {}),
  });
  return { renderId };
}

describe('createGguiListRendersHandler', () => {
  let renderStore: InMemoryRenderStore;

  beforeEach(() => {
    renderStore = new InMemoryRenderStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_list_renders name + agent audience', () => {
      const handler = createGguiListRendersHandler({ renderStore });
      expect(handler.name).toBe('ggui_list_renders');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('scoping', () => {
    it('returns only renders for the caller appId (cross-tenant excluded)', async () => {
      await seedRender(renderStore, { renderId: 'a', appId: 'app-1' });
      await seedRender(renderStore, { renderId: 'b', appId: 'app-2' });
      const handler = createGguiListRendersHandler({ renderStore });
      const out = await handler.handler(
        {},
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.renders.map((r) => r.renderId)).toEqual(['a']);
    });

    it('returns only renders for the caller userId when ctx.userId is set', async () => {
      await seedRender(renderStore, {
        renderId: 'mine',
        appId: 'app-1',
        userId: 'u1',
      });
      await seedRender(renderStore, {
        renderId: 'theirs',
        appId: 'app-1',
        userId: 'u2',
      });
      const handler = createGguiListRendersHandler({ renderStore });
      const out = await handler.handler(
        {},
        { appId: 'app-1', requestId: 'r1', userId: 'u1' },
      );
      expect(out.renders.map((r) => r.renderId)).toEqual(['mine']);
    });
  });

  describe('host-conversation filtering', () => {
    it('narrows by hostName + hostSessionId pair', async () => {
      await seedRender(renderStore, {
        renderId: 'claude-1',
        appId: 'app-1',
        hostName: 'claude.ai',
        hostSessionId: 'thread-abc',
      });
      await seedRender(renderStore, {
        renderId: 'claude-2',
        appId: 'app-1',
        hostName: 'claude.ai',
        hostSessionId: 'thread-xyz',
      });
      await seedRender(renderStore, {
        renderId: 'no-host',
        appId: 'app-1',
      });
      const handler = createGguiListRendersHandler({ renderStore });
      const out = await handler.handler(
        { hostName: 'claude.ai', hostSessionId: 'thread-abc' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.renders.map((r) => r.renderId)).toEqual(['claude-1']);
    });

    it('renders without a host slice never match a host-scoped query (opt-out posture)', async () => {
      await seedRender(renderStore, { renderId: 'no-host', appId: 'app-1' });
      const handler = createGguiListRendersHandler({ renderStore });
      const out = await handler.handler(
        { hostName: 'claude.ai', hostSessionId: 'thread-abc' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.renders).toEqual([]);
    });
  });

  describe('summary shape', () => {
    it('projects renderId + lifecycle timestamps + status', async () => {
      const { renderId } = await seedRender(renderStore, {
        hostName: 'sample',
        hostSessionId: 'chat-1',
      });
      const handler = createGguiListRendersHandler({ renderStore });
      const out = await handler.handler(
        {},
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.renders).toHaveLength(1);
      const summary = out.renders[0]!;
      expect(summary.renderId).toBe(renderId);
      expect(summary.hostName).toBe('sample');
      expect(summary.hostSessionId).toBe('chat-1');
      expect(typeof summary.createdAt).toBe('string');
      expect(typeof summary.lastActivityAt).toBe('string');
      expect(summary.status).toBe('active');
      // No wsToken without the mint seam.
      expect(summary.wsToken).toBeUndefined();
      expect(summary.wsTokenExpiresAt).toBeUndefined();
    });

    it('attaches fresh wsToken + expiresAt when mintWsToken is wired', async () => {
      const { renderId } = await seedRender(renderStore);
      const minted: Array<{ renderId: string; appId: string }> = [];
      const mintWsToken: ListRendersMintSeam = {
        mint: ({ renderId: rid, appId }) => {
          minted.push({ renderId: rid, appId });
          return { token: `tok-${rid}`, expiresAt: '2099-01-01T00:00:00.000Z' };
        },
      };
      const handler = createGguiListRendersHandler({
        renderStore,
        mintWsToken,
      });
      const out = await handler.handler(
        {},
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.renders[0]?.wsToken).toBe(`tok-${renderId}`);
      expect(out.renders[0]?.wsTokenExpiresAt).toBe(
        '2099-01-01T00:00:00.000Z',
      );
      expect(minted).toEqual([{ renderId, appId: 'app-1' }]);
    });
  });
});
