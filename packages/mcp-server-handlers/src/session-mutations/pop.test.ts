/**
 * Tests for `createGguiPopHandler` — Phase 2.4 pop lift.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemorySessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiPopHandler } from './pop.js';
import { SessionNotFoundError } from './errors.js';

describe('createGguiPopHandler', () => {
  let sessionStore: InMemorySessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_pop name + agent audience', () => {
      const handler = createGguiPopHandler({ sessionStore });
      expect(handler.name).toBe('ggui_pop');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('removes top entry and returns id + new size', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-1',
        type: 'component',
        componentCode: 'export default () => null;',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-10T00:00:00.000Z',
      });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-2',
        type: 'component',
        componentCode: 'export default () => null;',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-10T00:01:00.000Z',
      });
      const handler = createGguiPopHandler({ sessionStore });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.poppedId).toBe('item-2');
      expect(out.stackSize).toBe(1);
      // Verify the stack actually shrunk.
      const session = await sessionStore.get('sess-1');
      expect(session?.stack).toHaveLength(1);
      expect(session?.stack[0]?.id).toBe('item-1');
    });

    it('removes the popped id from the stackItemId secondary index', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-1',
        type: 'component',
        componentCode: '',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-10T00:00:00.000Z',
      });
      const before = await sessionStore.getSessionByStackItemId('item-1');
      expect(before).not.toBeNull();
      const handler = createGguiPopHandler({ sessionStore });
      await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      const after = await sessionStore.getSessionByStackItemId('item-1');
      expect(after).toBeNull();
    });
  });

  describe('empty stack', () => {
    it('returns {poppedId: null, stackSize: 0} without error', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiPopHandler({ sessionStore });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out).toEqual({ poppedId: null, stackSize: 0 });
    });
  });

  describe('shortCode revocation (capability-URL hardening)', () => {
    it('revokes only the popped stack item — sibling URLs stay valid', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-1',
        type: 'component',
        componentCode: '',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-10T00:00:00.000Z',
      });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-2',
        type: 'component',
        componentCode: '',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-10T00:01:00.000Z',
      });
      const shortCodeIndex = new InMemoryShortCodeIndex();
      await shortCodeIndex.put('code-for-item-1', {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'item-1',
      });
      await shortCodeIndex.put('code-for-item-2', {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'item-2',
      });

      const handler = createGguiPopHandler({ sessionStore, shortCodeIndex });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.poppedId).toBe('item-2');

      // The popped item's URL stops resolving — the other one keeps
      // working since its stack item is still on the stack.
      expect(await shortCodeIndex.lookup('code-for-item-2')).toBeNull();
      expect(await shortCodeIndex.lookup('code-for-item-1')).not.toBeNull();
    });

    it('empty-stack pop does not touch the index', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const shortCodeIndex = new InMemoryShortCodeIndex();
      await shortCodeIndex.put('unrelated', {
        sessionId: 'other-session',
        appId: 'app-1',
      });
      const handler = createGguiPopHandler({ sessionStore, shortCodeIndex });
      await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(await shortCodeIndex.lookup('unrelated')).not.toBeNull();
    });
  });

  describe('tenancy + missing', () => {
    it('cross-tenant session throws SessionNotFoundError (no leak)', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiPopHandler({ sessionStore });
      await expect(
        handler.handler(
          { sessionId: 'sess-1' },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('unknown session throws SessionNotFoundError', async () => {
      const handler = createGguiPopHandler({ sessionStore });
      await expect(
        handler.handler(
          { sessionId: 'never' },
          { appId: 'app-1', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });
});
