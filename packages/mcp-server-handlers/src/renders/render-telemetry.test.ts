/**
 * Render / props-mutation telemetry — P2 of the schema-precise render
 * plan (docs/plans/2026-08-19-schema-precise-render.md).
 *
 * Three events, all deps-injected through the lossy non-throwing
 * {@link TelemetrySink} seam (the `handshake.decided` precedent):
 *
 *   - `render.attempted` — handler entry, after handshake resolution.
 *     The metric denominator: first-attempt ordering is event-order-
 *     derivable because violations peek-don't-consume the handshake.
 *   - `render.contract_violation` — every contract-grounded rejection,
 *     discriminated by `site` + `class`, with `violationKeywords`
 *     segmentation (the P4 arming gate / enum-enrichment arbiter).
 *     Shared by ggui_render AND the props-mutation family
 *     (ggui_update / ggui_amend) so update-time violations are
 *     baselined too, not hidden.
 *   - `render.committed` — the success terminal.
 *
 * Absent sink = noop (every pre-existing test in render.test.ts /
 * update.test.ts runs sink-less and must stay green).
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryKeyValueStore,
  InMemoryGguiSessionStore,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  EmbeddingProvider,
  UiGenerateResult,
} from '@ggui-ai/mcp-server-core';
import type {
  ComponentGguiSession,
  DataContract,
  PropsSpec,
} from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { handshakeRecordKey, type HandshakeRecord } from './handshake.js';
import {
  createGguiRenderHandler,
  type GguiRenderHandlerDeps,
} from './render.js';
import { createGguiUpdateHandler } from './update.js';
import type { HandlerContext } from '../types.js';

const APP_ID = 'app-telemetry';
const CTX: HandlerContext = { appId: APP_ID, requestId: 'req-t' };

interface CapturedEvent {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
}

function capturingSink(): {
  events: CapturedEvent[];
  sink: {
    emit(e: {
      name: string;
      at: number;
      attributes?: Readonly<Record<string, string | number | boolean>>;
    }): void;
  };
} {
  const events: CapturedEvent[] = [];
  return {
    events,
    sink: {
      emit(e) {
        events.push({ name: e.name, attributes: { ...(e.attributes ?? {}) } });
      },
    },
  };
}

const fakeEmbedding: EmbeddingProvider = {
  id: 'mock',
  dimensions: 4,
  embed: async () => [0, 0, 0, 0],
};

const fakeGenerator =
  (componentCode: string) =>
  async (input: {
    request: { sessionId: string };
  }): Promise<UiGenerateResult> => ({
    ok: true,
    response: { sessionId: input.request.sessionId, componentCode },
    metadata: {
      provider: 'anthropic',
      generator: 'fake-generator',
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      cacheHit: false,
    },
  });

/** Scheduler-shaped contract — the live-incident vocabulary. */
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

const EMPTY_CONTRACT: DataContract = { propsSpec: { properties: {} } };

function buildRecord(opts: {
  readonly handshakeId: string;
  readonly contract: DataContract;
}): HandshakeRecord {
  return {
    handshakeId: opts.handshakeId,
    action: 'create',
    reason: 'test',
    input: { intent: 'a test card', blueprintDraft: { contract: opts.contract } },
    target: {},
    suggestion: {
      origin: 'agent',
      rationale: 'test',
      blueprintMeta: { contractHash: blueprintKey(opts.contract), variance: {} },
    },
    effectiveContract: opts.contract,
    appId: APP_ID,
    createdAt: new Date().toISOString(),
  };
}

async function buildHarness(opts: {
  readonly contract: DataContract;
  readonly checkRenderContracts?: GguiRenderHandlerDeps['checkRenderContracts'];
}) {
  const handshakeStore = new InMemoryKeyValueStore();
  const renderStore = new InMemoryGguiSessionStore();
  const vectorStore = new InMemoryVectorStore();
  const index = new InMemoryBlueprintIndex();
  const { events, sink } = capturingSink();
  const handshakeId = 'hs-telemetry-1';
  await handshakeStore.set(
    handshakeRecordKey(APP_ID, handshakeId),
    JSON.stringify(buildRecord({ handshakeId, contract: opts.contract })),
  );
  const handler = createGguiRenderHandler({
    handshakeStore,
    renderStore,
    telemetrySink: sink,
    ...(opts.checkRenderContracts
      ? { checkRenderContracts: opts.checkRenderContracts }
      : {}),
    generation: {
      uiGenerator: {
        slug: 'ui-gen-default-fake',
        tier: 'default',
        model: 'fake',
        generate: fakeGenerator('export default function T(){return null}'),
      },
      resolveLlm: () => null,
      blueprints: { get: async () => null, list: async () => [] },
      cache: { embedding: fakeEmbedding, vectorStore, index },
    },
    generator: fakeGenerator('export default function T(){return null}'),
  });
  return { handler, events, handshakeId };
}

describe('ggui_render telemetry', () => {
  it('emits render.attempted then render.committed on a successful render', async () => {
    const { handler, events, handshakeId } = await buildHarness({
      contract: EMPTY_CONTRACT,
    });
    await handler.handler({ handshakeId, props: {} }, CTX);

    const names = events.map((e) => e.name);
    expect(names).toContain('render.attempted');
    expect(names).toContain('render.committed');
    expect(names).not.toContain('render.contract_violation');
    expect(names.indexOf('render.attempted')).toBeLessThan(
      names.indexOf('render.committed'),
    );

    const attempted = events.find((e) => e.name === 'render.attempted')!;
    expect(attempted.attributes['appId']).toBe(APP_ID);
    expect(attempted.attributes['handshakeId']).toBe(handshakeId);
    expect(attempted.attributes['origin']).toBe('agent');
    expect(attempted.attributes['overridePresent']).toBe(false);

    const committed = events.find((e) => e.name === 'render.committed')!;
    expect(committed.attributes['appId']).toBe(APP_ID);
    expect(committed.attributes['handshakeId']).toBe(handshakeId);
  });

  it('emits render.contract_violation with enum keyword segmentation on a props violation, and no committed', async () => {
    const { handler, events, handshakeId } = await buildHarness({
      contract: ENUM_CONTRACT,
    });
    await expect(
      handler.handler({ handshakeId, props: { status: 'booked' } }, CTX),
    ).rejects.toThrow(/Contract violation/);

    const names = events.map((e) => e.name);
    expect(names).toContain('render.attempted');
    expect(names).toContain('render.contract_violation');
    expect(names).not.toContain('render.committed');

    const violation = events.find(
      (e) => e.name === 'render.contract_violation',
    )!;
    expect(violation.attributes['appId']).toBe(APP_ID);
    expect(violation.attributes['handshakeId']).toBe(handshakeId);
    expect(violation.attributes['tool']).toBe('ggui_render');
    expect(violation.attributes['site']).toBe('props_validation');
    expect(violation.attributes['class']).toBe('props');
    expect(violation.attributes['violationKeywords']).toBe('enum');
    expect(violation.attributes['origin']).toBe('agent');
    expect(violation.attributes['overridePresent']).toBe(false);
  });

  it('emits site=override_no_propsspec when override.contract declares no propsSpec but props are non-empty', async () => {
    const { handler, events, handshakeId } = await buildHarness({
      contract: EMPTY_CONTRACT,
    });
    await expect(
      handler.handler(
        { handshakeId, props: { x: 1 }, override: { contract: {} } },
        CTX,
      ),
    ).rejects.toThrow(/Contract violation/);

    const violation = events.find(
      (e) => e.name === 'render.contract_violation',
    )!;
    expect(violation.attributes['site']).toBe('override_no_propsspec');
    expect(violation.attributes['class']).toBe('props');
    expect(violation.attributes['overridePresent']).toBe(true);
    expect(events.map((e) => e.name)).not.toContain('render.committed');
  });

  it('emits class=override_contract_invalid when the strict override gate rejects', async () => {
    const { handler, events, handshakeId } = await buildHarness({
      contract: EMPTY_CONTRACT,
    });
    // Zod-valid but gate-invalid: the action's `nextStep` references a
    // tool that is neither a ggui_* registry tool nor declared under
    // agentCapabilities.tools — the CTR_REF_NEXT_STEP cross-reference
    // check inside `validateContract` rejects it at the commit gate.
    const badOverride: DataContract = {
      propsSpec: { properties: {} },
      actionSpec: {
        go: {
          label: 'Go',
          nextStep: 'not_a_registered_tool',
          schema: { type: 'object', properties: {} },
        },
      },
    };
    await expect(
      handler.handler(
        { handshakeId, props: {}, override: { contract: badOverride } },
        CTX,
      ),
    ).rejects.toThrow(/override_contract_invalid/);

    const violation = events.find(
      (e) => e.name === 'render.contract_violation',
    )!;
    expect(violation.attributes['class']).toBe('override_contract_invalid');
    expect(violation.attributes['site']).toBe('contract_gate');
  });

  it('emits class=schema_mismatch when the schema-compat seam throws', async () => {
    const { handler, events, handshakeId } = await buildHarness({
      contract: EMPTY_CONTRACT,
      checkRenderContracts: () => {
        throw new Error('SCHEMA_MISMATCH_ERROR — test seam');
      },
    });
    await expect(
      handler.handler({ handshakeId, props: {} }, CTX),
    ).rejects.toThrow(/SCHEMA_MISMATCH_ERROR/);

    const violation = events.find(
      (e) => e.name === 'render.contract_violation',
    )!;
    expect(violation.attributes['class']).toBe('schema_mismatch');
    expect(violation.attributes['site']).toBe('schema_compat');
  });
});

describe('props-mutation telemetry (ggui_update)', () => {
  const NOW_MS = Date.parse('2026-08-19T00:00:00.000Z');

  async function seedRender(opts: {
    store: InMemoryGguiSessionStore;
    propsSpec: PropsSpec;
  }): Promise<{ sessionId: string }> {
    const sessionId = 'render-t1';
    const render: ComponentGguiSession = {
      id: sessionId,
      appId: APP_ID,
      type: 'component',
      componentCode: 'export default function X(){return null}',
      props: { status: 'open' },
      propsSpec: opts.propsSpec,
      eventSequence: 0,
      createdAt: NOW_MS,
      lastActivityAt: NOW_MS,
      expiresAt: NOW_MS + 60_000,
    };
    await opts.store.commit({ render, appId: APP_ID });
    return { sessionId };
  }

  it('emits render.contract_violation with tool=ggui_update on a merge-patch propsSpec violation', async () => {
    const store = new InMemoryGguiSessionStore();
    const { events, sink } = capturingSink();
    const { sessionId } = await seedRender({
      store,
      propsSpec: ENUM_CONTRACT.propsSpec!,
    });
    const handler = createGguiUpdateHandler({
      renderStore: store,
      telemetrySink: sink,
    });
    await expect(
      handler.handler(
        { sessionId, kind: 'merge', patch: { status: 'booked' } },
        CTX,
      ),
    ).rejects.toThrow(/Contract violation/);

    const violation = events.find(
      (e) => e.name === 'render.contract_violation',
    )!;
    expect(violation).toBeDefined();
    expect(violation.attributes['appId']).toBe(APP_ID);
    expect(violation.attributes['sessionId']).toBe(sessionId);
    expect(violation.attributes['tool']).toBe('ggui_update');
    expect(violation.attributes['kind']).toBe('merge');
    expect(violation.attributes['class']).toBe('props');
    expect(violation.attributes['violationKeywords']).toBe('enum');
  });

  it('emits nothing on a valid merge patch (no sink noise on success paths)', async () => {
    const store = new InMemoryGguiSessionStore();
    const { events, sink } = capturingSink();
    const { sessionId } = await seedRender({
      store,
      propsSpec: ENUM_CONTRACT.propsSpec!,
    });
    const handler = createGguiUpdateHandler({
      renderStore: store,
      telemetrySink: sink,
    });
    const out = await handler.handler(
      { sessionId, kind: 'merge', patch: { status: 'busy' } },
      CTX,
    );
    expect(out).toMatchObject({ updated: true });
    expect(events.map((e) => e.name)).not.toContain(
      'render.contract_violation',
    );
  });
});
