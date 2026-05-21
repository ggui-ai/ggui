/**
 * `ggui_update` OSS handler tests — declaration, direct path,
 * propsSpec enforcement, tenancy gate, handshake-paired rejection,
 * notifier fan-out.
 */
import { describe, expect, it } from 'vitest';
import {
  ContractViolationError,
  type JsonObject,
  type PropsSpec,
  type StackItem,
} from '@ggui-ai/protocol';
import { InMemorySessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiUpdateHandler,
  StackItemNotFoundError,
  type PropsUpdateNotifier,
} from './update';

const APP_A = 'app-a';
const APP_B = 'app-b';
const ctx = (appId = APP_A) => ({ appId, requestId: 'r-1' });

/** Build a session with a single propsSpec'd stack item already on it. */
async function seedSession(opts: {
  store: InMemorySessionStore;
  appId?: string;
  sessionId?: string;
  stackItemId?: string;
  propsSpec?: PropsSpec;
  initialProps?: JsonObject;
}): Promise<{ sessionId: string; stackItemId: string }> {
  const session = await opts.store.create({
    id: opts.sessionId ?? 'sess-1',
    appId: opts.appId ?? APP_A,
  });
  const stackItemId = opts.stackItemId ?? 'page-1';
  const stackItem: StackItem = {
    id: stackItemId,
    componentCode: 'export default function X(){return null}',
    props: opts.initialProps ?? { count: 0 },
    ...(opts.propsSpec ? { propsSpec: opts.propsSpec } : {}),
    createdAt: new Date().toISOString(),
  };
  await opts.store.appendStackItem(session.id, stackItem);
  return { sessionId: session.id, stackItemId };
}

describe('createGguiUpdateHandler', () => {
  describe('declaration', () => {
    it('exposes the canonical tool name ggui_update', () => {
      const store = new InMemorySessionStore();
      const handler = createGguiUpdateHandler({ sessionStore: store });
      expect(handler.name).toBe('ggui_update');
    });

    it('declares the lean updateOutputSchema shape — {stackItemId, updated}', () => {
      const store = new InMemorySessionStore();
      const handler = createGguiUpdateHandler({ sessionStore: store });
      const outKeys = Object.keys(handler.outputSchema).sort();
      // Post-2026-05-13 trim: decision/contract/interaction/contractHash
      // echo fields retired (push.ts set the bar; update follows). The
      // internal `sessionId` survives on the TS type for resultMeta's
      // bootstrap projection but zod strips it before serialization.
      expect(outKeys).toEqual(['stackItemId', 'updated']);
    });

    it('does NOT carry any MCP Apps _meta stamp — update is a pure mutation', () => {
      const store = new InMemorySessionStore();
      const handler = createGguiUpdateHandler({ sessionStore: store });
      expect(handler._meta).toBeUndefined();
    });
  });

  describe('direct path', () => {
    it('replaces props on the targeted stack item via sessionStore.appendStackItem upsert', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({ store });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      const out = await handler.handler(
        { stackItemId, kind: 'replace' as const, props: { count: 7 } },
        ctx(),
      );

      expect(out).toEqual({ sessionId, stackItemId, updated: true });
      const after = await store.get(sessionId);
      expect(after?.stack[0]?.props).toEqual({ count: 7 });
      // Stack length unchanged — upsert by id replaced in-place.
      expect(after?.stack).toHaveLength(1);
    });

    it('preserves stack position when patching a non-tail entry', async () => {
      const store = new InMemorySessionStore();
      const { sessionId } = await seedSession({
        store,
        sessionId: 's',
        stackItemId: 'p1',
      });
      // Append a second item so p1 is no longer the tail.
      await store.appendStackItem(sessionId, {
        id: 'p2',
        componentCode: 'export default function Y(){return null}',
        props: {},
        createdAt: new Date().toISOString(),
      } satisfies StackItem);

      const handler = createGguiUpdateHandler({ sessionStore: store });
      await handler.handler(
        { stackItemId: 'p1', kind: 'replace' as const, props: { count: 99 } },
        ctx(),
      );

      const after = await store.get(sessionId);
      // p1 still at index 0 (upsert preserves position).
      expect(after?.stack.map((item) => item.id)).toEqual(['p1', 'p2']);
      expect(after?.stack[0]?.props).toEqual({ count: 99 });
    });

    it('falls back to HandlerContext.sessionId / stackItemId when wire input omits them', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({ store });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      // Wire input: only `patch`. Ctx carries the target — this is the
      // future live-channel dispatch shape (Option A widening).
      const out = await handler.handler({ kind: 'replace' as const, props: { count: 42 } },
        { ...ctx(), sessionId, stackItemId },
      );

      expect(out).toEqual({ sessionId, stackItemId, updated: true });
    });

    it('wire input overrides HandlerContext when both are present', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({ store });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      // Ctx says (decoy, decoy); wire says (real, real). Wire wins.
      const out = await handler.handler(
        { stackItemId, kind: 'replace' as const, props: { count: 1 } },
        { ...ctx(), sessionId: 'wrong-sess', stackItemId: 'wrong-page' },
      );

      expect(out.sessionId).toBe(sessionId);
      expect(out.stackItemId).toBe(stackItemId);
    });
  });

  describe('propsSpec enforcement', () => {
    it('throws ContractViolationError{tool:ggui_update} on a missing required field', async () => {
      const store = new InMemorySessionStore();
      const propsSpec: PropsSpec = {
        properties: {
          count: { required: true, schema: { type: 'number' } },
        },
      };
      const { stackItemId } = await seedSession({ store, propsSpec });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await expect(
        handler.handler({ stackItemId, kind: 'replace' as const, props: {} }, ctx()),
      ).rejects.toThrow(ContractViolationError);
    });

    it('passes when patch satisfies propsSpec', async () => {
      const store = new InMemorySessionStore();
      const propsSpec: PropsSpec = {
        properties: {
          count: { required: true, schema: { type: 'number' } },
        },
      };
      const { stackItemId } = await seedSession({ store, propsSpec });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      const out = await handler.handler(
        { stackItemId, kind: 'replace' as const, props: { count: 5 } },
        ctx(),
      );
      expect(out.updated).toBe(true);
    });

    it('no-ops the contract check when the stack item carries no propsSpec', async () => {
      const store = new InMemorySessionStore();
      // No propsSpec → permissive (matches legacy semantics).
      const { stackItemId } = await seedSession({ store });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      const out = await handler.handler(
        { stackItemId, kind: 'replace' as const, props: { anything: 'goes' } },
        ctx(),
      );
      expect(out.updated).toBe(true);
    });
  });

  describe('merge mode (RFC 7396)', () => {
    it('merges a flat patch onto existing props', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({
        store,
        initialProps: { temp: 20, condition: 'sunny', city: 'Berlin' },
      });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      const out = await handler.handler(
        { stackItemId, kind: 'merge' as const, patch: { temp: 25 } },
        ctx(),
      );

      expect(out).toEqual({ sessionId, stackItemId, updated: true });
      const after = await store.get(sessionId);
      // Only `temp` changes; `condition` and `city` carry through.
      expect(after?.stack[0]?.props).toEqual({
        temp: 25,
        condition: 'sunny',
        city: 'Berlin',
      });
    });

    it('deletes a key when the patch value is null (RFC 7396 semantic)', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({
        store,
        initialProps: { temp: 20, alert: 'storm warning' },
      });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await handler.handler(
        { stackItemId, kind: 'merge' as const, patch: { alert: null } },
        ctx(),
      );

      const after = await store.get(sessionId);
      expect(after?.stack[0]?.props).toEqual({ temp: 20 });
      // `alert` removed entirely (not set to null).
      expect('alert' in (after?.stack[0]?.props ?? {})).toBe(false);
    });

    it('deep-merges nested objects (RFC 7396 recursion)', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({
        store,
        initialProps: {
          user: { name: 'Alice', age: 30, theme: 'dark' },
        },
      });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await handler.handler(
        {
          stackItemId,
          kind: 'merge' as const,
          patch: { user: { age: 31 } },
        },
        ctx(),
      );

      const after = await store.get(sessionId);
      // `name` and `theme` carry through; only `age` changes.
      expect(after?.stack[0]?.props).toEqual({
        user: { name: 'Alice', age: 31, theme: 'dark' },
      });
    });

    it('fully replaces arrays (RFC 7396 — no element-wise merge)', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({
        store,
        initialProps: { tags: ['a', 'b', 'c'] },
      });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await handler.handler(
        { stackItemId, kind: 'merge' as const, patch: { tags: ['x'] } },
        ctx(),
      );

      const after = await store.get(sessionId);
      expect(after?.stack[0]?.props).toEqual({ tags: ['x'] });
    });

    it('validates the MERGED RESULT against propsSpec, not the patch alone', async () => {
      const store = new InMemorySessionStore();
      const propsSpec: PropsSpec = {
        properties: {
          count: { required: true, schema: { type: 'number' } },
        },
      };
      // Seed satisfies propsSpec.
      const { stackItemId } = await seedSession({
        store,
        propsSpec,
        initialProps: { count: 5 },
      });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      // Patch nulls out the required `count` field — merged result is
      // {}, which violates the propsSpec. Reject.
      await expect(
        handler.handler(
          { stackItemId, kind: 'merge' as const, patch: { count: null } },
          ctx(),
        ),
      ).rejects.toThrow(ContractViolationError);
    });

    it('rejects merge mode without a patch field', async () => {
      const store = new InMemorySessionStore();
      const { stackItemId } = await seedSession({ store });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await expect(
        handler.handler(
          { stackItemId, kind: 'merge' as const } as never,
          ctx(),
        ),
      ).rejects.toThrow(ContractViolationError);
    });

    it('rejects replace mode without a props field', async () => {
      const store = new InMemorySessionStore();
      const { stackItemId } = await seedSession({ store });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await expect(
        handler.handler(
          { stackItemId, kind: 'replace' as const } as never,
          ctx(),
        ),
      ).rejects.toThrow(ContractViolationError);
    });

    it('rejects replace mode that also carries a patch field', async () => {
      const store = new InMemorySessionStore();
      const { stackItemId } = await seedSession({ store });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await expect(
        handler.handler(
          {
            stackItemId,
            kind: 'replace' as const,
            props: { temp: 24 },
            patch: { temp: 25 },
          } as never,
          ctx(),
        ),
      ).rejects.toThrow(ContractViolationError);
    });
  });

  describe('errors', () => {
    it('throws StackItemNotFoundError when stackItemId is not in the stack', async () => {
      const store = new InMemorySessionStore();
      await seedSession({ store });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await expect(
        handler.handler(
          { stackItemId: 'never-existed', kind: 'replace' as const, props: { x: 1 } },
          ctx(),
        ),
      ).rejects.toThrow(StackItemNotFoundError);
    });

    it('throws StackItemNotFoundError when the stackItemId does not exist', async () => {
      const store = new InMemorySessionStore();
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await expect(
        handler.handler(
          { stackItemId: 'no-such-page', kind: 'replace' as const, props: {} },
          ctx(),
        ),
      ).rejects.toThrow(StackItemNotFoundError);
    });

    it('rejects cross-tenant access as StackItemNotFoundError (no leak)', async () => {
      const store = new InMemorySessionStore();
      // Seed a session owned by APP_A.
      const { stackItemId } = await seedSession({ store });
      const handler = createGguiUpdateHandler({ sessionStore: store });

      // Caller is APP_B — same shape as "page does not exist".
      await expect(
        handler.handler(
          { stackItemId, kind: 'replace' as const, props: { x: 1 } },
          ctx(APP_B),
        ),
      ).rejects.toThrow(StackItemNotFoundError);
    });

    it('rejects when neither wire nor ctx carries stackItemId', async () => {
      const store = new InMemorySessionStore();
      const handler = createGguiUpdateHandler({ sessionStore: store });

      await expect(
        handler.handler({ kind: 'replace' as const, props: { x: 1 } }, ctx()),
      ).rejects.toThrow(StackItemNotFoundError);
    });
  });

  describe('live-delivery notifier', () => {
    it('fires propsUpdateNotifier.sendPropsUpdate after persistence', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({ store });

      const calls: Array<{
        sessionId: string;
        stackItemId: string;
        props: JsonObject;
      }> = [];
      const propsUpdateNotifier: PropsUpdateNotifier = {
        async sendPropsUpdate(s, p, props) {
          calls.push({ sessionId: s, stackItemId: p, props });
        },
      };

      const handler = createGguiUpdateHandler({
        sessionStore: store,
        propsUpdateNotifier,
      });
      await handler.handler(
        { stackItemId, kind: 'replace' as const, props: { count: 11 } },
        ctx(),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        sessionId,
        stackItemId,
        props: { count: 11 },
      });
    });

    it('still returns updated=true when the notifier throws (best-effort delivery)', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({ store });

      const propsUpdateNotifier: PropsUpdateNotifier = {
        async sendPropsUpdate() {
          throw new Error('socket gone');
        },
      };

      const handler = createGguiUpdateHandler({
        sessionStore: store,
        propsUpdateNotifier,
      });
      const out = await handler.handler(
        { stackItemId, kind: 'replace' as const, props: { count: 11 } },
        ctx(),
      );

      expect(out.updated).toBe(true);
      // Persistence still committed.
      const after = await store.get(sessionId);
      expect(after?.stack[0]?.props).toEqual({ count: 11 });
    });

    it('does not fire the notifier when the contract check rejects', async () => {
      const store = new InMemorySessionStore();
      const propsSpec: PropsSpec = {
        properties: {
          count: { required: true, schema: { type: 'number' } },
        },
      };
      const { sessionId, stackItemId } = await seedSession({ store, propsSpec });

      let notifierCalls = 0;
      const propsUpdateNotifier: PropsUpdateNotifier = {
        async sendPropsUpdate() {
          notifierCalls += 1;
        },
      };

      const handler = createGguiUpdateHandler({
        sessionStore: store,
        propsUpdateNotifier,
      });

      await expect(
        handler.handler({ stackItemId, kind: 'replace' as const, props: {} }, ctx()),
      ).rejects.toThrow(ContractViolationError);
      expect(notifierCalls).toBe(0);

      // Persistence wasn't committed either — the patch threw before
      // appendStackItem ran.
      const after = await store.get(sessionId);
      expect(after?.stack[0]?.props).toEqual({ count: 0 });
    });
  });

  describe('resultMeta — _meta.ggui.bootstrap emission', () => {
    it('emits ggui.bootstrap with propsJson even when bootstrap-emitting deps are unwired (default runtimeUrl)', async () => {
      // Post-2026-05-13 trim: update.resultMeta is props-only. Once
      // there's any patched props (always the case after a successful
      // update — applyStackItemPatch sets `props: patch`), the envelope
      // emits the propsJson + a default runtimeUrl. The cross-host
      // postMessage fallback path needs the runtimeUrl to re-mount on
      // hosts that strip the live trio; the default is /_ggui/iframe-
      // runtime.js. There's no meaningful "no-envelope" gate under
      // props-only — every update has props to publish.
      const store = new InMemorySessionStore();
      const { stackItemId } = await seedSession({ store, initialProps: { x: 1 } });
      const handler = createGguiUpdateHandler({ sessionStore: store });
      const input = { stackItemId, kind: 'replace' as const, props: { x: 2 } };
      const out = await handler.handler(input, ctx());
      const meta = (await handler.resultMeta?.(out, input, ctx())) as
        | { ggui: { bootstrap: Record<string, unknown> } }
        | undefined;
      expect(meta).toBeDefined();
      expect(meta!.ggui.bootstrap['propsJson']).toBe(JSON.stringify({ x: 2 }));
      expect(meta!.ggui.bootstrap['runtimeUrl']).toBe('/_ggui/iframe-runtime.js');
    });

    it('emits ggui.bootstrap with propsJson + session/runtime fields on the patched view (props-only post-trim)', async () => {
      const store = new InMemorySessionStore();
      const { sessionId, stackItemId } = await seedSession({
        store,
        initialProps: { count: 0 },
      });
      const handler = createGguiUpdateHandler({
        sessionStore: store,
        runtimeUrl: '/_ggui/iframe-runtime.js',
        mintBootstrap: () => ({
          wsUrl: 'wss://example.test/ws',
          token: 'tok-1',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      });
      const input = { stackItemId, kind: 'replace' as const, props: { count: 5 } };
      const out = await handler.handler(input, ctx());
      const meta = (await handler.resultMeta?.(out, input, ctx())) as
        | { ggui: { bootstrap: Record<string, unknown> } }
        | undefined;
      expect(meta).toBeDefined();
      const b = meta!.ggui.bootstrap;
      expect(b['sessionId']).toBe(sessionId);
      expect(b['stackItemId']).toBe(stackItemId);
      expect(b['appId']).toBe(APP_A);
      expect(b['runtimeUrl']).toBe('/_ggui/iframe-runtime.js');
      expect(b['wsUrl']).toBe('wss://example.test/ws');
      expect(b['token']).toBe('tok-1');
      expect(b['expiresAt']).toBe('2099-01-01T00:00:00.000Z');
      // propsJson carries the POST-patch props (the source of truth
      // for the spec-compliant postMessage re-apply path).
      expect(b['propsJson']).toBe(JSON.stringify({ count: 5 }));
      // Post-2026-05-13 trim: update.resultMeta is props-only.
      // Mount-time fields (componentCode / kind / contextSlots /
      // actionNextSteps / permissionsPolicy / appCallableTools /
      // streamWebSocketLocalTools) are NOT re-emitted on update —
      // the iframe already has them from its initial push bootstrap.
      expect(b['componentCode']).toBeUndefined();
      expect(b['kind']).toBeUndefined();
      expect(b['contextSlots']).toBeUndefined();
      expect(b['actionNextSteps']).toBeUndefined();
      expect(b['permissionsPolicy']).toBeUndefined();
      expect(b['appCallableTools']).toBeUndefined();
      expect(b['streamWebSocketLocalTools']).toBeUndefined();
    });

    it('forwards themeId + themeMode from themeProvider over static deps', async () => {
      const store = new InMemorySessionStore();
      const { stackItemId } = await seedSession({ store });
      const handler = createGguiUpdateHandler({
        sessionStore: store,
        runtimeUrl: '/_ggui/iframe-runtime.js',
        themeId: 'baseline',
        themeMode: 'light',
        themeProvider: () => ({ id: 'indigo', mode: 'dark' }),
      });
      const input = { stackItemId, kind: 'replace' as const, props: { count: 1 } };
      const out = await handler.handler(input, ctx());
      const meta = (await handler.resultMeta?.(out, input, ctx())) as
        | { ggui: { bootstrap: Record<string, unknown> } }
        | undefined;
      expect(meta!.ggui.bootstrap['themeId']).toBe('indigo');
      expect(meta!.ggui.bootstrap['themeMode']).toBe('dark');
    });
  });
});
