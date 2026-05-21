/**
 * Tests for `createGguiGetSessionHandler` — Phase 2.4 lift.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiGetSessionHandler } from './get-session.js';
import { SessionNotFoundError } from './errors.js';

describe('createGguiGetSessionHandler', () => {
  let sessionStore: InMemorySessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_get_session name + agent audience', () => {
      const handler = createGguiGetSessionHandler({ sessionStore });
      expect(handler.name).toBe('ggui_get_session');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('projects Session → SessionView with ISO timestamps + active status', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-1',
        type: 'component',
        componentCode: 'export default () => null;',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-10T00:00:00.000Z',
      });
      const handler = createGguiGetSessionHandler({ sessionStore });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.id).toBe('sess-1');
      expect(out.appId).toBe('app-1');
      expect(out.status).toBe('active');
      expect(out.stack).toHaveLength(1);
      expect(out.stack[0]).toMatchObject({ id: 'item-1', type: 'component' });
      expect(out.currentStackIndex).toBe(0);
      expect(out.eventSequence).toBe(0);
      // ISO format check — accept extended-year forms (`+275760-...`)
      // since InMemorySessionStore's MAX_SAFE_INTEGER expiresAt clamps
      // to the JS Date max which is millennia in the future.
      expect(out.createdAt).toMatch(/T\d{2}:\d{2}:\d{2}/);
      expect(out.lastActivityAt).toMatch(/T\d{2}:\d{2}:\d{2}/);
      expect(out.expiresAt).toMatch(/T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('status projection', () => {
    it('surfaces status=completed after a session.closed event lands', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      // Simulate close by appending the terminal event.
      await sessionStore.appendEvent({
        sessionId: 'sess-1',
        type: 'session.closed',
        data: {},
      });
      const handler = createGguiGetSessionHandler({ sessionStore });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.status).toBe('completed');
    });

    it('surfaces status=active on a fresh session', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiGetSessionHandler({ sessionStore });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.status).toBe('active');
    });
  });

  describe('tenancy + missing', () => {
    it('cross-tenant session throws SessionNotFoundError (no leak)', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiGetSessionHandler({ sessionStore });
      await expect(
        handler.handler(
          { sessionId: 'sess-1' },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('unknown session throws SessionNotFoundError', async () => {
      const handler = createGguiGetSessionHandler({ sessionStore });
      await expect(
        handler.handler(
          { sessionId: 'never' },
          { appId: 'app-1', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });

  describe('heartbeat hook', () => {
    it('fires after a successful read', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const calls: string[] = [];
      const handler = createGguiGetSessionHandler({
        sessionStore,
        heartbeat: (sid) => {
          calls.push(sid);
        },
      });
      await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(calls).toEqual(['sess-1']);
    });

    it('heartbeat throw is swallowed — read still succeeds', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiGetSessionHandler({
        sessionStore,
        heartbeat: () => {
          throw new Error('heartbeat exploded');
        },
      });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.id).toBe('sess-1');
    });

    it('heartbeat does NOT fire when tenancy gate rejects', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const calls: string[] = [];
      const handler = createGguiGetSessionHandler({
        sessionStore,
        heartbeat: (sid) => {
          calls.push(sid);
        },
      });
      await expect(
        handler.handler(
          { sessionId: 'sess-1' },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      expect(calls).toHaveLength(0);
    });
  });
});
