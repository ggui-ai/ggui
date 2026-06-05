import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import type {
  ComponentGguiSession,
  ContextSpec,
  JsonObject,
} from '@ggui-ai/protocol';
import { createGguiSyncContextHandler } from './sync-context.js';

/**
 * Tests for `createGguiSyncContextHandler`.
 *
 * Post-Phase-B (flatten-render-identity): the wire input collapsed
 * from `{sessionId, stackItemId, appId, snapshot}` to
 * `{sessionId, appId, snapshot}`. The reject codes
 * `SESSION_NOT_FOUND` + `STACK_ITEM_NOT_FOUND` collapsed to one
 * `SESSION_NOT_FOUND`. The snapshot lands on the render's
 * `contextSnapshot` field via `renderStore.commit`.
 */

const NOW_MS = Date.parse('2026-05-10T00:00:00.000Z');

async function seedRender(
  store: InMemoryGguiSessionStore,
  opts: {
    sessionId?: string;
    appId?: string;
    contextSpec?: ContextSpec;
    initialSnapshot?: JsonObject;
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
    ...(opts.contextSpec ? { contextSpec: opts.contextSpec } : {}),
    ...(opts.initialSnapshot ? { contextSnapshot: opts.initialSnapshot } : {}),
  };
  await store.commit({ render, appId });
  return { sessionId };
}

describe('createGguiSyncContextHandler', () => {
  let renderStore: InMemoryGguiSessionStore;

  beforeEach(() => {
    renderStore = new InMemoryGguiSessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes the canonical tool name ggui_runtime_sync_context', () => {
      const h = createGguiSyncContextHandler({ renderStore });
      expect(h.name).toBe('ggui_runtime_sync_context');
    });

    it('stamps _meta.ui.visibility = ["app"] (spec §401 — iframe-callable only)', () => {
      const h = createGguiSyncContextHandler({ renderStore });
      const meta = h._meta as
        | { ui?: { visibility?: readonly string[] } }
        | undefined;
      expect(meta?.ui?.visibility).toEqual(['app']);
    });
  });

  describe('happy path — snapshot upserts onto render', () => {
    it('writes the snapshot onto the render', async () => {
      const contextSpec: ContextSpec = {
        count: { schema: { type: 'number' }, default: 0 },
      };
      const { sessionId } = await seedRender(renderStore, { contextSpec });
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        {
          sessionId,
          appId: 'app-1',
          snapshot: { count: 7 },
        },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(true);
      const stored = await renderStore.get(sessionId);
      expect((stored?.render as ComponentGguiSession).contextSnapshot).toEqual({
        count: 7,
      });
    });

    it('REPLACE semantics: second snapshot overwrites first (no merge)', async () => {
      const contextSpec: ContextSpec = {
        count: { schema: { type: 'number' }, default: 0 },
        text: { schema: { type: 'string' }, default: '' },
      };
      const { sessionId } = await seedRender(renderStore, {
        contextSpec,
        initialSnapshot: { count: 5, text: 'first' },
      });
      const h = createGguiSyncContextHandler({ renderStore });
      // Second snapshot omits `text` — REPLACE drops it (no merge).
      await h.handler(
        {
          sessionId,
          appId: 'app-1',
          snapshot: { count: 9 },
        },
        { appId: 'app-1', requestId: 'r2' },
      );
      const stored = await renderStore.get(sessionId);
      expect((stored?.render as ComponentGguiSession).contextSnapshot).toEqual({
        count: 9,
      });
    });

    it('empty snapshot is a no-op upsert (idempotent)', async () => {
      const contextSpec: ContextSpec = {
        count: { schema: { type: 'number' }, default: 0 },
      };
      const { sessionId } = await seedRender(renderStore, { contextSpec });
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        { sessionId, appId: 'app-1', snapshot: {} },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(true);
    });
  });

  describe('schema validation against contextSpec', () => {
    it('rejects type-mismatched slot value with CONTEXT_SCHEMA_VIOLATION', async () => {
      const contextSpec: ContextSpec = {
        count: { schema: { type: 'number' }, default: 0 },
      };
      const { sessionId } = await seedRender(renderStore, { contextSpec });
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        {
          sessionId,
          appId: 'app-1',
          snapshot: { count: 'not a number' },
        },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected reject');
      expect(out.code).toBe('CONTEXT_SCHEMA_VIOLATION');
    });

    it('rejects undeclared slot with CONTEXT_SCHEMA_VIOLATION', async () => {
      const contextSpec: ContextSpec = {
        count: { schema: { type: 'number' }, default: 0 },
      };
      const { sessionId } = await seedRender(renderStore, { contextSpec });
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        {
          sessionId,
          appId: 'app-1',
          snapshot: { count: 5, undeclared: 'value' },
        },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected reject');
      expect(out.code).toBe('CONTEXT_SCHEMA_VIOLATION');
    });

    it('rejects snapshot when contract declares no contextSpec', async () => {
      const { sessionId } = await seedRender(renderStore);
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        {
          sessionId,
          appId: 'app-1',
          snapshot: { anything: 'goes' },
        },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected reject');
      expect(out.code).toBe('CONTEXT_SCHEMA_VIOLATION');
    });
  });

  describe('failure modes', () => {
    it('rejects unknown sessionId with SESSION_NOT_FOUND', async () => {
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        {
          sessionId: 'never-existed',
          appId: 'app-1',
          snapshot: {},
        },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected reject');
      expect(out.code).toBe('SESSION_NOT_FOUND');
    });

    it('rejects cross-tenant snapshot with TENANT_MISMATCH', async () => {
      const { sessionId } = await seedRender(renderStore, { appId: 'app-1' });
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        {
          sessionId,
          appId: 'app-OTHER',
          snapshot: {},
        },
        // Note: handler reads the appId off the wire payload (the
        // bootstrap-captured appId), NOT off ctx — tenancy gate
        // compares wire-appId to render-appId.
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected reject');
      expect(out.code).toBe('TENANT_MISMATCH');
    });
  });

  describe('size limits (CONTEXT_TOO_LARGE)', () => {
    it('rejects per-slot value above 16KB', async () => {
      const contextSpec: ContextSpec = {
        blob: { schema: { type: 'string' }, default: '' },
      };
      const { sessionId } = await seedRender(renderStore, { contextSpec });
      const h = createGguiSyncContextHandler({ renderStore });
      const oversize = 'x'.repeat(17 * 1024);
      const out = await h.handler(
        { sessionId, appId: 'app-1', snapshot: { blob: oversize } },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected reject');
      expect(out.code).toBe('CONTEXT_TOO_LARGE');
    });

    it('rejects total snapshot above 64KB even when each slot is under the per-slot cap', async () => {
      const contextSpec: ContextSpec = {};
      // 6 slots * 12KB each = 72KB total — each under the 16KB
      // per-slot cap but over the 64KB total cap.
      const snapshot: Record<string, string> = {};
      const slotValue = 'x'.repeat(12 * 1024);
      for (let i = 0; i < 6; i += 1) {
        const slot = `slot${i}`;
        contextSpec[slot] = { schema: { type: 'string' }, default: '' };
        snapshot[slot] = slotValue;
      }
      const { sessionId } = await seedRender(renderStore, { contextSpec });
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        { sessionId, appId: 'app-1', snapshot },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected reject');
      expect(out.code).toBe('CONTEXT_TOO_LARGE');
    });

    it('rejects snapshot with more than 50 slot entries', async () => {
      const contextSpec: ContextSpec = {};
      const snapshot: Record<string, number> = {};
      for (let i = 0; i < 51; i += 1) {
        const slot = `slot${i}`;
        contextSpec[slot] = { schema: { type: 'number' }, default: 0 };
        snapshot[slot] = i;
      }
      const { sessionId } = await seedRender(renderStore, { contextSpec });
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        { sessionId, appId: 'app-1', snapshot },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('expected reject');
      expect(out.code).toBe('CONTEXT_TOO_LARGE');
    });

    it('accepts a small snapshot at the boundary', async () => {
      const contextSpec: ContextSpec = {
        count: { schema: { type: 'number' }, default: 0 },
      };
      const { sessionId } = await seedRender(renderStore, { contextSpec });
      const h = createGguiSyncContextHandler({ renderStore });
      const out = await h.handler(
        { sessionId, appId: 'app-1', snapshot: { count: 1 } },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.ok).toBe(true);
    });
  });
});
