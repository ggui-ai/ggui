/**
 * `ggui_list_sessions` handler tests — host-scoped enumeration,
 * tenancy/user scoping, opt-out handling.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiListSessionsHandler } from './list-sessions';

const ctx = (appId = 'app-1', userId?: string) => ({
  appId,
  requestId: 'r-1',
  ...(userId !== undefined ? { userId } : {}),
});

const HOST_SLICE = (
  hostName: string,
  hostSessionId: string,
): { hostSession: { hostName: string; hostSessionId: string } } => ({
  hostSession: { hostName, hostSessionId },
});

describe('createGguiListSessionsHandler', () => {
  describe('declaration', () => {
    it('exposes the canonical tool name ggui_list_sessions', () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiListSessionsHandler({ sessionStore });
      expect(handler.name).toBe('ggui_list_sessions');
    });

    it('runs on the agent audience by default', () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiListSessionsHandler({ sessionStore });
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('host-scoped filter', () => {
    it('returns sessions matching (hostName, hostSessionId) only', async () => {
      const sessionStore = new InMemorySessionStore();
      const a = await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      const b = await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-B'),
      });
      // Opt-out session — must NOT appear in host-scoped results.
      await sessionStore.create({ appId: 'app-1' });

      const handler = createGguiListSessionsHandler({ sessionStore });
      const out = await handler.handler(
        { hostName: 'sample', hostSessionId: 'chat-A' },
        ctx(),
      );
      expect(out.sessions.map((s) => s.sessionId).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      for (const s of out.sessions) {
        expect(s.hostName).toBe('sample');
        expect(s.hostSessionId).toBe('chat-A');
        expect(s.status).toBe('active');
        expect(typeof s.createdAt).toBe('string');
        expect(s.stackItemCount).toBe(0);
      }
    });

    it('returns ALL host sessions when only hostName is passed', async () => {
      const sessionStore = new InMemorySessionStore();
      await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-B'),
      });
      await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('claude.ai', 'thr-1'),
      });
      const handler = createGguiListSessionsHandler({ sessionStore });
      const out = await handler.handler({ hostName: 'sample' }, ctx());
      expect(out.sessions.length).toBe(2);
      for (const s of out.sessions) expect(s.hostName).toBe('sample');
    });
  });

  describe('tenancy scope', () => {
    it('hides sessions owned by a different app', async () => {
      const sessionStore = new InMemorySessionStore();
      await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      await sessionStore.create({
        appId: 'app-2',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      const handler = createGguiListSessionsHandler({ sessionStore });
      const out = await handler.handler(
        { hostName: 'sample', hostSessionId: 'chat-A' },
        ctx('app-1'),
      );
      expect(out.sessions.length).toBe(1);
    });

    it('hides sessions belonging to a different user when ctx.userId is set', async () => {
      const sessionStore = new InMemorySessionStore();
      await sessionStore.create({
        appId: 'app-1',
        userId: 'user-A',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      await sessionStore.create({
        appId: 'app-1',
        userId: 'user-B',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      const handler = createGguiListSessionsHandler({ sessionStore });
      const outUserA = await handler.handler(
        { hostName: 'sample', hostSessionId: 'chat-A' },
        ctx('app-1', 'user-A'),
      );
      expect(outUserA.sessions.length).toBe(1);
    });
  });

  describe('input validation', () => {
    it('rejects hostName empty string', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiListSessionsHandler({ sessionStore });
      await expect(handler.handler({ hostName: '' }, ctx())).rejects.toThrow();
    });

    it('caps limit at 200', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiListSessionsHandler({ sessionStore });
      await expect(
        handler.handler({ limit: 201 }, ctx()),
      ).rejects.toThrow();
    });
  });

  describe('opt-out documentation', () => {
    it('returns sessions with no host slice when called with no filters', async () => {
      const sessionStore = new InMemorySessionStore();
      await sessionStore.create({ appId: 'app-1' });
      await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      const handler = createGguiListSessionsHandler({ sessionStore });
      const out = await handler.handler({}, ctx());
      expect(out.sessions.length).toBe(2);
      // One has hostName, one does not.
      const withHost = out.sessions.filter((s) => s.hostName === 'sample');
      const noHost = out.sessions.filter((s) => s.hostName === undefined);
      expect(withHost.length).toBe(1);
      expect(noHost.length).toBe(1);
    });
  });

  describe('ws-token mint seam', () => {
    it('omits wsToken when no mint seam is wired (lean summary path)', async () => {
      const sessionStore = new InMemorySessionStore();
      await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      const handler = createGguiListSessionsHandler({ sessionStore });
      const out = await handler.handler({}, ctx());
      expect(out.sessions[0]?.wsToken).toBeUndefined();
      expect(out.sessions[0]?.wsTokenExpiresAt).toBeUndefined();
    });

    it('stamps a freshly-minted wsToken + expiresAt per session when the seam is wired', async () => {
      const sessionStore = new InMemorySessionStore();
      const a = await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      const b = await sessionStore.create({
        appId: 'app-1',
        ...HOST_SLICE('sample', 'chat-A'),
      });
      const mintCalls: Array<{ sessionId: string; appId: string }> = [];
      const handler = createGguiListSessionsHandler({
        sessionStore,
        mintWsToken: {
          mint: ({ sessionId, appId }) => {
            mintCalls.push({ sessionId, appId });
            return {
              token: `tok-${sessionId}`,
              expiresAt: `9999-12-31T00:00:00.000Z`,
            };
          },
        },
      });
      const out = await handler.handler(
        { hostName: 'sample', hostSessionId: 'chat-A' },
        ctx(),
      );
      expect(out.sessions.map((s) => s.wsToken).sort()).toEqual(
        [`tok-${a.id}`, `tok-${b.id}`].sort(),
      );
      // Tenancy: every mint was called with the session's owning appId.
      expect(mintCalls.every((c) => c.appId === 'app-1')).toBe(true);
      // Mint called once per session, no over-firing.
      expect(mintCalls.length).toBe(2);
    });
  });
});
