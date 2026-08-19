/**
 * `deps.telemetry` → handler `telemetrySink` threading — P2 of the
 * schema-precise render plan
 * (docs/plans/2026-08-19-schema-precise-render.md).
 *
 * Pre-slice defect this pins: `defaultHandlers` never threaded the
 * server-level {@link TelemetrySink} into the handshake / render /
 * update handlers, so `handshake.decided` (documented as flowing
 * "automatically" from the composition-level binding) never actually
 * fired from a composed server — and the P2 render events would have
 * silently inherited the same gap. One binding site, three consumers.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryKeyValueStore,
  InMemoryGguiSessionStore,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  ComponentGguiSession,
  DataContract,
} from '@ggui-ai/protocol';
import type { EmbeddingProvider } from '@ggui-ai/mcp-server-core';
import type { HandlerContext } from '@ggui-ai/mcp-server-handlers';
import { defaultHandlers } from './server.js';

const APP_ID = 'app-threading';
const CTX: HandlerContext = { appId: APP_ID, requestId: 'req-w' };

const fakeEmbedding: EmbeddingProvider = {
  id: 'mock',
  dimensions: 4,
  embed: async () => [0, 0, 0, 0],
};

const ENUM_CONTRACT: DataContract = {
  propsSpec: {
    properties: {
      status: {
        schema: { type: 'string', enum: ['open', 'busy', 'tentative'] },
        required: true,
      },
    },
  },
};

describe('defaultHandlers telemetry threading', () => {
  it('threads deps.telemetry into handshake, render, and update handlers', async () => {
    const events: Array<{ name: string; attributes: Record<string, unknown> }> =
      [];
    const telemetry = {
      emit(e: {
        name: string;
        at: number;
        attributes?: Readonly<Record<string, string | number | boolean>>;
      }) {
        events.push({ name: e.name, attributes: { ...(e.attributes ?? {}) } });
      },
    };
    const kvStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryGguiSessionStore();

    const handlers = defaultHandlers({
      embedding: fakeEmbedding,
      vectors: new InMemoryVectorStore(),
      telemetry,
      handshake: { kvStore },
      render: { renderStore },
      update: { renderStore },
    });
    const byName = new Map(handlers.map((h) => [h.name, h]));
    const handshake = byName.get('ggui_handshake');
    const render = byName.get('ggui_render');
    const update = byName.get('ggui_update');
    expect(handshake).toBeDefined();
    expect(render).toBeDefined();
    expect(update).toBeDefined();

    // 1. Handshake — the pre-existing `handshake.decided` emission
    // finally fires from a composed server.
    const handshakeOut = (await handshake!.handler(
      {
        intent: 'a scheduler card',
        blueprintDraft: { contract: ENUM_CONTRACT },
      },
      CTX,
    )) as { handshakeId: string };
    expect(events.map((e) => e.name)).toContain('handshake.decided');

    // 2. Render — attempted + contract_violation ride the same sink.
    await expect(
      render!.handler(
        { handshakeId: handshakeOut.handshakeId, props: { status: 'booked' } },
        CTX,
      ),
    ).rejects.toThrow(/Contract violation/);
    const names = events.map((e) => e.name);
    expect(names).toContain('render.attempted');
    expect(names).toContain('render.contract_violation');

    // 3. Update — mutation-time violations are baselined too.
    const NOW_MS = Date.parse('2026-08-19T00:00:00.000Z');
    const seeded: ComponentGguiSession = {
      id: 'render-w1',
      appId: APP_ID,
      type: 'component',
      componentCode: 'export default function X(){return null}',
      props: { status: 'open' },
      propsSpec: ENUM_CONTRACT.propsSpec!,
      eventSequence: 0,
      createdAt: NOW_MS,
      lastActivityAt: NOW_MS,
      expiresAt: NOW_MS + 60_000,
    };
    await renderStore.commit({ render: seeded, appId: APP_ID });
    await expect(
      update!.handler(
        { sessionId: 'render-w1', kind: 'merge', patch: { status: 'booked' } },
        CTX,
      ),
    ).rejects.toThrow(/Contract violation/);
    const updateViolation = events.filter(
      (e) =>
        e.name === 'render.contract_violation' &&
        e.attributes['tool'] === 'ggui_update',
    );
    expect(updateViolation).toHaveLength(1);
  });
});
