/**
 * ggui#1415 — what the three proved runtime tools declare at this release:
 * the proof each carries and what it is for, the refusal code the two
 * closed outputs name one release before any server emits it, and the
 * per-request row-read memo the transport's proof gate shares with the
 * handler.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  InMemoryGguiSessionStore,
  InMemoryPendingEventConsumer,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { StoredGguiSession } from '@ggui-ai/mcp-server-core';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import { VIEW_ORIGIN_UNPROVEN, isViewProofTool } from '@ggui-ai/protocol/integrations/mcp-apps';
import { createSessionRowReads, readSessionRow, viewProofUseFor, type HandlerContext } from '../types.js';
import { createGguiRuntimePullHandler } from './runtime-pull.js';
import { createGguiSubmitActionHandler } from './submit-action.js';
import { createGguiSyncContextHandler } from './sync-context.js';

const sessionId = 'render_proved';
const card: ComponentGguiSession = {
  type: 'component',
  id: sessionId,
  appId: 'app_1',
  componentCode: '/* card */',
  eventSequence: 0,
  createdAt: 0,
  lastActivityAt: 0,
  expiresAt: 0,
  epoch: 1,
  contextSpec: { draft: { schema: { type: 'string' } } },
};
const ctx: HandlerContext = { appId: 'app_1', requestId: 'req_1' };
const dispatch = {
  sessionId,
  appId: 'app_1',
  actionId: 'a3f2b1d4',
  firedAt: '2026-09-28T10:00:00.000Z',
  kind: 'dispatch',
  payload: { intent: 'confirm', actionData: null, uiContext: {} },
};

describe('the view proof each runtime tool declares (ggui#1415)', () => {
  const store = new InMemoryGguiSessionStore();
  const submit = createGguiSubmitActionHandler();
  const sync = createGguiSyncContextHandler({ renderStore: store });
  const pull = createGguiRuntimePullHandler({ renderStore: store });

  it('submit_action requires one for a dispatch, which commits the gesture, and measures the other kinds', () => {
    expect(viewProofUseFor(submit.viewProof, dispatch)).toBe('required');
    expect(viewProofUseFor(submit.viewProof, { ...dispatch, kind: 'openLink', payload: { url: 'https://example.com' } })).toBe('measured');
    expect(viewProofUseFor(submit.viewProof, { ...dispatch, kind: 'requestDisplayMode', payload: { mode: 'fullscreen' } })).toBe('measured');
  });

  it('sync_context requires one; pull measures one and never requires it', () => {
    expect(viewProofUseFor(sync.viewProof, { sessionId, snapshot: {} })).toBe('required');
    expect(viewProofUseFor(pull.viewProof, { sessionId })).toBe('measured');
  });

  it('each declaring tool is one the proof bound-argument table names', () => {
    for (const h of [submit, sync, pull]) expect(isViewProofTool(h.name), h.name).toBe(true);
  });
});

describe('VIEW_ORIGIN_UNPROVEN is declared on both closed outputs, one release before it is emitted (ggui#1415)', () => {
  const outputs = [
    ['ggui_runtime_submit_action', createGguiSubmitActionHandler().outputSchema],
    ['ggui_runtime_sync_context', createGguiSyncContextHandler({ renderStore: new InMemoryGguiSessionStore() }).outputSchema],
  ] as const;

  it.each(outputs)('%s: a refusal naming the code parses against the advertised output', (_tool, outputSchema) => {
    const refusal = { ok: false, code: VIEW_ORIGIN_UNPROVEN, message: 'no valid view proof' };
    expect(z.object(outputSchema).strict().parse(refusal)).toEqual(refusal);
  });

  it('sync_context: the closed output schema names the code beside the four it had', () => {
    const h = createGguiSyncContextHandler({ renderStore: new InMemoryGguiSessionStore() });
    const projected = z.toJSONSchema(z.object(h.outputSchema), { io: 'output' });
    z.object({
      additionalProperties: z.literal(false),
      properties: z.object({
        code: z.object({
          enum: z.tuple([
            z.literal('SESSION_NOT_FOUND'),
            z.literal('TENANT_MISMATCH'),
            z.literal('CONTEXT_SCHEMA_VIOLATION'),
            z.literal('CONTEXT_TOO_LARGE'),
            z.literal(VIEW_ORIGIN_UNPROVEN),
          ]),
        }),
      }),
    }).parse(projected);
  });
});

describe('the per-request row-read memo (ggui#1415)', () => {
  it('reads one store for one session once, and shares the answer', async () => {
    const store = new InMemoryGguiSessionStore();
    await store.commit({ appId: 'app_1', render: card });
    const get = vi.spyOn(store, 'get');
    const reads = createSessionRowReads();
    const [a, b] = await Promise.all([reads.read(store, sessionId), reads.read(store, sessionId)]);
    expect(a?.render.id).toBe(sessionId);
    expect(b).toBe(a);
    await reads.read(store, 'render_other');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('never shares a read across stores', async () => {
    const one = new InMemoryGguiSessionStore();
    const two = new InMemoryGguiSessionStore();
    await one.commit({ appId: 'app_1', render: card });
    const reads = createSessionRowReads();
    expect(await reads.read(one, sessionId)).not.toBeNull();
    expect(await reads.read(two, sessionId)).toBeNull();
  });

  it('shares a failed read, a synchronous throw included, as a rejection', async () => {
    const store = new InMemoryGguiSessionStore();
    const get = vi.spyOn(store, 'get').mockImplementation(() => {
      throw new Error('store down');
    });
    const reads = createSessionRowReads();
    await expect(reads.read(store, sessionId)).rejects.toThrow('store down');
    await expect(reads.read(store, sessionId)).rejects.toThrow('store down');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('without a memo on the context, a handler reads its store', async () => {
    const store = new InMemoryGguiSessionStore();
    await store.commit({ appId: 'app_1', render: card });
    const get = vi.spyOn(store, 'get');
    await readSessionRow(ctx, store, sessionId);
    await readSessionRow(ctx, store, sessionId);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a dispatch reads its row through the memo, so a gate that read it first costs no second read', async () => {
    const store = new InMemoryGguiSessionStore();
    await store.commit({ appId: 'app_1', render: card });
    const consumer = new InMemoryPendingEventConsumer();
    await consumer.markCreated(sessionId);
    const reads = createSessionRowReads();
    const gateRead: StoredGguiSession | null = await reads.read(store, sessionId);
    expect(gateRead).not.toBeNull();
    const get = vi.spyOn(store, 'get');
    const h = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store, consumerGraceMs: 0 });
    expect(await h.handler(dispatch, { ...ctx, sessionRows: reads })).toMatchObject({ ok: true });
    expect(get).not.toHaveBeenCalled();
  });

  it('a sync reads its row through the memo the same way', async () => {
    const store = new InMemoryGguiSessionStore();
    await store.commit({ appId: 'app_1', render: card });
    const reads = createSessionRowReads();
    await reads.read(store, sessionId);
    const get = vi.spyOn(store, 'get');
    const h = createGguiSyncContextHandler({ renderStore: store });
    expect(await h.handler({ sessionId, appId: 'app_1', snapshot: { draft: 'hi' } }, { ...ctx, sessionRows: reads })).toEqual({ ok: true });
    expect(get).not.toHaveBeenCalled();
  });
});
