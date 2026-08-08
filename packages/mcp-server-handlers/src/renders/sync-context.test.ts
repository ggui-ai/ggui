import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  InMemoryGguiSessionStore,
  InMemoryRenderIdentityStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  RenderIdentityRecord,
  RenderIdentityStore,
} from '@ggui-ai/mcp-server-core';
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

/**
 * Durable render-identity refresh (#430 slice 1).
 *
 * Context sync re-commits the render row, so the identity record's
 * freshness stamp has to follow. Note what it does NOT carry: the
 * record has no `contextSnapshot` field, so the snapshot this tool
 * just persisted is not part of the durable identity — only
 * `updatedAt` (and, on a row whose props or sequence moved, those)
 * change here.
 *
 * The identity fields stay frozen for the same reason as on update:
 * `blueprintKey` is not recomputable from a render row.
 */
describe('createGguiSyncContextHandler — render-identity refresh (#430 slice 1)', () => {
  const CONTRACT_KEY = 'fedcba9876543210';
  const BLUEPRINT_ID = 'bp_55555555-5555-4555-8555-555555555555';
  const VARIANT_KEY = 'variant-fixed';
  const CONTEXT_SPEC: ContextSpec = {
    count: { schema: { type: 'number' }, default: 0 },
  };

  function seededRecord(sessionId: string): RenderIdentityRecord {
    return {
      sessionId,
      appId: 'app-1',
      blueprintId: BLUEPRINT_ID,
      contractKey: CONTRACT_KEY,
      variantKey: VARIANT_KEY,
      props: { count: 0 },
      seqAtLastCommit: 0,
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    };
  }

  /** A skipped refresh — no record to update, so no error either. */
  interface SkippedEvent {
    readonly msg: string;
    readonly sessionId: string;
    readonly reason: string;
  }
  /** A failed write — carries the caught error and its tenancy. */
  interface FailedEvent {
    readonly msg: string;
    readonly sessionId: string;
    readonly appId: string;
    readonly error: string;
  }

  function namedEvents<T>(
    warn: ReturnType<typeof vi.spyOn>,
    event: string,
  ): readonly T[] {
    return warn.mock.calls
      .map(([first]) => (typeof first === 'string' ? first : ''))
      .filter((line) => line.includes(event))
      .map((line) => JSON.parse(line) as T);
  }

  it('refreshes updatedAt off the committed row and leaves the identity fields untouched', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender(store, { contextSpec: CONTEXT_SPEC });
    const renderIdentityStore = new InMemoryRenderIdentityStore();
    await renderIdentityStore.put(seededRecord(sessionId));

    const h = createGguiSyncContextHandler({ renderStore: store, renderIdentityStore });
    const out = await h.handler(
      { sessionId, appId: 'app-1', snapshot: { count: 3 } },
      { appId: 'app-1', requestId: 'r-1' },
    );
    expect(out.ok).toBe(true);

    const record = await renderIdentityStore.get(sessionId);
    expect(record).not.toBeNull();
    if (!record) return;

    const stored = await store.get(sessionId);
    expect(record.updatedAt).toBeGreaterThan(NOW_MS);
    expect(record.seqAtLastCommit).toBe(stored?.eventSequence);
    expect(record.blueprintId).toBe(BLUEPRINT_ID);
    expect(record.contractKey).toBe(CONTRACT_KEY);
    expect(record.variantKey).toBe(VARIANT_KEY);
    // `createdAt` tracks the ROW, not the write — a refresh cannot
    // drift it forward the way `updatedAt` moves.
    expect(record.createdAt).toBe(stored?.createdAt);
  });

  it('no existing record — skips with render_identity_refresh_skipped and the sync still succeeds', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender(store, { contextSpec: CONTEXT_SPEC });
    const renderIdentityStore = new InMemoryRenderIdentityStore();

    // The skip is emitted at DEBUG, not warn — severity is part of the
    // event's contract and this path is not actionable.
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      const h = createGguiSyncContextHandler({ renderStore: store, renderIdentityStore });
      const out = await h.handler(
        { sessionId, appId: 'app-1', snapshot: { count: 3 } },
        { appId: 'app-1', requestId: 'r-1' },
      );
      expect(out.ok).toBe(true);
      expect(await renderIdentityStore.get(sessionId)).toBeNull();

      const events = namedEvents<SkippedEvent>(debug, 'render_identity_refresh_skipped');
      expect(events).toHaveLength(1);
      expect(events[0]?.sessionId).toBe(sessionId);
      expect(events[0]?.reason).toBe('no-record');
    } finally {
      debug.mockRestore();
    }
  });

  it('a rejecting identity store cannot fail the sync — logs render_identity_refresh_failed', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender(store, { contextSpec: CONTEXT_SPEC });
    const rejecting: RenderIdentityStore = {
      get: async () => seededRecord(sessionId),
      put: async () => {
        throw new Error('identity store offline');
      },
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = createGguiSyncContextHandler({
        renderStore: store,
        renderIdentityStore: rejecting,
      });
      const out = await h.handler(
        { sessionId, appId: 'app-1', snapshot: { count: 3 } },
        { appId: 'app-1', requestId: 'r-1' },
      );
      expect(out.ok).toBe(true);

      const events = namedEvents<FailedEvent>(warn, 'render_identity_refresh_failed');
      expect(events).toHaveLength(1);
      expect(events[0]?.sessionId).toBe(sessionId);
      expect(events[0]?.appId).toBe('app-1');
      expect(events[0]?.error).toBe('identity store offline');
    } finally {
      warn.mockRestore();
    }
  });

  it('a throwing get cannot fail the sync — logs render_identity_refresh_failed', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender(store, { contextSpec: CONTEXT_SPEC });
    // The read half of get→merge→put, caught separately from `put`.
    const throwingGet: RenderIdentityStore = {
      get: async () => {
        throw new Error('identity store unreachable');
      },
      put: async () => {},
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = createGguiSyncContextHandler({
        renderStore: store,
        renderIdentityStore: throwingGet,
      });
      const out = await h.handler(
        { sessionId, appId: 'app-1', snapshot: { count: 3 } },
        { appId: 'app-1', requestId: 'r-1' },
      );
      expect(out.ok).toBe(true);

      const events = namedEvents<FailedEvent>(warn, 'render_identity_refresh_failed');
      expect(events).toHaveLength(1);
      expect(events[0]?.sessionId).toBe(sessionId);
      expect(events[0]?.appId).toBe('app-1');
      expect(events[0]?.error).toBe('identity store unreachable');
    } finally {
      warn.mockRestore();
    }
  });

  it('a record whose cold-gen backfill never landed keeps blueprintId null', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender(store, { contextSpec: CONTEXT_SPEC });
    const renderIdentityStore = new InMemoryRenderIdentityStore();
    await renderIdentityStore.put({ ...seededRecord(sessionId), blueprintId: null });

    const h = createGguiSyncContextHandler({
      renderStore: store,
      renderIdentityStore,
    });
    await h.handler(
      { sessionId, appId: 'app-1', snapshot: { count: 3 } },
      { appId: 'app-1', requestId: 'r-1' },
    );

    const record = await renderIdentityStore.get(sessionId);
    expect(record?.blueprintId).toBeNull();
    expect(record?.contractKey).toBe(CONTRACT_KEY);
    expect(record?.variantKey).toBe(VARIANT_KEY);
  });

  it('no identity store bound — the sync still succeeds', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender(store, { contextSpec: CONTEXT_SPEC });
    const h = createGguiSyncContextHandler({ renderStore: store });
    const out = await h.handler(
      { sessionId, appId: 'app-1', snapshot: { count: 3 } },
      { appId: 'app-1', requestId: 'r-1' },
    );
    expect(out.ok).toBe(true);
  });
});
