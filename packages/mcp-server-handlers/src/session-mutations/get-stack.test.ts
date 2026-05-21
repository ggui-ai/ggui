/**
 * Tests for `createGguiGetStackHandler` — Phase 2.4 lift.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiGetStackHandler } from './get-stack.js';
import { SessionNotFoundError } from './errors.js';

describe('createGguiGetStackHandler', () => {
  let sessionStore: InMemorySessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_get_stack name + agent audience', () => {
      const handler = createGguiGetStackHandler({ sessionStore });
      expect(handler.name).toBe('ggui_get_stack');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('returns navigation summary without componentCode', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-1',
        type: 'component',
        prompt: 'first card',
        componentCode: 'should not appear in summary',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-10T00:00:00.000Z',
      });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-2',
        type: 'component',
        prompt: 'second card',
        description: 'A follow-up screen',
        componentCode: 'should not appear in summary either',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-10T00:01:00.000Z',
      });
      const handler = createGguiGetStackHandler({ sessionStore });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.sessionId).toBe('sess-1');
      expect(out.stackSize).toBe(2);
      expect(out.currentIndex).toBe(1);
      expect(out.canGoBack).toBe(true);
      expect(out.canGoForward).toBe(false);
      expect(out.status).toBe('active');
      expect(out.items).toHaveLength(2);
      // No componentCode on summaries.
      for (const item of out.items) {
        expect(
          (item as unknown as Record<string, unknown>).componentCode,
        ).toBeUndefined();
      }
      expect(out.items[0]).toMatchObject({
        id: 'item-1',
        prompt: 'first card',
        hasError: false,
      });
      expect(out.items[1]).toMatchObject({
        id: 'item-2',
        prompt: 'second card',
        description: 'A follow-up screen',
        hasError: false,
      });
    });

    it('hasError reflects error stack items', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      await sessionStore.appendStackItem('sess-1', {
        id: 'item-bad',
        type: 'component',
        componentCode: '',
        error: 'generation failed',
        contentType: 'application/javascript+react',
        createdAt: '2026-05-10T00:00:00.000Z',
      });
      const handler = createGguiGetStackHandler({ sessionStore });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.items[0].hasError).toBe(true);
    });

    it('empty stack returns canGoBack=false canGoForward=false', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiGetStackHandler({ sessionStore });
      const out = await handler.handler(
        { sessionId: 'sess-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.stackSize).toBe(0);
      expect(out.items).toEqual([]);
      expect(out.canGoBack).toBe(false);
      expect(out.canGoForward).toBe(false);
    });
  });

  describe('tenancy + missing', () => {
    it('cross-tenant session throws SessionNotFoundError', async () => {
      await sessionStore.create({ id: 'sess-1', appId: 'app-1' });
      const handler = createGguiGetStackHandler({ sessionStore });
      await expect(
        handler.handler(
          { sessionId: 'sess-1' },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('unknown session throws SessionNotFoundError', async () => {
      const handler = createGguiGetStackHandler({ sessionStore });
      await expect(
        handler.handler(
          { sessionId: 'never' },
          { appId: 'app-1', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });
});
