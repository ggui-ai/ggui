/**
 * Tests for `createGguiCloseHandler`.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from `{sessionId}`
 * to `{renderId}` — every render IS the addressable scope.
 * `SessionStore` → `RenderStore`. `SessionNotFoundError` →
 * `RenderNotFoundError`. The observer notifier renamed from
 * `notifySessionClosed` to `notifyRenderClosed`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentRender } from '@ggui-ai/protocol';
import {
  InMemoryRenderStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiCloseHandler,
  type CloseObserverNotifier,
} from './close.js';
import { RenderNotFoundError } from './errors.js';

const NOW_MS = Date.parse('2026-05-09T00:00:00.000Z');

async function seedRender(
  store: InMemoryRenderStore,
  renderId: string,
  appId: string,
): Promise<void> {
  const render: ComponentRender = {
    id: renderId,
    appId,
    type: 'component',
    componentCode: '',
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
  };
  await store.commit({ render, appId });
}

describe('createGguiCloseHandler', () => {
  let renderStore: InMemoryRenderStore;

  beforeEach(() => {
    renderStore = new InMemoryRenderStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_close name + agent audience', () => {
      const handler = createGguiCloseHandler({ renderStore });
      expect(handler.name).toBe('ggui_close');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('appends session.closed event + returns success:true', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const handler = createGguiCloseHandler({ renderStore });
      const out = await handler.handler(
        { renderId: 'render-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.success).toBe(true);
      // Verify the close stuck — listing for active should NOT include it.
      const active = await renderStore.list({
        appId: 'app-1',
        status: 'active',
      });
      expect(active.find((r) => r.id === 'render-1')).toBeUndefined();
      // ... but listing for completed should.
      const completed = await renderStore.list({
        appId: 'app-1',
        status: 'completed',
      });
      expect(completed.find((r) => r.id === 'render-1')).toBeDefined();
    });

    it('idempotent — closing an already-closed render returns success:true', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const handler = createGguiCloseHandler({ renderStore });
      await handler.handler(
        { renderId: 'render-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      // Second close on the same render — must NOT throw.
      const out = await handler.handler(
        { renderId: 'render-1' },
        { appId: 'app-1', requestId: 'r2' },
      );
      expect(out.success).toBe(true);
    });
  });

  describe('tenancy + missing', () => {
    it('cross-tenant render throws RenderNotFoundError', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const handler = createGguiCloseHandler({ renderStore });
      await expect(
        handler.handler(
          { renderId: 'render-1' },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(RenderNotFoundError);
    });

    it('unknown render throws RenderNotFoundError', async () => {
      const handler = createGguiCloseHandler({ renderStore });
      await expect(
        handler.handler(
          { renderId: 'never' },
          { appId: 'app-1', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(RenderNotFoundError);
    });
  });

  describe('markCompleted seam', () => {
    it('when set, used in place of appendEvent — receives renderId', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const calls: string[] = [];
      const handler = createGguiCloseHandler({
        renderStore,
        markCompleted: async (rid) => {
          calls.push(rid);
          return true;
        },
      });
      const out = await handler.handler(
        { renderId: 'render-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.success).toBe(true);
      expect(calls).toEqual(['render-1']);
    });

    it('surfaces success=false when markCompleted returns false', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const handler = createGguiCloseHandler({
        renderStore,
        markCompleted: () => false,
      });
      const out = await handler.handler(
        { renderId: 'render-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.success).toBe(false);
    });

    it('does NOT fire appendEvent when markCompleted is set', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const handler = createGguiCloseHandler({
        renderStore,
        markCompleted: () => true,
      });
      await handler.handler(
        { renderId: 'render-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      // Render should NOT be marked completed via the OSS event log
      // when markCompleted is wired — the OSS event log only sees
      // entries from the appendEvent path.
      const active = await renderStore.list({
        appId: 'app-1',
        status: 'active',
      });
      expect(active.find((r) => r.id === 'render-1')).toBeDefined();
    });
  });

  describe('observer notifier seam', () => {
    it('fires after a successful close with appId + renderId', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const calls: Parameters<CloseObserverNotifier['notifyRenderClosed']>[0][] = [];
      const observer: CloseObserverNotifier = {
        notifyRenderClosed: (args) => {
          calls.push(args);
        },
      };
      const handler = createGguiCloseHandler({
        renderStore,
        observerNotifier: observer,
      });
      await handler.handler(
        { renderId: 'render-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ appId: 'app-1', renderId: 'render-1' });
    });

    it('observer throw is swallowed — close still succeeds', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const handler = createGguiCloseHandler({
        renderStore,
        observerNotifier: {
          notifyRenderClosed: () => {
            throw new Error('observer exploded');
          },
        },
      });
      const out = await handler.handler(
        { renderId: 'render-1' },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.success).toBe(true);
    });

    it('observer does NOT fire when tenancy gate rejects', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const calls: number[] = [];
      const handler = createGguiCloseHandler({
        renderStore,
        observerNotifier: {
          notifyRenderClosed: () => {
            calls.push(1);
          },
        },
      });
      await expect(
        handler.handler(
          { renderId: 'render-1' },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(RenderNotFoundError);
      expect(calls).toHaveLength(0);
    });
  });

  describe('shortCode revocation (capability-URL hardening)', () => {
    // Note: ShortCodeIndex's public API still uses the `sessionId` field
    // name on its binding shape. Phase B threads the `renderId` value
    // through `revokeBySessionId(renderId)` at the call site — the
    // index treats the string opaquely, so renderId-as-lookup-key works
    // without an index migration.
    it('revokes every /r/<code> URL bound to the closing render', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const shortCodeIndex = new InMemoryShortCodeIndex();
      await shortCodeIndex.put('code-a', {
        sessionId: 'render-1',
        appId: 'app-1',
      });
      await shortCodeIndex.put('code-b', {
        sessionId: 'render-1',
        appId: 'app-1',
      });
      // Unrelated render's code stays.
      await shortCodeIndex.put('code-x', {
        sessionId: 'render-other',
        appId: 'app-1',
      });

      const handler = createGguiCloseHandler({ renderStore, shortCodeIndex });
      await handler.handler(
        { renderId: 'render-1' },
        { appId: 'app-1', requestId: 'r1' },
      );

      expect(await shortCodeIndex.lookup('code-a')).toBeNull();
      expect(await shortCodeIndex.lookup('code-b')).toBeNull();
      expect(await shortCodeIndex.lookup('code-x')).not.toBeNull();
    });

    it('revocation does not fire when tenancy gate rejects', async () => {
      await seedRender(renderStore, 'render-1', 'app-1');
      const shortCodeIndex = new InMemoryShortCodeIndex();
      await shortCodeIndex.put('code-a', {
        sessionId: 'render-1',
        appId: 'app-1',
      });
      const handler = createGguiCloseHandler({ renderStore, shortCodeIndex });
      await expect(
        handler.handler(
          { renderId: 'render-1' },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(RenderNotFoundError);
      // Wrong tenant must not be able to revoke another tenant's URLs.
      expect(await shortCodeIndex.lookup('code-a')).not.toBeNull();
    });
  });
});
