/**
 * `ggui_update` OSS handler tests — declaration, direct path,
 * propsSpec enforcement, tenancy gate, notifier fan-out.
 *
 * Post-Phase-B (flatten-render-identity): the prior
 * `{sessionId, stackItemId}` pair collapsed to a single `{renderId}`.
 * `SessionStore` was replaced by `RenderStore`. `StackItem` no longer
 * exists — `ComponentRender` is the addressable unit. The
 * `StackItemNotFoundError` matrix collapsed to one
 * `RenderNotFoundError`.
 */
import { describe, expect, it } from 'vitest';
import {
  ContractViolationError,
  type ComponentRender,
  type JsonObject,
  type PropsSpec,
} from '@ggui-ai/protocol';
import { parseMcpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { InMemoryRenderStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiUpdateHandler,
  RenderNotFoundError,
  type PropsUpdateNotifier,
} from './update';

const APP_A = 'app-a';
const APP_B = 'app-b';
const ctx = (appId = APP_A) => ({ appId, requestId: 'r-1' });

const NOW_MS = Date.parse('2026-05-09T00:00:00.000Z');

/**
 * Seed a single render in the store. Phase-B: the render IS the
 * addressable unit — no vessel-with-stack to navigate, no
 * `renderStore.commit` round-trip. `commit` upserts the render row.
 */
async function seedRender(opts: {
  store: InMemoryRenderStore;
  appId?: string;
  renderId?: string;
  propsSpec?: PropsSpec;
  initialProps?: JsonObject;
}): Promise<{ renderId: string }> {
  const renderId = opts.renderId ?? 'render-1';
  const appId = opts.appId ?? APP_A;
  const render: ComponentRender = {
    id: renderId,
    appId,
    type: 'component',
    componentCode: 'export default function X(){return null}',
    props: opts.initialProps ?? { count: 0 },
    ...(opts.propsSpec ? { propsSpec: opts.propsSpec } : {}),
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
  };
  await opts.store.commit({ render, appId });
  return { renderId };
}

describe('createGguiUpdateHandler', () => {
  describe('declaration', () => {
    it('exposes the canonical tool name ggui_update', () => {
      const store = new InMemoryRenderStore();
      const handler = createGguiUpdateHandler({ renderStore: store });
      expect(handler.name).toBe('ggui_update');
    });

    it('declares the updateOutputSchema shape — {renderId, resourceUri, updated}', () => {
      const store = new InMemoryRenderStore();
      const handler = createGguiUpdateHandler({ renderStore: store });
      const outKeys = Object.keys(handler.outputSchema).sort();
      // Phase-B (flatten-render-identity): stackItemId → renderId.
      // `resourceUri` is the spec-canonical MCP-Apps entry-point — same
      // `ui://ggui/render/{id}` URI `ggui_render` stamped on the initial
      // mount, surfaced to SDKs that strip `_meta`.
      expect(outKeys).toEqual(['renderId', 'resourceUri', 'updated']);
    });

    it('does NOT carry any MCP Apps _meta stamp — update is a pure mutation', () => {
      const store = new InMemoryRenderStore();
      const handler = createGguiUpdateHandler({ renderStore: store });
      expect(handler._meta).toBeUndefined();
    });
  });

  describe('direct path', () => {
    it('replaces props on the targeted render via renderStore.commit upsert', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({ store });
      const handler = createGguiUpdateHandler({ renderStore: store });

      const out = await handler.handler(
        { renderId, kind: 'replace' as const, props: { count: 7 } },
        ctx(),
      );

      expect(out).toEqual({
        renderId,
        updated: true,
        resourceUri: `ui://ggui/render/${renderId}`,
      });
      const after = await store.get(renderId);
      // The render's wire-shape payload narrows to ComponentRender here
      // — the seed produced a `type: 'component'` row.
      expect((after?.render as ComponentRender | undefined)?.props).toEqual({
        count: 7,
      });
    });

    it('falls back to HandlerContext.renderId when wire input omits it', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({ store });
      const handler = createGguiUpdateHandler({ renderStore: store });

      // Wire input: only `kind` + `props`. Ctx carries the target — the
      // live-channel dispatch shape.
      const out = await handler.handler(
        { kind: 'replace' as const, props: { count: 42 } },
        { ...ctx(), renderId },
      );

      expect(out).toEqual({
        renderId,
        updated: true,
        resourceUri: `ui://ggui/render/${renderId}`,
      });
    });

    it('wire input overrides HandlerContext when both are present', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({ store });
      const handler = createGguiUpdateHandler({ renderStore: store });

      // Ctx says (decoy); wire says (real). Wire wins.
      const out = await handler.handler(
        { renderId, kind: 'replace' as const, props: { count: 1 } },
        { ...ctx(), renderId: 'wrong-render' },
      );

      expect(out.renderId).toBe(renderId);
    });
  });

  describe('propsSpec enforcement', () => {
    it('throws ContractViolationError{tool:ggui_update} on a missing required field', async () => {
      const store = new InMemoryRenderStore();
      const propsSpec: PropsSpec = {
        properties: {
          count: { required: true, schema: { type: 'number' } },
        },
      };
      const { renderId } = await seedRender({ store, propsSpec });
      const handler = createGguiUpdateHandler({ renderStore: store });

      await expect(
        handler.handler({ renderId, kind: 'replace' as const, props: {} }, ctx()),
      ).rejects.toThrow(ContractViolationError);
    });

    it('passes when patch satisfies propsSpec', async () => {
      const store = new InMemoryRenderStore();
      const propsSpec: PropsSpec = {
        properties: {
          count: { required: true, schema: { type: 'number' } },
        },
      };
      const { renderId } = await seedRender({ store, propsSpec });
      const handler = createGguiUpdateHandler({ renderStore: store });

      const out = await handler.handler(
        { renderId, kind: 'replace' as const, props: { count: 5 } },
        ctx(),
      );
      expect(out.updated).toBe(true);
    });

    it('no-ops the contract check when the render carries no propsSpec', async () => {
      const store = new InMemoryRenderStore();
      // No propsSpec → permissive (matches legacy semantics).
      const { renderId } = await seedRender({ store });
      const handler = createGguiUpdateHandler({ renderStore: store });

      const out = await handler.handler(
        { renderId, kind: 'replace' as const, props: { anything: 'goes' } },
        ctx(),
      );
      expect(out.updated).toBe(true);
    });
  });

  describe('merge mode (RFC 7396)', () => {
    it('merges a flat patch onto existing props', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({
        store,
        initialProps: { temp: 20, condition: 'sunny', city: 'Berlin' },
      });
      const handler = createGguiUpdateHandler({ renderStore: store });

      const out = await handler.handler(
        { renderId, kind: 'merge' as const, patch: { temp: 25 } },
        ctx(),
      );

      expect(out).toEqual({
        renderId,
        updated: true,
        resourceUri: `ui://ggui/render/${renderId}`,
      });
      const after = await store.get(renderId);
      // Only `temp` changes; `condition` and `city` carry through.
      expect((after?.render as ComponentRender).props).toEqual({
        temp: 25,
        condition: 'sunny',
        city: 'Berlin',
      });
    });

    it('deletes a key when the patch value is null (RFC 7396 semantic)', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({
        store,
        initialProps: { temp: 20, alert: 'storm warning' },
      });
      const handler = createGguiUpdateHandler({ renderStore: store });

      await handler.handler(
        { renderId, kind: 'merge' as const, patch: { alert: null } },
        ctx(),
      );

      const after = await store.get(renderId);
      const props = (after?.render as ComponentRender).props ?? {};
      expect(props).toEqual({ temp: 20 });
      // `alert` removed entirely (not set to null).
      expect('alert' in props).toBe(false);
    });

    it('deep-merges nested objects (RFC 7396 recursion)', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({
        store,
        initialProps: {
          user: { name: 'Alice', age: 30, theme: 'dark' },
        },
      });
      const handler = createGguiUpdateHandler({ renderStore: store });

      await handler.handler(
        {
          renderId,
          kind: 'merge' as const,
          patch: { user: { age: 31 } },
        },
        ctx(),
      );

      const after = await store.get(renderId);
      // `name` and `theme` carry through; only `age` changes.
      expect((after?.render as ComponentRender).props).toEqual({
        user: { name: 'Alice', age: 31, theme: 'dark' },
      });
    });

    it('fully replaces arrays (RFC 7396 — no element-wise merge)', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({
        store,
        initialProps: { tags: ['a', 'b', 'c'] },
      });
      const handler = createGguiUpdateHandler({ renderStore: store });

      await handler.handler(
        { renderId, kind: 'merge' as const, patch: { tags: ['x'] } },
        ctx(),
      );

      const after = await store.get(renderId);
      expect((after?.render as ComponentRender).props).toEqual({ tags: ['x'] });
    });

    it('validates the MERGED RESULT against propsSpec, not the patch alone', async () => {
      const store = new InMemoryRenderStore();
      const propsSpec: PropsSpec = {
        properties: {
          count: { required: true, schema: { type: 'number' } },
        },
      };
      // Seed satisfies propsSpec.
      const { renderId } = await seedRender({
        store,
        propsSpec,
        initialProps: { count: 5 },
      });
      const handler = createGguiUpdateHandler({ renderStore: store });

      // Patch nulls out the required `count` field — merged result is
      // {}, which violates the propsSpec. Reject.
      await expect(
        handler.handler(
          { renderId, kind: 'merge' as const, patch: { count: null } },
          ctx(),
        ),
      ).rejects.toThrow(ContractViolationError);
    });

    it('rejects merge mode without a patch field', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({ store });
      const handler = createGguiUpdateHandler({ renderStore: store });

      await expect(
        handler.handler(
          { renderId, kind: 'merge' as const },
          ctx(),
        ),
      ).rejects.toThrow(ContractViolationError);
    });

    it('rejects replace mode without a props field', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({ store });
      const handler = createGguiUpdateHandler({ renderStore: store });

      await expect(
        handler.handler(
          { renderId, kind: 'replace' as const },
          ctx(),
        ),
      ).rejects.toThrow(ContractViolationError);
    });

    it('rejects replace mode that also carries a patch field', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({ store });
      const handler = createGguiUpdateHandler({ renderStore: store });

      await expect(
        handler.handler(
          {
            renderId,
            kind: 'replace' as const,
            props: { temp: 24 },
            patch: { temp: 25 },
          },
          ctx(),
        ),
      ).rejects.toThrow(ContractViolationError);
    });
  });

  describe('errors', () => {
    it('throws RenderNotFoundError when the renderId does not exist', async () => {
      const store = new InMemoryRenderStore();
      const handler = createGguiUpdateHandler({ renderStore: store });

      await expect(
        handler.handler(
          { renderId: 'no-such-render', kind: 'replace' as const, props: {} },
          ctx(),
        ),
      ).rejects.toThrow(RenderNotFoundError);
    });

    it('rejects cross-tenant access as RenderNotFoundError (no leak)', async () => {
      const store = new InMemoryRenderStore();
      // Seed a render owned by APP_A.
      const { renderId } = await seedRender({ store });
      const handler = createGguiUpdateHandler({ renderStore: store });

      // Caller is APP_B — same shape as "render does not exist".
      await expect(
        handler.handler(
          { renderId, kind: 'replace' as const, props: { x: 1 } },
          ctx(APP_B),
        ),
      ).rejects.toThrow(RenderNotFoundError);
    });

    it('rejects when neither wire nor ctx carries renderId', async () => {
      const store = new InMemoryRenderStore();
      const handler = createGguiUpdateHandler({ renderStore: store });

      await expect(
        handler.handler({ kind: 'replace' as const, props: { x: 1 } }, ctx()),
      ).rejects.toThrow(RenderNotFoundError);
    });
  });

  describe('live-delivery notifier', () => {
    it('fires propsUpdateNotifier.sendPropsUpdate after persistence', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({ store });

      const calls: Array<{ renderId: string; props: JsonObject }> = [];
      const propsUpdateNotifier: PropsUpdateNotifier = {
        async sendPropsUpdate(r, props) {
          calls.push({ renderId: r, props });
        },
      };

      const handler = createGguiUpdateHandler({
        renderStore: store,
        propsUpdateNotifier,
      });
      await handler.handler(
        { renderId, kind: 'replace' as const, props: { count: 11 } },
        ctx(),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        renderId,
        props: { count: 11 },
      });
    });

    it('still returns updated=true when the notifier throws (best-effort delivery)', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({ store });

      const propsUpdateNotifier: PropsUpdateNotifier = {
        async sendPropsUpdate() {
          throw new Error('socket gone');
        },
      };

      const handler = createGguiUpdateHandler({
        renderStore: store,
        propsUpdateNotifier,
      });
      const out = await handler.handler(
        { renderId, kind: 'replace' as const, props: { count: 11 } },
        ctx(),
      );

      expect(out.updated).toBe(true);
      // Persistence still committed.
      const after = await store.get(renderId);
      expect((after?.render as ComponentRender).props).toEqual({ count: 11 });
    });

    it('does not fire the notifier when the contract check rejects', async () => {
      const store = new InMemoryRenderStore();
      const propsSpec: PropsSpec = {
        properties: {
          count: { required: true, schema: { type: 'number' } },
        },
      };
      const { renderId } = await seedRender({ store, propsSpec });

      let notifierCalls = 0;
      const propsUpdateNotifier: PropsUpdateNotifier = {
        async sendPropsUpdate() {
          notifierCalls += 1;
        },
      };

      const handler = createGguiUpdateHandler({
        renderStore: store,
        propsUpdateNotifier,
      });

      await expect(
        handler.handler({ renderId, kind: 'replace' as const, props: {} }, ctx()),
      ).rejects.toThrow(ContractViolationError);
      expect(notifierCalls).toBe(0);

      // Persistence wasn't committed either — applyRenderPatch threw
      // before renderStore.commit ran.
      const after = await store.get(renderId);
      expect((after?.render as ComponentRender).props).toEqual({ count: 0 });
    });
  });

  describe('resultMeta — ai.ggui/render slice meta emission', () => {
    it('emits slice meta with propsJson even when bootstrap-emitting deps are unwired (default runtimeUrl)', async () => {
      // Post-Phase-B: update.resultMeta is props-only. Once there's
      // any patched props (always the case after a successful update —
      // applyRenderPatch sets `props: patch`), the envelope emits the
      // propsJson + a default runtimeUrl. The cross-host postMessage
      // fallback path needs the runtimeUrl to re-mount on hosts that
      // strip the live trio; the default is /_ggui/iframe-runtime.js.
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({
        store,
        initialProps: { x: 1 },
      });
      const handler = createGguiUpdateHandler({ renderStore: store });
      const input = { renderId, kind: 'replace' as const, props: { x: 2 } };
      const out = await handler.handler(input, ctx());
      const meta = await handler.resultMeta?.(out, input, ctx());
      expect(meta).toBeDefined();
      const parsed = parseMcpAppAiGguiRenderMeta(meta);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.meta?.propsJson).toBe(JSON.stringify({ x: 2 }));
      expect(parsed.meta?.runtimeUrl).toBe('/_ggui/iframe-runtime.js');
    });

    it('emits slice meta with propsJson + renderId/auth/runtime on the patched view (props-only post-trim)', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({
        store,
        initialProps: { count: 0 },
      });
      const handler = createGguiUpdateHandler({
        renderStore: store,
        runtimeUrl: '/_ggui/iframe-runtime.js',
        mintWsToken: () => ({
          wsUrl: 'wss://example.test/ws',
          token: 'tok-1',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      });
      const input = { renderId, kind: 'replace' as const, props: { count: 5 } };
      const out = await handler.handler(input, ctx());
      const meta = await handler.resultMeta?.(out, input, ctx());
      expect(meta).toBeDefined();
      const parsed = parseMcpAppAiGguiRenderMeta(meta);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const { meta: m } = parsed;
      expect(m?.renderId).toBe(renderId);
      expect(m?.appId).toBe(APP_A);
      expect(m?.runtimeUrl).toBe('/_ggui/iframe-runtime.js');
      expect(m?.wsUrl).toBe('wss://example.test/ws');
      expect(m?.wsToken).toBe('tok-1');
      expect(m?.expiresAt).toBe('2099-01-01T00:00:00.000Z');
      // propsJson carries the POST-patch props (the source of truth
      // for the spec-compliant postMessage re-apply path).
      expect(m?.propsJson).toBe(JSON.stringify({ count: 5 }));
      // Post-Phase-B props-only trim: mount-time fields (codeUrl /
      // kind / contextSlots / actionNextSteps / appCallableTools /
      // streamWebSocketLocalTools / contractHash / validatorsUrl /
      // permissionsPolicy) are NOT re-emitted on update — the iframe
      // already has them from its initial render bootstrap.
      expect(m?.codeUrl).toBeUndefined();
      expect(m?.kind).toBeUndefined();
      expect(m?.contextSlots).toBeUndefined();
      expect(m?.actionNextSteps).toBeUndefined();
      expect(m?.permissionsPolicy).toBeUndefined();
      expect(m?.appCallableTools).toBeUndefined();
      expect(m?.streamWebSocketLocalTools).toBeUndefined();
      expect(m?.contractHash).toBeUndefined();
      expect(m?.validatorsUrl).toBeUndefined();
    });

    it('forwards themeId + themeMode from themeProvider over static deps', async () => {
      const store = new InMemoryRenderStore();
      const { renderId } = await seedRender({ store });
      const handler = createGguiUpdateHandler({
        renderStore: store,
        runtimeUrl: '/_ggui/iframe-runtime.js',
        themeId: 'baseline',
        themeMode: 'light',
        themeProvider: () => ({ id: 'indigo', mode: 'dark' }),
      });
      const input = { renderId, kind: 'replace' as const, props: { count: 1 } };
      const out = await handler.handler(input, ctx());
      const meta = await handler.resultMeta?.(out, input, ctx());
      const parsed = parseMcpAppAiGguiRenderMeta(meta);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.meta?.themeId).toBe('indigo');
      expect(parsed.meta?.themeMode).toBe('dark');
    });
  });
});
