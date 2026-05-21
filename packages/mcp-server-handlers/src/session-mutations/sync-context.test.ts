import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionStore } from '@ggui-ai/mcp-server-core';
import { InMemorySessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { ContextSpec, JsonObject, StackItem } from '@ggui-ai/protocol';
import { createGguiSyncContextHandler } from './sync-context';

const NOW = '2026-05-10T00:00:00.000Z';

async function seedSessionWithItem(
  sessionStore: SessionStore,
  args: {
    sessionId: string;
    appId: string;
    stackItemId: string;
    contextSpec?: ContextSpec;
    contextSnapshot?: JsonObject;
  },
): Promise<void> {
  await sessionStore.create({ id: args.sessionId, appId: args.appId });
  const item: StackItem = {
    id: args.stackItemId,
    type: 'component',
    componentCode: 'export default () => null;',
    createdAt: NOW,
    ...(args.contextSpec ? { contextSpec: args.contextSpec } : {}),
    ...(args.contextSnapshot ? { contextSnapshot: args.contextSnapshot } : {}),
  };
  await sessionStore.appendStackItem(args.sessionId, item);
}

describe('createGguiSyncContextHandler', () => {
  let sessionStore: SessionStore;
  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes the canonical tool name ggui_runtime_sync_context', () => {
      const handler = createGguiSyncContextHandler({ sessionStore });
      expect(handler.name).toBe('ggui_runtime_sync_context');
    });

    it('stamps _meta.ui.visibility = ["app"] (spec §401 — iframe-callable only)', () => {
      const handler = createGguiSyncContextHandler({ sessionStore });
      const ui = (handler._meta as { ui: { visibility: readonly string[] } }).ui;
      expect(ui.visibility).toEqual(['app']);
    });
  });

  describe('happy path — snapshot upserts onto stack item', () => {
    it('writes the snapshot onto the active stack item', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: {
          count: { schema: { type: 'number' }, default: 0 },
          noteText: { schema: { type: 'string' }, default: '' },
        },
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          snapshot: { count: 5, noteText: 'hello' },
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(true);
      const session = await sessionStore.get('sess-1');
      const top = session?.stack[0];
      expect(top && 'contextSnapshot' in top ? top.contextSnapshot : undefined).toEqual(
        { count: 5, noteText: 'hello' },
      );
    });

    it('REPLACE semantics: second snapshot overwrites first (no merge)', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: {
          count: { schema: { type: 'number' }, default: 0 },
          noteText: { schema: { type: 'string' }, default: '' },
        },
        contextSnapshot: { count: 1, noteText: 'first' },
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          // Only count — no noteText. REPLACE means noteText should
          // disappear from the snapshot, not silently persist.
          snapshot: { count: 2 },
        },
        { appId: 'app-1', requestId: 'r' },
      );
      const session = await sessionStore.get('sess-1');
      const top = session?.stack[0];
      expect(top && 'contextSnapshot' in top ? top.contextSnapshot : undefined).toEqual(
        { count: 2 },
      );
    });

    it('empty snapshot is a no-op upsert (idempotent)', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          snapshot: {},
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(true);
    });
  });

  describe('schema validation against contextSpec', () => {
    it('rejects type-mismatched slot value with CONTEXT_SCHEMA_VIOLATION', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          // count: '5' (string) violates the declared `type: 'number'`.
          snapshot: { count: '5' },
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.code).toBe('CONTEXT_SCHEMA_VIOLATION');
        // Per-slot violations were retired from the output (2026-05-13
        // trim — iframe-runtime never branched on the structured list).
        // The composed message carries the per-slot summary instead.
        expect(out.message).toMatch(/violates contextSpec/);
      }
    });

    it('rejects undeclared slot with CONTEXT_SCHEMA_VIOLATION', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          // foo isn't in contextSpec — strict reject.
          snapshot: { foo: 'bar' },
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.code).toBe('CONTEXT_SCHEMA_VIOLATION');
      }
    });

    it('rejects snapshot when contract declares no contextSpec', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        // No contextSpec.
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          snapshot: { count: 5 },
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe('CONTEXT_SCHEMA_VIOLATION');
    });
  });

  describe('failure modes', () => {
    it('rejects unknown sessionId with SESSION_NOT_FOUND', async () => {
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'never-minted',
          appId: 'app-1',
          stackItemId: 'page-1',
          snapshot: {},
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe('SESSION_NOT_FOUND');
    });

    it('rejects cross-tenant snapshot with TENANT_MISMATCH', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-A',
        stackItemId: 'page-1',
        contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          // Caller declares app-B but session is bound to app-A.
          appId: 'app-B',
          stackItemId: 'page-1',
          snapshot: { count: 5 },
        },
        { appId: 'app-B', requestId: 'r' },
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe('TENANT_MISMATCH');
    });

    it('rejects unknown stackItemId with STACK_ITEM_NOT_FOUND', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'never-pushed',
          snapshot: {},
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe('STACK_ITEM_NOT_FOUND');
    });
  });

  // PIPE-2 (2026-05-12) — contextSpec is observable state for the
  // agent, NOT content storage. Snapshots that breach the bounds
  // reject with CONTEXT_TOO_LARGE so authors notice and route bulky
  // data through propsSpec / streamSpec / a tool call.
  describe('size limits (CONTEXT_TOO_LARGE)', () => {
    it('rejects per-slot value above 16KB', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: { blob: { schema: { type: 'string' }, default: '' } },
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const big = 'a'.repeat(17 * 1024); // 17 KB
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          snapshot: { blob: big },
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.code).toBe('CONTEXT_TOO_LARGE');
        expect(out.message).toMatch(/slot "blob"/);
      }
    });

    it('rejects total snapshot above 64KB even when each slot is under the per-slot cap', async () => {
      const spec: ContextSpec = {};
      for (let i = 0; i < 10; i++) {
        spec[`slot${i}`] = { schema: { type: 'string' }, default: '' };
      }
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: spec,
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const fifteenKb = 'b'.repeat(15 * 1024 - 2); // 15 KB-ish in JSON quoting
      const snapshot: Record<string, unknown> = {};
      // 5 × 15 KB = 75 KB > 64 KB but each slot is under 16 KB.
      for (let i = 0; i < 5; i++) snapshot[`slot${i}`] = fifteenKb;
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          snapshot,
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.code).toBe('CONTEXT_TOO_LARGE');
        expect(out.message).toMatch(/snapshot total exceeds/);
      }
    });

    it('rejects snapshot with more than 50 slot entries', async () => {
      const spec: ContextSpec = {};
      const snapshot: Record<string, unknown> = {};
      for (let i = 0; i < 60; i++) {
        spec[`s${i}`] = { schema: { type: 'number' }, default: 0 };
        snapshot[`s${i}`] = i;
      }
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: spec,
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          snapshot,
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.code).toBe('CONTEXT_TOO_LARGE');
        expect(out.message).toMatch(/60 slots; max 50/);
      }
    });

    it('accepts a small snapshot at the boundary', async () => {
      await seedSessionWithItem(sessionStore, {
        sessionId: 'sess-1',
        appId: 'app-1',
        stackItemId: 'page-1',
        contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      });
      const handler = createGguiSyncContextHandler({ sessionStore });
      const out = await handler.handler(
        {
          sessionId: 'sess-1',
          appId: 'app-1',
          stackItemId: 'page-1',
          snapshot: { count: 42 },
        },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.ok).toBe(true);
    });
  });
});
