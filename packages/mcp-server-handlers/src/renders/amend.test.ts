/**
 * `ggui_amend` (#483) — in-place mutation, no history entry, no view.
 * The mutation flow itself is the shared core (pinned exhaustively by
 * update.test.ts); these tests pin amend's DELTAS: declaration shape
 * (no UI binding, no resultMeta), bare-head resourceUri, and the
 * epoch staying untouched.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentGguiSession, JsonObject, PropsSpec } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiAmendHandler } from './amend.js';
import { createGguiUpdateHandler } from './update.js';
import type { HandlerContext } from '../types.js';

const APP_A = 'app-a';
const NOW_MS = 1_700_000_000_000;

function ctx(): HandlerContext {
  return { appId: APP_A } as HandlerContext;
}

async function seedRender(opts: {
  store: InMemoryGguiSessionStore;
  sessionId?: string;
  propsSpec?: PropsSpec;
  initialProps?: JsonObject;
}): Promise<{ sessionId: string }> {
  const sessionId = opts.sessionId ?? 'render-1';
  const render: ComponentGguiSession = {
    id: sessionId,
    appId: APP_A,
    type: 'component',
    componentCode: 'export default function X(){return null}',
    props: opts.initialProps ?? { count: 0 },
    ...(opts.propsSpec ? { propsSpec: opts.propsSpec } : {}),
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
  };
  await opts.store.commit({ render, appId: APP_A });
  return { sessionId };
}

describe('createGguiAmendHandler', () => {
  it('declares a PLAIN DATA tool: no _meta (no UI binding), no resultMeta', () => {
    const handler = createGguiAmendHandler({
      renderStore: new InMemoryGguiSessionStore(),
    });
    expect(handler.name).toBe('ggui_amend');
    expect(handler.audience).toEqual(['agent']);
    // The whole point of the tool split (#483): hosts mint per-result
    // views from `_meta` on UI-bound tools — amend must carry neither.
    expect(handler._meta).toBeUndefined();
    expect(handler.resultMeta).toBeUndefined();
  });

  it('amends props in place and returns the BARE head URI — no epoch field, no pin', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender({ store });
    const handler = createGguiAmendHandler({ renderStore: store });

    const out = await handler.handler(
      { sessionId, kind: 'replace' as const, props: { count: 3 } },
      ctx(),
    );

    expect(out).toEqual({
      sessionId,
      updated: true,
      resourceUri: `ui://ggui/render/${sessionId}`,
    });
    const stored = await store.get(sessionId);
    expect((stored?.render as ComponentGguiSession).props).toEqual({ count: 3 });
  });

  it('NEVER advances the epoch and NEVER appends ui.reminted', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender({ store });
    const amend = createGguiAmendHandler({ renderStore: store });
    const update = createGguiUpdateHandler({ renderStore: store });

    await amend.handler(
      { sessionId, kind: 'replace' as const, props: { count: 1 } },
      ctx(),
    );
    // Interleave a real update (epoch 0 → 1)...
    const afterUpdate = await update.handler(
      { sessionId, kind: 'replace' as const, props: { count: 2 } },
      ctx(),
    );
    expect(afterUpdate.epoch).toBe(1);
    // ...then amend again: head stays at epoch 1.
    await amend.handler(
      { sessionId, kind: 'replace' as const, props: { count: 3 } },
      ctx(),
    );
    const stored = await store.get(sessionId);
    expect(stored?.render.epoch).toBe(1);

    const page = await store.listEventsSince(sessionId, 0, 20);
    const reminted = page!.events.filter((e) => e.type === 'ui.reminted');
    expect(reminted).toHaveLength(1); // the update's boundary only
    // Amend's props events are stamped with the CURRENT epoch.
    const updatedEvents = page!.events.filter((e) => e.type === 'ui.updated');
    expect(updatedEvents).toHaveLength(3);
    expect((updatedEvents[0]!.data as { epoch: number }).epoch).toBe(0);
    expect((updatedEvents[2]!.data as { epoch: number }).epoch).toBe(1);
  });

  it('fans the UNCHANGED head epoch to the live notifier (freeze-latch asymmetry)', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender({ store });
    const fanned: number[] = [];
    const propsUpdateNotifier = {
      async sendPropsUpdate(_r: string, _p: JsonObject, epoch: number) {
        fanned.push(epoch);
      },
    };
    const amend = createGguiAmendHandler({ renderStore: store, propsUpdateNotifier });
    const update = createGguiUpdateHandler({ renderStore: store, propsUpdateNotifier });

    await amend.handler(
      { sessionId, kind: 'replace' as const, props: { count: 1 } },
      ctx(),
    );
    await update.handler(
      { sessionId, kind: 'replace' as const, props: { count: 2 } },
      ctx(),
    );
    await amend.handler(
      { sessionId, kind: 'replace' as const, props: { count: 3 } },
      ctx(),
    );
    // Amend fans the head's CURRENT epoch (head mount applies: frame
    // epoch == its own); update fans the advanced one (older mounts
    // freeze: frame epoch > theirs). This is the entire latch protocol
    // seen from the server side.
    expect(fanned).toEqual([0, 1, 1]);
  });

  it('no-op amend returns updated:false + warning, appends nothing', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender({ store, initialProps: { x: 1 } });
    const handler = createGguiAmendHandler({ renderStore: store });
    const out = await handler.handler(
      { sessionId, kind: 'replace' as const, props: { x: 1 } },
      ctx(),
    );
    expect(out.updated).toBe(false);
    expect(out.warning).toContain('NO-OP');
    const page = await store.listEventsSince(sessionId, 0, 10);
    expect(page!.events).toHaveLength(0);
  });

  it('propsSpec violations attribute the error to ggui_amend', async () => {
    const store = new InMemoryGguiSessionStore();
    const { sessionId } = await seedRender({
      store,
      propsSpec: {
        properties: {
          count: { schema: { type: 'number' }, required: true },
        },
      },
    });
    const handler = createGguiAmendHandler({ renderStore: store });
    await expect(
      handler.handler(
        { sessionId, kind: 'replace' as const, props: { count: 'nope' } },
        ctx(),
      ),
    ).rejects.toMatchObject({ name: 'ContractViolationError', tool: 'ggui_amend' });
  });
});
