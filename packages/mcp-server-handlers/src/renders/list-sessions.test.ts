/**
 * Tests for `createGguiListSessionsHandler`.
 *
 * Phase B (flatten-render-identity): replaces the prior
 * `list-sessions.test.ts` — the wire shape collapsed from a per-
 * summary {sessionId, stackItemCount, …} to a flat {sessionId, …}.
 * The handler still gates by ctx.appId (+ optional ctx.userId) and
 * supports host-conversation filtering via hostName + hostSessionId.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiListSessionsHandler,
  type ListSessionsMintSeam,
} from './list-sessions.js';

const NOW_MS = Date.parse('2026-05-09T00:00:00.000Z');

async function seedRender(
  store: InMemoryGguiSessionStore,
  opts: {
    sessionId?: string;
    appId?: string;
    userId?: string;
    hostName?: string;
    hostSessionId?: string;
    createdAt?: number;
  } = {},
): Promise<{ sessionId: string }> {
  const sessionId = opts.sessionId ?? 'render-1';
  const appId = opts.appId ?? 'app-1';
  const render: ComponentGguiSession = {
    id: sessionId,
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
  return { sessionId };
}

describe('createGguiListSessionsHandler', () => {
  let renderStore: InMemoryGguiSessionStore;

  beforeEach(() => {
    renderStore = new InMemoryGguiSessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_list_sessions name + agent audience', () => {
      const handler = createGguiListSessionsHandler({ renderStore });
      expect(handler.name).toBe('ggui_list_sessions');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('scoping', () => {
    it('returns only renders for the caller appId (cross-tenant excluded)', async () => {
      await seedRender(renderStore, { sessionId: 'a', appId: 'app-1' });
      await seedRender(renderStore, { sessionId: 'b', appId: 'app-2' });
      const handler = createGguiListSessionsHandler({ renderStore });
      const out = await handler.handler(
        {},
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.sessions.map((r) => r.sessionId)).toEqual(['a']);
    });

    it('returns only renders for the caller userId when ctx.userId is set', async () => {
      await seedRender(renderStore, {
        sessionId: 'mine',
        appId: 'app-1',
        userId: 'u1',
      });
      await seedRender(renderStore, {
        sessionId: 'theirs',
        appId: 'app-1',
        userId: 'u2',
      });
      const handler = createGguiListSessionsHandler({ renderStore });
      const out = await handler.handler(
        {},
        { appId: 'app-1', requestId: 'r1', userId: 'u1' },
      );
      expect(out.sessions.map((r) => r.sessionId)).toEqual(['mine']);
    });
  });

  describe('host-conversation filtering', () => {
    it('narrows by hostName + hostSessionId pair', async () => {
      await seedRender(renderStore, {
        sessionId: 'claude-1',
        appId: 'app-1',
        hostName: 'claude.ai',
        hostSessionId: 'thread-abc',
      });
      await seedRender(renderStore, {
        sessionId: 'claude-2',
        appId: 'app-1',
        hostName: 'claude.ai',
        hostSessionId: 'thread-xyz',
      });
      await seedRender(renderStore, {
        sessionId: 'no-host',
        appId: 'app-1',
      });
      const handler = createGguiListSessionsHandler({ renderStore });
      const out = await handler.handler(
        { hostName: 'claude.ai', hostSessionId: 'thread-abc' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.sessions.map((r) => r.sessionId)).toEqual(['claude-1']);
    });

    it('renders without a host slice never match a host-scoped query (opt-out posture)', async () => {
      await seedRender(renderStore, { sessionId: 'no-host', appId: 'app-1' });
      const handler = createGguiListSessionsHandler({ renderStore });
      const out = await handler.handler(
        { hostName: 'claude.ai', hostSessionId: 'thread-abc' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.sessions).toEqual([]);
    });
  });

  describe('summary shape', () => {
    it('projects sessionId + lifecycle timestamps + status', async () => {
      const { sessionId } = await seedRender(renderStore, {
        hostName: 'sample',
        hostSessionId: 'chat-1',
      });
      const handler = createGguiListSessionsHandler({ renderStore });
      const out = await handler.handler(
        {},
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.sessions).toHaveLength(1);
      const summary = out.sessions[0]!;
      expect(summary.sessionId).toBe(sessionId);
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
      const { sessionId } = await seedRender(renderStore);
      const minted: Array<{ sessionId: string; appId: string }> = [];
      const mintWsToken: ListSessionsMintSeam = {
        mint: ({ sessionId: rid, appId }) => {
          minted.push({ sessionId: rid, appId });
          return { token: `tok-${rid}`, expiresAt: '2099-01-01T00:00:00.000Z' };
        },
      };
      const handler = createGguiListSessionsHandler({
        renderStore,
        mintWsToken,
      });
      const out = await handler.handler(
        {},
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.sessions[0]?.wsToken).toBe(`tok-${sessionId}`);
      expect(out.sessions[0]?.wsTokenExpiresAt).toBe(
        '2099-01-01T00:00:00.000Z',
      );
      expect(minted).toEqual([{ sessionId, appId: 'app-1' }]);
    });
  });
});
