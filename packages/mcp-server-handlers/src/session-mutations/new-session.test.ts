/**
 * `ggui_new_session` handler tests — declaration, fresh-UUID creation,
 * persistence, nextStep hint shape.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { MCP_APP_AI_GGUI_HOST_SESSION_META_KEY } from '@ggui-ai/protocol/integrations/mcp-apps';
import { createGguiNewSessionHandler } from './new-session';

const ctx = (
  appId = 'app-1',
  extras: { requestMeta?: Record<string, unknown> } = {},
) => ({
  appId,
  requestId: 'r-1',
  ...(extras.requestMeta !== undefined ? { requestMeta: extras.requestMeta } : {}),
});

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

  describe('host-session capture from inbound _meta', () => {
    it('persists hostSession when ctx.requestMeta carries the slice', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const out = await handler.handler(
        {},
        ctx('app-1', {
          requestMeta: {
            [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: {
              hostName: 'sample',
              hostSessionId: 'chat-abc-123',
            },
          },
        }),
      );
      const session = await sessionStore.get(out.sessionId);
      expect(session?.hostSession).toEqual({
        hostName: 'sample',
        hostSessionId: 'chat-abc-123',
      });
    });

    it('leaves hostSession undefined when no _meta is supplied (opt-out path)', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const out = await handler.handler({}, ctx());
      const session = await sessionStore.get(out.sessionId);
      expect(session?.hostSession).toBeUndefined();
    });

    it('leaves hostSession undefined for a malformed slice (degrades silently)', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const out = await handler.handler(
        {},
        ctx('app-1', {
          requestMeta: {
            [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: {
              // missing hostSessionId — malformed shape
              hostName: 'sample',
            },
          },
        }),
      );
      const session = await sessionStore.get(out.sessionId);
      expect(session?.hostSession).toBeUndefined();
    });

    it('ignores the slice when ctx.requestMeta is undefined', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const out = await handler.handler({}, ctx('app-1', {}));
      const session = await sessionStore.get(out.sessionId);
      expect(session?.hostSession).toBeUndefined();
    });

    it('accepts hostSession on input as a fallback (SDK-driven host path)', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const out = await handler.handler(
        {
          hostSession: { hostName: 'sample', hostSessionId: 'chat-via-input' },
        },
        ctx(), // no requestMeta
      );
      const session = await sessionStore.get(out.sessionId);
      expect(session?.hostSession).toEqual({
        hostName: 'sample',
        hostSessionId: 'chat-via-input',
      });
    });

    it('prefers _meta slice over input slice when both are present', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });
      const out = await handler.handler(
        {
          hostSession: { hostName: 'sample', hostSessionId: 'from-input' },
        },
        ctx('app-1', {
          requestMeta: {
            [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: {
              hostName: 'sample',
              hostSessionId: 'from-meta',
            },
          },
        }),
      );
      const session = await sessionStore.get(out.sessionId);
      expect(session?.hostSession?.hostSessionId).toBe('from-meta');
    });
  });

  describe('host-scoped list — round-trip through sessionStore.list', () => {
    it('returns only sessions matching the (hostName, hostSessionId) pair', async () => {
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiNewSessionHandler({ sessionStore });

      const a = await handler.handler({}, ctx('app-1', {
        requestMeta: {
          [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: {
            hostName: 'sample',
            hostSessionId: 'chat-A',
          },
        },
      }));
      const b = await handler.handler({}, ctx('app-1', {
        requestMeta: {
          [MCP_APP_AI_GGUI_HOST_SESSION_META_KEY]: {
            hostName: 'sample',
            hostSessionId: 'chat-B',
          },
        },
      }));
      // One session with no slice (opt-out) — must NOT match host-scoped query.
      await handler.handler({}, ctx());

      const matchedA = await sessionStore.list({
        hostName: 'sample',
        hostSessionId: 'chat-A',
      });
      expect(matchedA.map((s) => s.id)).toEqual([a.sessionId]);

      const matchedB = await sessionStore.list({
        hostName: 'sample',
        hostSessionId: 'chat-B',
      });
      expect(matchedB.map((s) => s.id)).toEqual([b.sessionId]);

      const allHostSample = await sessionStore.list({ hostName: 'sample' });
      expect(allHostSample.length).toBe(2);
    });
  });
});
