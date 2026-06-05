/**
 * Tests for `createGguiGetRenderHandler`.
 *
 * Phase B (flatten-render-identity): replaces the prior
 * `get-session.test.ts` — the wire input collapsed from `{sessionId}`
 * to `{renderId}` and the response shape collapsed from a
 * `SessionView` (vessel + ISO timestamps + stack array) to the flat
 * `GguiSession` shape with epoch-ms timestamps.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiGetRenderHandler } from './get-render.js';
import { GguiSessionNotFoundError } from './errors.js';

const NOW_MS = Date.parse('2026-05-09T00:00:00.000Z');

async function seedRender(
  store: InMemoryGguiSessionStore,
  opts: {
    renderId?: string;
    appId?: string;
    themeId?: string;
  } = {},
): Promise<{ renderId: string }> {
  const renderId = opts.renderId ?? 'render-1';
  const appId = opts.appId ?? 'app-1';
  const render: ComponentGguiSession = {
    id: renderId,
    appId,
    type: 'component',
    componentCode: 'export default () => null;',
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
    ...(opts.themeId !== undefined ? { themeId: opts.themeId } : {}),
  };
  await store.commit({ render, appId });
  return { renderId };
}

describe('createGguiGetRenderHandler', () => {
  let renderStore: InMemoryGguiSessionStore;

  beforeEach(() => {
    renderStore = new InMemoryGguiSessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_get_render name + agent audience', () => {
      const handler = createGguiGetRenderHandler({ renderStore });
      expect(handler.name).toBe('ggui_get_render');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('returns the render with id, appId, eventSequence, lifecycle timestamps', async () => {
      const { renderId } = await seedRender(renderStore);
      const handler = createGguiGetRenderHandler({ renderStore });
      const out = await handler.handler(
        { renderId },
        { appId: 'app-1', requestId: 'r1' },
      );
if (out.type === 'mcpApps') {
        throw new Error('expected ComponentGguiSession, got McpAppsGguiSession');
      }
      expect(out.id).toBe(renderId);
      expect(out.appId).toBe('app-1');
      expect(typeof out.eventSequence).toBe('number');
      expect(typeof out.createdAt).toBe('number');
      expect(typeof out.lastActivityAt).toBe('number');
      expect(typeof out.expiresAt).toBe('number');
    });

    it('forwards themeId when present on the render', async () => {
      const { renderId } = await seedRender(renderStore, { themeId: 'indigo' });
      const handler = createGguiGetRenderHandler({ renderStore });
      const out = await handler.handler(
        { renderId },
        { appId: 'app-1', requestId: 'r1' },
      );
      if (out.type === 'mcpApps') {
        throw new Error('expected ComponentGguiSession, got McpAppsGguiSession');
      }
      expect(out.themeId).toBe('indigo');
    });
  });

  describe('tenancy + missing', () => {
    it('throws GguiSessionNotFoundError on cross-tenant access (no leak)', async () => {
      const { renderId } = await seedRender(renderStore, { appId: 'app-1' });
      const handler = createGguiGetRenderHandler({ renderStore });
      await expect(
        handler.handler(
          { renderId },
          { appId: 'app-OTHER', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });

    it('throws GguiSessionNotFoundError on unknown renderId', async () => {
      const handler = createGguiGetRenderHandler({ renderStore });
      await expect(
        handler.handler(
          { renderId: 'never-existed' },
          { appId: 'app-1', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });
  });

  describe('heartbeat seam', () => {
    it('invokes the heartbeat hook after a successful read', async () => {
      const { renderId } = await seedRender(renderStore);
      const calls: string[] = [];
      const handler = createGguiGetRenderHandler({
        renderStore,
        heartbeat: (rid) => {
          calls.push(rid);
        },
      });
      await handler.handler(
        { renderId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(calls).toEqual([renderId]);
    });

    it('overlays heartbeat-returned timestamps onto the wire response', async () => {
      const { renderId } = await seedRender(renderStore);
      const handler = createGguiGetRenderHandler({
        renderStore,
        heartbeat: () => ({
          lastActivityAt: 9_999_999,
          expiresAt: 10_000_000,
        }),
      });
      const out = await handler.handler(
        { renderId },
        { appId: 'app-1', requestId: 'r1' },
      );
      if (out.type === 'mcpApps') {
        throw new Error('expected ComponentGguiSession, got McpAppsGguiSession');
      }
      expect(out.lastActivityAt).toBe(9_999_999);
      expect(out.expiresAt).toBe(10_000_000);
    });

    it('swallows heartbeat failures (best-effort)', async () => {
      const { renderId } = await seedRender(renderStore);
      const handler = createGguiGetRenderHandler({
        renderStore,
        heartbeat: () => {
          throw new Error('write failed');
        },
      });
      const out = await handler.handler(
        { renderId },
        { appId: 'app-1', requestId: 'r1' },
      );
      // Read still returns the pre-heartbeat snapshot.
      expect(out.id).toBe(renderId);
    });

    it('does NOT invoke heartbeat when tenancy gate rejects', async () => {
      const { renderId } = await seedRender(renderStore, { appId: 'app-1' });
      const calls: number[] = [];
      const handler = createGguiGetRenderHandler({
        renderStore,
        heartbeat: () => {
          calls.push(1);
        },
      });
      await expect(
        handler.handler(
          { renderId },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
      expect(calls).toHaveLength(0);
    });
  });
});
