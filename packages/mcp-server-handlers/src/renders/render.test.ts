/**
 * `ggui_render` handler — deterministic code-property tests for the
 * Phase 2 cache-reuse point-read (design §6 + §9).
 *
 * These assert against SOURCE, not LLM output: the harness pre-resolves
 * the generator (no real model) and seeds the registry directly, so
 * every assertion is deterministic. We prove:
 *
 *   (a) the wire output surfaces `blueprintId` / `contractHash` /
 *       `variantKey` / `cache` and they survive `renderOutputSchema.parse`;
 *   (b) render NEVER invokes the semantic `matchBlueprint` — the §6
 *       point-read replaced it (spy on the matcher module);
 *   (c) an `accept` + `origin:'cache'` handshake point-reads the stored
 *       UUID and serves its componentCode verbatim (`cache.hit:true`,
 *       `blueprintId === storedUuid`);
 *   (d) a dangling `matchedBlueprint.id` self-heals to cold-gen (no
 *       throw, `cache.hit:false`);
 *   (e) cold-gen registers exactly once and mints a `bp_<uuid>` id;
 *   (f) the override decision is the AGENT SAFETY VALVE — even with a
 *       reusable cached blueprint present AND referenced by an
 *       `origin:'cache'` handshake, an `override` carrying a fresh
 *       SUPERSET contract cold-gens against the agent's draft and does
 *       NOT reuse the cached blueprint. This is the mechanism the whole
 *       "the cache PROPOSES, the agent DISPOSES" design rests on — the
 *       §6 point-read is gated on `decision.kind === 'accept'`, so an
 *       override structurally bypasses it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryKeyValueStore,
  InMemoryRenderStore,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  EmbeddingProvider,
  UiGenerateResult,
} from '@ggui-ai/mcp-server-core';
import {
  renderOutputSchema,
  type DataContract,
  type ComponentRender,
} from '@ggui-ai/protocol';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import * as matcherModule from './blueprint-matcher.js';
import { registerBlueprint } from './blueprint-registry.js';
import { handshakeRecordKey, type HandshakeRecord } from './handshake.js';
import { createGguiRenderHandler } from './render.js';
import type { HandlerContext } from '../types.js';

const APP_ID = 'app-test';

const CTX: HandlerContext = {
  appId: APP_ID,
  requestId: 'req-1',
};

/** Pure-display contract (no actionSpec → no nextStep). */
const CONTRACT: DataContract = { propsSpec: { properties: {} } };

/**
 * Override draft for test (f): a conforming SUPERSET of `CONTRACT` that
 * adds an interactive surface (`actionSpec.refresh`) the cached
 * pure-display blueprint lacks — the "genuinely-needed surface missing"
 * narrative. Must CONFORM (the override path is STRICT — `validateContract`
 * runs as the commit gate and the server does NOT repair it):
 *   - the action entry carries a required `label`;
 *   - it declares NO `nextStep`, so it triggers no `CTR_REF_NEXT_STEP`
 *     cross-reference check (no agentCapabilities.tools needed).
 */
const OVERRIDE_CONTRACT: DataContract = {
  propsSpec: { properties: {} },
  actionSpec: {
    refresh: { label: 'Refresh', schema: { type: 'object', properties: {} } },
  },
};

const STORED_CODE = 'export default function Cached(){ return null; }';
const COLD_CODE = 'export default function Cold(){ return null; }';

/** Fixed 4-dim embedding so the in-memory vector store is deterministic. */
const fakeEmbedding: EmbeddingProvider = {
  id: 'mock',
  dimensions: 4,
  embed: async () => [0, 0, 0, 0],
};

/** Pre-resolved generator escape hatch — returns fixed componentCode,
 *  no LLM. */
function fakeGenerator(componentCode: string) {
  return async (
    input: { request: { renderId: string } },
  ): Promise<UiGenerateResult> => ({
    ok: true,
    response: {
      renderId: input.request.renderId,
      componentCode,
    },
    metadata: {
      provider: 'anthropic',
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      cacheHit: false,
    },
  });
}

interface Harness {
  readonly handshakeStore: InMemoryKeyValueStore;
  readonly renderStore: InMemoryRenderStore;
  readonly vectorStore: InMemoryVectorStore;
  readonly index: InMemoryBlueprintIndex;
  readonly handler: ReturnType<typeof createGguiRenderHandler>;
}

function buildHandler(opts: {
  readonly handshakeStore: InMemoryKeyValueStore;
  readonly renderStore: InMemoryRenderStore;
  readonly vectorStore: InMemoryVectorStore;
  readonly index: InMemoryBlueprintIndex;
  readonly coldCode: string;
}): ReturnType<typeof createGguiRenderHandler> {
  return createGguiRenderHandler({
    handshakeStore: opts.handshakeStore,
    renderStore: opts.renderStore,
    generation: {
      // `uiGenerator` is never reached — `generator` escape hatch wins.
      uiGenerator: {
        slug: 'ui-gen-default-fake',
        tier: 'default',
        model: 'fake',
        generate: fakeGenerator(opts.coldCode),
      },
      resolveLlm: () => null,
      blueprints: { get: async () => null, list: async () => [] },
      cache: {
        embedding: fakeEmbedding,
        vectorStore: opts.vectorStore,
        index: opts.index,
      },
    },
    generator: fakeGenerator(opts.coldCode),
  });
}

/** Write an accept handshake record into the store. */
async function seedHandshake(
  store: InMemoryKeyValueStore,
  handshakeId: string,
  record: HandshakeRecord,
): Promise<void> {
  await store.set(handshakeRecordKey(APP_ID, handshakeId), JSON.stringify(record));
}

function buildRecord(opts: {
  readonly handshakeId: string;
  readonly origin: 'cache' | 'agent';
  readonly matchedBlueprint?: HandshakeRecord['matchedBlueprint'];
}): HandshakeRecord {
  return {
    handshakeId: opts.handshakeId,
    action: opts.origin === 'cache' ? 'reuse' : 'create',
    reason: 'test',
    input: {
      intent: 'a test card',
      blueprintDraft: { contract: CONTRACT },
    },
    target: {},
    suggestion: {
      origin: opts.origin,
      rationale: 'test',
      blueprintMeta: {
        contractHash: blueprintKey(CONTRACT),
        generator: 'fake',
        variance: {},
      },
    },
    effectiveContract: CONTRACT,
    ...(opts.matchedBlueprint ? { matchedBlueprint: opts.matchedBlueprint } : {}),
    appId: APP_ID,
    createdAt: new Date().toISOString(),
  };
}

/** Cache harness — pre-seeds a Blueprint at a known UUID + an
 *  origin:'cache' handshake record that references it. */
async function buildAcceptCacheHarness(): Promise<{
  readonly harness: Harness;
  readonly storedUuid: string;
  readonly handshakeId: string;
}> {
  const handshakeStore = new InMemoryKeyValueStore();
  const renderStore = new InMemoryRenderStore();
  const vectorStore = new InMemoryVectorStore();
  const index = new InMemoryBlueprintIndex();

  const storedUuid = 'bp_11111111-1111-4111-8111-111111111111';
  await registerBlueprint(
    { embedding: fakeEmbedding, vectorStore, index },
    APP_ID,
    {
      kind: 'template',
      contract: CONTRACT,
      intent: 'a test card',
      componentCode: STORED_CODE,
      provenance: 'synth',
    },
    { mintId: () => storedUuid },
  );

  const handshakeId = 'hs-cache-1';
  await seedHandshake(
    handshakeStore,
    handshakeId,
    buildRecord({
      handshakeId,
      origin: 'cache',
      matchedBlueprint: {
        id: storedUuid,
        contractKey: blueprintKey(CONTRACT),
        variantKey: variantKey(undefined),
      },
    }),
  );

  const handler = buildHandler({
    handshakeStore,
    renderStore,
    vectorStore,
    index,
    coldCode: COLD_CODE,
  });
  return {
    harness: { handshakeStore, renderStore, vectorStore, index, handler },
    storedUuid,
    handshakeId,
  };
}

/** Cold-gen harness — empty registry + an origin:'agent' handshake (no
 *  matchedBlueprint), so render falls through to generation. */
async function buildColdGenHarness(): Promise<{
  readonly harness: Harness;
  readonly handshakeId: string;
}> {
  const handshakeStore = new InMemoryKeyValueStore();
  const renderStore = new InMemoryRenderStore();
  const vectorStore = new InMemoryVectorStore();
  const index = new InMemoryBlueprintIndex();

  const handshakeId = 'hs-cold-1';
  await seedHandshake(
    handshakeStore,
    handshakeId,
    buildRecord({ handshakeId, origin: 'agent' }),
  );

  const handler = buildHandler({
    handshakeStore,
    renderStore,
    vectorStore,
    index,
    coldCode: COLD_CODE,
  });
  return {
    harness: { handshakeStore, renderStore, vectorStore, index, handler },
    handshakeId,
  };
}

describe('createGguiRenderHandler — cache-reuse point-read (Phase 2)', () => {
  it('(a) surfaces blueprintId / contractHash / variantKey / cache and survives renderOutputSchema.parse', async () => {
    const { harness, handshakeId } = await buildColdGenHarness();
    const out = await harness.handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      CTX,
    );
    expect(typeof out.blueprintId).toBe('string');
    expect(typeof out.contractHash).toBe('string');
    expect(typeof out.variantKey).toBe('string');
    expect(out.cache).toBeDefined();
    // The wire-visible subset survives schema parse without throwing.
    const parsed = renderOutputSchema.parse(out);
    expect(parsed.blueprintId).toBe(out.blueprintId);
    expect(parsed.variantKey).toBe(out.variantKey);
    expect(parsed.contractHash).toBe(out.contractHash);
  });

  it('(b) NEVER invokes the semantic matchBlueprint from render', async () => {
    const spy = vi.spyOn(matcherModule, 'matchBlueprint');
    try {
      const cache = await buildAcceptCacheHarness();
      await cache.harness.handler.handler(
        { handshakeId: cache.handshakeId, decision: { kind: 'accept' } },
        CTX,
      );
      const cold = await buildColdGenHarness();
      await cold.harness.handler.handler(
        { handshakeId: cold.handshakeId, decision: { kind: 'accept' } },
        CTX,
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('(c) accept + origin:cache point-reads the stored UUID and serves its componentCode', async () => {
    const { harness, storedUuid, handshakeId } = await buildAcceptCacheHarness();
    const out = await harness.handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      CTX,
    );
    expect(out.cache.hit).toBe(true);
    expect(out.blueprintId).toBe(storedUuid);
    expect(out.cache.cachedBlueprintId).toBe(storedUuid);

    // B1: the cache marker is self-describing by default — a HIT names
    // the reused blueprint without GGUI_CACHE_TRACE_STDERR.
    expect(out.cache.reason).toBeTruthy();
    expect(out.cache.reason).toContain('full-template');
    expect(out.cache.reason).toContain(storedUuid);

    const stored = await harness.renderStore.get(out.renderId);
    const render = stored?.render as ComponentRender | undefined;
    expect(render?.componentCode).toBe(STORED_CODE);
  });

  it('(d) a dangling matchedBlueprint.id self-heals to cold-gen (no throw)', async () => {
    const handshakeStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryRenderStore();
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();

    const handshakeId = 'hs-dangling-1';
    await seedHandshake(
      handshakeStore,
      handshakeId,
      buildRecord({
        handshakeId,
        origin: 'cache',
        // Points at a UUID that was NEVER registered → point-read null.
        matchedBlueprint: {
          id: 'bp_99999999-9999-4999-8999-999999999999',
          contractKey: blueprintKey(CONTRACT),
          variantKey: variantKey(undefined),
        },
      }),
    );

    const handler = buildHandler({
      handshakeStore,
      renderStore,
      vectorStore,
      index,
      coldCode: COLD_CODE,
    });
    const out = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      CTX,
    );
    // Self-heal: falls through to cold-gen rather than throwing.
    expect(out.cache.hit).toBe(false);
    const stored = await renderStore.get(out.renderId);
    const render = stored?.render as ComponentRender | undefined;
    expect(render?.componentCode).toBe(COLD_CODE);
  });

  it('(e) cold-gen registers exactly once and mints a bp_<uuid> id', async () => {
    const { harness, handshakeId } = await buildColdGenHarness();
    const out = await harness.handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      CTX,
    );
    expect(out.cache.hit).toBe(false);
    // B1: a cold render carries a default-available reason indicating it
    // generated fresh rather than reusing a stored component.
    expect(out.cache.reason).toBeTruthy();
    expect(out.cache.reason).toContain('cold');
    expect(out.blueprintId).toMatch(/^bp_[0-9a-f-]{36}$/);

    // Exactly one blueprint landed in the registry under this scope.
    const entries = await harness.vectorStore.listByScope(APP_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe(out.blueprintId);
  });

  it('(f) override is the agent safety valve: cold-gens against the agents fresh draft, does NOT reuse the available proposed cached blueprint', async () => {
    // Reuse is RIGHT THERE: `buildAcceptCacheHarness` pre-seeds a stored
    // Blueprint (componentCode = STORED_CODE) at `storedUuid` AND an
    // `origin:'cache'` handshake record whose `matchedBlueprint`
    // references it. Test (c) proves that an `accept` against this exact
    // setup REUSES the stored blueprint. Here we drive the OTHER half:
    // an `override` carrying a fresh, conforming SUPERSET contract (adds
    // `actionSpec.refresh` the cached pure-display contract lacks — the
    // "genuinely-needed surface missing" scenario). The handler's §6
    // point-read is gated on `decision.kind === 'accept'` (render.ts), so
    // an override structurally bypasses the cached blueprint and cold-gens
    // against the agent's draft. This verifies the safety valve at the
    // mechanism level — "the cache PROPOSES, the agent DISPOSES" — rather
    // than assuming it: even with a reusable blueprint present and named,
    // the agent's override wins.
    const { harness, storedUuid, handshakeId } = await buildAcceptCacheHarness();
    const out = await harness.handler.handler(
      {
        handshakeId,
        decision: {
          kind: 'override',
          blueprintDraft: { contract: OVERRIDE_CONTRACT },
        },
      },
      CTX,
    );

    // Cold-genned — did NOT reuse the available cached blueprint.
    expect(out.cache.hit).toBe(false);
    // A FRESH bp_<uuid> was minted, not the cached storedUuid.
    expect(out.blueprintId).not.toBe(storedUuid);
    expect(out.blueprintId).toMatch(/^bp_/);
    // The cache marker reports cold/override, not a hit.
    expect(out.cache.reason).toBeTruthy();
    expect(out.cache.reason).toContain('cold');

    // The served component code is the COLD-GEN output, NOT the stored
    // blueprint's STORED_CODE (mirrors how test (c) reads the render).
    const stored = await harness.renderStore.get(out.renderId);
    const render = stored?.render as ComponentRender | undefined;
    expect(render?.componentCode).toBe(COLD_CODE);
    expect(render?.componentCode).not.toBe(STORED_CODE);

    // The cached blueprint is still intact in the registry (override
    // didn't mutate it); the cold-gen ADDED a second, fresh blueprint.
    const entries = await harness.vectorStore.listByScope(APP_ID);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain(storedUuid);
    expect(keys).toContain(out.blueprintId);
  });
});

// P2-25: the CALL SHAPE block of the ggui_render description was
// rewritten for Phase 2 — accept REUSES the proposed contract (fast
// path), override generates fresh (STRICT), and the response reports
// final action + a stable blueprintId + a cache marker. The provisional
// blueprintId framing is gone (the UUID is minted at registration).
// These strings ship via tools/list to every self-hoster's LLM, so they
// are code-property asserted + OSS-purity grepped.
describe('createGguiRenderHandler — description (P2-25 CALL SHAPE)', () => {
  function description(): string {
    const handler = buildHandler({
      handshakeStore: new InMemoryKeyValueStore(),
      renderStore: new InMemoryRenderStore(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
      coldCode: COLD_CODE,
    });
    expect(typeof handler.description).toBe('string');
    return handler.description as string;
  }

  it("describes {kind:'accept'} as REUSING the proposed contract (fast path, no regeneration)", () => {
    const d = description();
    expect(d).toMatch(/CALL SHAPE: ggui_render/);
    expect(d).toMatch(/REUSES the contract the handshake proposed/);
    expect(d).toMatch(/no regeneration/);
  });

  it("describes {kind:'override'} as fresh generation from your own contract (STRICT)", () => {
    const d = description();
    expect(d).toMatch(/override/);
    expect(d).toMatch(/generates fresh/);
    expect(d).toMatch(/STRICT/);
    expect(d).toMatch(/this call fails/);
  });

  it('states the response reports action, a stable blueprintId, and a cache marker', () => {
    const d = description();
    expect(d).toMatch(/final `action`/);
    expect(d).toMatch(/`blueprintId` \(stable/);
    expect(d).toMatch(/`cache` marker/);
  });

  it('no longer frames blueprintId as provisional/minted-at-handshake', () => {
    const d = description();
    expect(d).not.toMatch(/provisional blueprintId/);
    expect(d).not.toMatch(/mint a fresh blueprintId/);
  });

  it('keeps blocks 2-6 (PREREQUISITE / NEXT STEP / RECOVERABLE / MUTATION / WIRE SURFACE / HOSTING) verbatim', () => {
    const d = description();
    expect(d).toContain(
      'PREREQUISITE: call ggui_handshake({intent, blueprintDraft}) FIRST.',
    );
    expect(d).toContain(
      'MUTATION: ggui_update mutates props on a delivered UI. NEVER re-render to mutate',
    );
    expect(d).toContain('WIRE SURFACE (DataContract). PLACEMENT RULE for the two inbound specs:');
    expect(d).toContain(
      'HOSTING: on MCP Apps hosts (Claude.ai, Claude Desktop) mounts an iframe via ui://ggui/render',
    );
  });

  it('is OSS-pure — no platform/tier/cloud/credit/cost semantics', () => {
    const d = description();
    for (const banned of [
      '@ggui-cloud',
      '@guuey',
      'platform',
      'tier',
      'credit',
      'billing',
      'savings',
    ]) {
      expect(d.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});
