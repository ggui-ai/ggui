/**
 * Tests for `createGguiCloseHandler` — Phase 2.4 lift.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiCloseHandler,
  type CloseObserverNotifier,
} from './close.js';
import { SessionNotFoundError } from './errors.js';

describe('createGguiCloseHandler', () => {
  let sessionStore: InMemorySessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_close name + agent audience', () => {
      const handler = createGguiCloseHandler({ sessionStore });
      expect(handler.name).toBe('ggui_close');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('appends session.closed event + returns success:true', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiCloseHandler({ sessionStore });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.success).toBe(true);
      // Verify the close stuck — listing for active should NOT include it.
      const active = await sessionStore.list({
        appId: 'app-1',
        status: 'active',
      });
      expect(active.find((s) => s.id === 'sess-1')).toBeUndefined();
      // ... but listing for completed should.
      const completed = await sessionStore.list({
        appId: 'app-1',
        status: 'completed',
      });
      expect(completed.find((s) => s.id === 'sess-1')).toBeDefined();
    });

    it('idempotent — closing an already-closed session returns success:true', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiCloseHandler({ sessionStore });
      await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      // Second close on the same session — must NOT throw.
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r2' },
      );
      expect(out.success).toBe(true);
    });
  });

  describe('tenancy + missing', () => {
    it('cross-tenant session throws SessionNotFoundError', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiCloseHandler({ sessionStore });
      await expect(
        handler.handler(
          { sessionId: 'sess-1' },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('unknown session throws SessionNotFoundError', async () => {
      const handler = createGguiCloseHandler({ sessionStore });
      await expect(
        handler.handler(
          { sessionId: 'never' },
          { appId: 'app-1', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });

  describe('markCompleted seam', () => {
    it('when set, used in place of appendEvent — receives sessionId', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const calls: string[] = [];
      const handler = createGguiCloseHandler({
        sessionStore,
        markCompleted: async (sid) => {
          calls.push(sid);
          return true;
        },
      });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.success).toBe(true);
      expect(calls).toEqual(['sess-1']);
    });

    it('surfaces success=false when markCompleted returns false', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiCloseHandler({
        sessionStore,
        markCompleted: () => false,
      });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.success).toBe(false);
    });

    it('does NOT fire appendEvent when markCompleted is set', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiCloseHandler({
        sessionStore,
        markCompleted: () => true,
      });
      await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      // Session should NOT be marked completed via the OSS event log
      // when markCompleted is wired — the OSS event log only sees
      // entries from the appendEvent path.
      const active = await sessionStore.list({
        appId: 'app-1',
        status: 'active',
      });
      expect(active.find((s) => s.id === 'sess-1')).toBeDefined();
    });
  });

  describe('observer notifier seam', () => {
    it('fires after a successful close with appId + sessionId', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const calls: Parameters<CloseObserverNotifier['notifySessionClosed']>[0][] = [];
      const observer: CloseObserverNotifier = {
        notifySessionClosed: (args) => {
          calls.push(args);
        },
      };
      const handler = createGguiCloseHandler({
        sessionStore,
        observerNotifier: observer,
      });
      await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ appId: 'app-1', sessionId: 'sess-1' });
    });

    it('observer throw is swallowed — close still succeeds', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiCloseHandler({
        sessionStore,
        observerNotifier: {
          notifySessionClosed: () => {
            throw new Error('observer exploded');
          },
        },
      });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.success).toBe(true);
    });

    it('observer does NOT fire when tenancy gate rejects', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const calls: number[] = [];
      const handler = createGguiCloseHandler({
        sessionStore,
        observerNotifier: {
          notifySessionClosed: () => {
            calls.push(1);
          },
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

  describe('shortCode revocation (capability-URL hardening)', () => {
    it('revokes every /r/<code> URL bound to the closing session', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const shortCodeIndex = new InMemoryShortCodeIndex();
      await shortCodeIndex.put('code-a', {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'stk_a',
      });
      await shortCodeIndex.put('code-b', {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'stk_b',
      });
      // Unrelated session's code stays.
      await shortCodeIndex.put('code-x', {
        sessionId: 'sess-other',
        appId: 'app-1',
      });

      const handler = createGguiCloseHandler({ sessionStore, shortCodeIndex });
      await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );

      expect(await shortCodeIndex.lookup('code-a')).toBeNull();
      expect(await shortCodeIndex.lookup('code-b')).toBeNull();
      expect(await shortCodeIndex.lookup('code-x')).not.toBeNull();
    });

    it('revocation does not fire when tenancy gate rejects', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const shortCodeIndex = new InMemoryShortCodeIndex();
      await shortCodeIndex.put('code-a', {
        sessionId: 'sess-1',
        appId: 'app-1',
      });
      const handler = createGguiCloseHandler({ sessionStore, shortCodeIndex });
      await expect(
        handler.handler(
          { sessionId: 'sess-1' },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      // Wrong tenant must not be able to revoke another tenant's URLs.
      expect(await shortCodeIndex.lookup('code-a')).not.toBeNull();
    });
  });
});
