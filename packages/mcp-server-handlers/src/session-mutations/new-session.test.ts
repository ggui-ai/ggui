/**
 * `ggui_new_session` handler tests — declaration, fresh-UUID creation,
 * persistence, nextStep hint shape.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiNewSessionHandler } from './new-session';

const ctx = (appId = 'app-1') => ({ appId, requestId: 'r-1' });

describe('createGguiNewSessionHandler', () => {
  describe('declaration', () => {
    it('exposes the canonical tool name ggui_new_session', () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      expect(handler.name).toBe('ggui_new_session');
    });

    it('declares the locked output shape — sessionId, themeId, availableThemes, nextStep', () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const outKeys = Object.keys(handler.outputSchema).sort();
      expect(outKeys).toEqual([
        'availableThemes',
        'nextStep',
        'sessionId',
        'themeId',
      ]);
    });

    it('does NOT carry MCP Apps _meta — agent-only tool, no rendered UI', () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      expect(handler._meta).toBeUndefined();
    });
  });

  describe('fresh UUID per call', () => {
    it('mints a fresh sessionId on every call', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const out = await handler.handler({}, ctx());
      expect(typeof out.sessionId).toBe('string');
      expect(out.sessionId.length).toBeGreaterThan(0);
    });

    it('returns a different sessionId on a second call', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const a = await handler.handler({}, ctx());
      const b = await handler.handler({}, ctx());
      expect(a.sessionId).not.toBe(b.sessionId);
    });

    it('persists the session in the store', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const out = await handler.handler({}, ctx());
      const session = await sessionStore.get(out.sessionId);
      expect(session).not.toBeNull();
      expect(session?.appId).toBe('app-1');
    });
  });

  describe('nextStep recovery hint', () => {
    it('points the agent at ggui_handshake with the freshly minted sessionId', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const out = await handler.handler({}, ctx());
      expect(out.nextStep.tool).toBe('ggui_handshake');
      expect(out.nextStep.example).toContain(out.sessionId);
      expect(out.nextStep.example).toContain('ggui_handshake');
    });
  });

});
