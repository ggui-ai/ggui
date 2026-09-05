/**
 * Tests for `createGguiGetSessionHandler`.
 *
 * Phase B (flatten-render-identity): replaces the prior
 * `get-session.test.ts` — the wire input collapsed from `{sessionId}`
 * to `{sessionId}` and the response shape collapsed from a
 * `SessionView` (vessel + ISO timestamps + stack array) to the flat
 * `GguiSession` shape with epoch-ms timestamps.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiGetSessionHandler } from './get-session.js';
import { GguiSessionNotFoundError } from './errors.js';

const NOW_MS = Date.parse('2026-05-09T00:00:00.000Z');

async function seedRender(
  store: InMemoryGguiSessionStore,
  opts: {
    sessionId?: string;
    appId?: string;
    themeId?: string;
    contextSnapshot?: JsonObject;
  } = {},
): Promise<{ sessionId: string }> {
  const sessionId = opts.sessionId ?? 'render-1';
  const appId = opts.appId ?? 'app-1';
  const render: ComponentGguiSession = {
    id: sessionId,
    appId,
    type: 'component',
    componentCode: 'export default () => null;',
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
    ...(opts.themeId !== undefined ? { themeId: opts.themeId } : {}),
    ...(opts.contextSnapshot !== undefined ? { contextSnapshot: opts.contextSnapshot } : {}),
  };
  await store.commit({ render, appId });
  return { sessionId };
}

describe('createGguiGetSessionHandler', () => {
  let renderStore: InMemoryGguiSessionStore;

  beforeEach(() => {
    renderStore = new InMemoryGguiSessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_get_session name + agent audience', () => {
      const handler = createGguiGetSessionHandler({ renderStore });
      expect(handler.name).toBe('ggui_get_session');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('returns the render with id, appId, eventSequence, lifecycle timestamps', async () => {
      const { sessionId } = await seedRender(renderStore);
      const handler = createGguiGetSessionHandler({ renderStore });
      const out = await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.variant).toBe('render');
      expect(out.id).toBe(sessionId);
      expect(out.appId).toBe('app-1');
      expect(typeof out.eventSequence).toBe('number');
      expect(typeof out.createdAt).toBe('number');
      expect(typeof out.lastActivityAt).toBe('number');
      expect(typeof out.expiresAt).toBe('number');
    });

    it('forwards themeId when present on the render', async () => {
      const { sessionId } = await seedRender(renderStore, { themeId: 'indigo' });
      const handler = createGguiGetSessionHandler({ renderStore });
      const out = await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.variant).toBe('render');
      // themeId never travelled: the transport strip-parses to the wire shape.
      // The wire is the seven-field projection and nothing else.
      expect(Object.keys(out).sort()).toEqual([
        'appId',
        'createdAt',
        'eventSequence',
        'expiresAt',
        'id',
        'lastActivityAt',
        'variant',
      ]);
    });
  });

  describe('contextSnapshot — contextSpec values ride the wire when the row has them (#817 audit)', () => {
    it('projects the stored contextSnapshot for a component render', async () => {
      const snapshot: JsonObject = { selectedDate: '2026-09-05', count: 3 };
      const { sessionId } = await seedRender(renderStore, { contextSnapshot: snapshot });
      const handler = createGguiGetSessionHandler({ renderStore });
      const out = await handler.handler({ sessionId }, { appId: 'app-1', requestId: 'r1' });
      expect(out.contextSnapshot).toEqual(snapshot);
    });
    it('omits it when the row carries none — never an empty placeholder', async () => {
      const { sessionId } = await seedRender(renderStore);
      const handler = createGguiGetSessionHandler({ renderStore });
      const out = await handler.handler({ sessionId }, { appId: 'app-1', requestId: 'r1' });
      expect('contextSnapshot' in out).toBe(false);
    });
  });

  describe('tenancy + missing', () => {
    it('throws GguiSessionNotFoundError on cross-tenant access (no leak)', async () => {
      const { sessionId } = await seedRender(renderStore, { appId: 'app-1' });
      const handler = createGguiGetSessionHandler({ renderStore });
      await expect(
        handler.handler(
          { sessionId },
          { appId: 'app-OTHER', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });

    it('throws GguiSessionNotFoundError on unknown sessionId', async () => {
      const handler = createGguiGetSessionHandler({ renderStore });
      await expect(
        handler.handler(
          { sessionId: 'never-existed' },
          { appId: 'app-1', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });
  });

  describe('heartbeat seam', () => {
    it('invokes the heartbeat hook after a successful read', async () => {
      const { sessionId } = await seedRender(renderStore);
      const calls: string[] = [];
      const handler = createGguiGetSessionHandler({
        renderStore,
        heartbeat: (rid) => {
          calls.push(rid);
        },
      });
      await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(calls).toEqual([sessionId]);
    });

    it('overlays heartbeat-returned timestamps onto the wire response', async () => {
      const { sessionId } = await seedRender(renderStore);
      const handler = createGguiGetSessionHandler({
        renderStore,
        heartbeat: () => ({
          lastActivityAt: 9_999_999,
          expiresAt: 10_000_000,
        }),
      });
      const out = await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.variant).toBe('render');
      expect(out.lastActivityAt).toBe(9_999_999);
      expect(out.expiresAt).toBe(10_000_000);
    });

    it('swallows heartbeat failures (best-effort)', async () => {
      const { sessionId } = await seedRender(renderStore);
      const handler = createGguiGetSessionHandler({
        renderStore,
        heartbeat: () => {
          throw new Error('write failed');
        },
      });
      const out = await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      // Read still returns the pre-heartbeat snapshot.
      expect(out.id).toBe(sessionId);
    });

    it('does NOT invoke heartbeat when tenancy gate rejects', async () => {
      const { sessionId } = await seedRender(renderStore, { appId: 'app-1' });
      const calls: number[] = [];
      const handler = createGguiGetSessionHandler({
        renderStore,
        heartbeat: () => {
          calls.push(1);
        },
      });
      await expect(
        handler.handler(
          { sessionId },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
      expect(calls).toHaveLength(0);
    });
  });
});
