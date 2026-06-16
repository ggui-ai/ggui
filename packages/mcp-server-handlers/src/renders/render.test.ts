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
 *   (c) an ACCEPT (no `override`) + `origin:'cache'` handshake point-reads
 *       the stored UUID and serves its componentCode verbatim
 *       (`cache.hit:true`, `blueprintId === storedUuid`);
 *   (d) a dangling `matchedBlueprint.id` self-heals to cold-gen (no
 *       throw, `cache.hit:false`);
 *   (e) cold-gen registers exactly once and mints a `bp_<uuid>` id;
 *   (f) `override.contract` is the AGENT SAFETY VALVE — even with a
 *       reusable cached blueprint present AND referenced by an
 *       `origin:'cache'` handshake, an `override` carrying a fresh
 *       SUPERSET contract cold-gens against the agent's draft and does
 *       NOT reuse the cached blueprint. This is the mechanism the whole
 *       "the cache PROPOSES, the agent DISPOSES" design rests on — the
 *       §6 point-read is gated on `override === undefined`, so an
 *       override structurally bypasses it.
 *
 * Plus the variance-aware reshape (Tasks 6+7):
 *   (g) the reshaped input schema accepts ACCEPT (`{handshakeId, props}`),
 *       `override.variance`, `override.contract`; rejects empty
 *       `override:{}` and missing `props`;
 *   (h) `override.variance` RE-RESOLVES at the new
 *       `(contractKey, variantKey(newVariance))` — reuse if a row exists
 *       there, else cold-gen registered under the new variantKey, with
 *       `out.variantKey === variantKey(newVariance)`.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
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
import {
  renderOutputSchema,
  type AppTheme,
  type DataContract,
  type ComponentGguiSession,
} from '@ggui-ai/protocol';
import { parseMcpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import * as matcherModule from './blueprint-matcher.js';
import { registerBlueprint } from './blueprint-registry.js';
import { handshakeRecordKey, type HandshakeRecord } from './handshake.js';
import { createGguiRenderHandler, type GguiRenderHandlerDeps } from './render.js';
import type { BlueprintPool } from './decide-handshake.js';
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

/**
 * Action-bearing contract for the reuse × schema-compat seam test. The
 * `addTodo` action carries `nextStep: 'todo_add'` — a domain (non-`ggui_*`)
 * tool — so the cross-MCP escape hatch (a nextStep declared in
 * `agentCapabilities.tools` is exempt from the ggui-registry check) is the
 * ONLY thing keeping schema-compat from throwing "tool not registered".
 *
 * `todo_add` MUST appear in `agentCapabilities.tools` or register-time
 * `CTR_REF_NEXT_STEP` throws first; `ActionEntry` requires `label`. The
 * tool value uses the CURRENT `AgentToolEntry` schema (all fields
 * optional, `.strict()`), so a lone `description` is valid.
 */
const AGENT_TOOL_CONTRACT: DataContract = {
  propsSpec: { properties: {} },
  agentCapabilities: {
    tools: {
      todo_add: { toolInfo: { inputSchema: { type: 'object', properties: {} }, description: 'add a todo' } },
    },
  },
  actionSpec: {
    addTodo: { label: 'Add', nextStep: 'todo_add', schema: { type: 'object', properties: {} } },
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
    input: { request: { sessionId: string } },
  ): Promise<UiGenerateResult> => ({
    ok: true,
    response: {
      sessionId: input.request.sessionId,
      componentCode,
    },
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
}

/**
 * Schema-compat seam stub replicating the real cross-MCP escape hatch
 * (`@ggui-ai/mcp-server/schema-compat.ts`): a `nextStep` declared in
 * `agentCapabilities.tools` is exempt from the ggui-registry check; an
 * undeclared one throws the live `SCHEMA_MISMATCH_ERROR`. Used to prove
 * the cache path lands `agentCapabilities` so the `declared` set is
 * populated (vs. empty → false-positive throw).
 */
function makeSchemaCompatStub(): NonNullable<
  GguiRenderHandlerDeps['checkRenderContracts']
> {
  return (shape) => {
    const declared = new Set(Object.keys(shape.agentCapabilities?.tools ?? {}));
    for (const [name, entry] of Object.entries(shape.actionSpec ?? {})) {
      const tool = entry?.nextStep;
      if (typeof tool === 'string' && tool.length > 0 && !declared.has(tool)) {
        throw new Error(
          `SCHEMA_MISMATCH_ERROR — action "${name}" references tool "${tool}" which is not registered`,
        );
      }
    }
  };
}

interface Harness {
  readonly handshakeStore: InMemoryKeyValueStore;
  readonly renderStore: InMemoryGguiSessionStore;
  readonly vectorStore: InMemoryVectorStore;
  readonly index: InMemoryBlueprintIndex;
  readonly handler: ReturnType<typeof createGguiRenderHandler>;
}

function buildHandler(opts: {
  readonly handshakeStore: InMemoryKeyValueStore;
  readonly renderStore: InMemoryGguiSessionStore;
  readonly vectorStore: InMemoryVectorStore;
  readonly index: InMemoryBlueprintIndex;
  readonly coldCode: string;
  /**
   * Optional schema-compat seam. When present it's threaded onto the
   * handler deps' `checkRenderContracts`, so cache-hit AND cold-gen
   * commits run it against the projected `ComponentGguiSession`. Default
   * tests omit it (the no-registry / zero-config case); the reuse ×
   * action-bearing-contract test passes a stub that replicates the real
   * cross-MCP escape hatch to exercise the seam the cache path drops.
   */
  readonly checkRenderContracts?: GguiRenderHandlerDeps['checkRenderContracts'];
  /**
   * Optional per-render success seam. Threaded onto the handler deps so
   * tests can capture the `GguiSessionPostSuccessArgs` bundle the handler
   * hands the hook on BOTH the cache-hit and cold-gen paths.
   */
  readonly postSuccessHook?: GguiRenderHandlerDeps['postSuccessHook'];
}): ReturnType<typeof createGguiRenderHandler> {
  return createGguiRenderHandler({
    handshakeStore: opts.handshakeStore,
    renderStore: opts.renderStore,
    ...(opts.checkRenderContracts
      ? { checkRenderContracts: opts.checkRenderContracts }
      : {}),
    ...(opts.postSuccessHook ? { postSuccessHook: opts.postSuccessHook } : {}),
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
async function buildAcceptCacheHarness(extraOpts: {
  readonly postSuccessHook?: GguiRenderHandlerDeps['postSuccessHook'];
} = {}): Promise<{
  readonly harness: Harness;
  readonly storedUuid: string;
  readonly handshakeId: string;
}> {
  const handshakeStore = new InMemoryKeyValueStore();
  const renderStore = new InMemoryGguiSessionStore();
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
      source: { kind: 'llm', generator: 'fake-generator', model: 'fake' },
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
    ...(extraOpts.postSuccessHook
      ? { postSuccessHook: extraOpts.postSuccessHook }
      : {}),
  });
  return {
    harness: { handshakeStore, renderStore, vectorStore, index, handler },
    storedUuid,
    handshakeId,
  };
}

/**
 * Parameterized variant of {@link buildAcceptCacheHarness}. Registers a
 * stored blueprint carrying `contract` at a known UUID, seeds an
 * `origin:'cache'` handshake whose `matchedBlueprint`/`effectiveContract`
 * reference that SAME contract, and threads `extraOpts` (e.g. a
 * `checkRenderContracts` stub) onto the handler. The ACCEPT point-read
 * serves the stored blueprint's own contract, so the cache-hit projection
 * reads `contract.{actionSpec,agentCapabilities,…}` from `contract`.
 */
async function buildAcceptCacheHarnessFor(
  contract: DataContract,
  extraOpts: {
    readonly checkRenderContracts?: GguiRenderHandlerDeps['checkRenderContracts'];
  } = {},
): Promise<{
  readonly harness: Harness;
  readonly storedUuid: string;
  readonly handshakeId: string;
}> {
  const handshakeStore = new InMemoryKeyValueStore();
  const renderStore = new InMemoryGguiSessionStore();
  const vectorStore = new InMemoryVectorStore();
  const index = new InMemoryBlueprintIndex();

  const storedUuid = 'bp_33333333-3333-4333-8333-333333333333';
  await registerBlueprint(
    { embedding: fakeEmbedding, vectorStore, index },
    APP_ID,
    {
      kind: 'template',
      contract,
      intent: 'a test card',
      componentCode: STORED_CODE,
      source: { kind: 'llm', generator: 'fake-generator', model: 'fake' },
    },
    { mintId: () => storedUuid },
  );

  const handshakeId = 'hs-cache-param-1';
  const record: HandshakeRecord = {
    handshakeId,
    action: 'reuse',
    reason: 'test',
    input: {
      intent: 'a test card',
      blueprintDraft: { contract },
    },
    target: {},
    suggestion: {
      origin: 'cache',
      rationale: 'test',
      blueprintMeta: {
        contractHash: blueprintKey(contract),
        variance: {},
      },
    },
    effectiveContract: contract,
    matchedBlueprint: {
      id: storedUuid,
      contractKey: blueprintKey(contract),
      variantKey: variantKey(undefined),
    },
    appId: APP_ID,
    createdAt: new Date().toISOString(),
  };
  await seedHandshake(handshakeStore, handshakeId, record);

  const handler = buildHandler({
    handshakeStore,
    renderStore,
    vectorStore,
    index,
    coldCode: COLD_CODE,
    ...(extraOpts.checkRenderContracts
      ? { checkRenderContracts: extraOpts.checkRenderContracts }
      : {}),
  });
  return {
    harness: { handshakeStore, renderStore, vectorStore, index, handler },
    storedUuid,
    handshakeId,
  };
}

/** Cold-gen harness — empty registry + an origin:'agent' handshake (no
 *  matchedBlueprint), so render falls through to generation. */
async function buildColdGenHarness(extraOpts: {
  readonly postSuccessHook?: GguiRenderHandlerDeps['postSuccessHook'];
} = {}): Promise<{
  readonly harness: Harness;
  readonly handshakeId: string;
}> {
  const handshakeStore = new InMemoryKeyValueStore();
  const renderStore = new InMemoryGguiSessionStore();
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
    ...(extraOpts.postSuccessHook
      ? { postSuccessHook: extraOpts.postSuccessHook }
      : {}),
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
      { handshakeId, props: {} },
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
        { handshakeId: cache.handshakeId, props: {} },
        CTX,
      );
      const cold = await buildColdGenHarness();
      await cold.harness.handler.handler(
        { handshakeId: cold.handshakeId, props: {} },
        CTX,
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('(c) accept (no override) + origin:cache point-reads the stored UUID and serves its componentCode', async () => {
    const { harness, storedUuid, handshakeId } = await buildAcceptCacheHarness();
    const out = await harness.handler.handler(
      { handshakeId, props: {} },
      CTX,
    );
    expect(out.cache.hit).toBe(true);
    expect(out.blueprintId).toBe(storedUuid);
    expect(out.cache.cachedBlueprintId).toBe(storedUuid);
    // Accept reuses the PROPOSED `(contractKey, variantKey)` — the
    // proposed variance is `{}` (default), so the wire variantKey is the
    // default-variant sentinel.
    expect(out.variantKey).toBe(variantKey({}));

    // B1: the cache marker is self-describing by default — a HIT names
    // the reused blueprint without GGUI_CACHE_TRACE_STDERR.
    expect(out.cache.reason).toBeTruthy();
    expect(out.cache.reason).toContain('full-template');
    expect(out.cache.reason).toContain(storedUuid);

    const stored = await harness.renderStore.get(out.sessionId);
    const render = stored?.render as ComponentGguiSession | undefined;
    expect(render?.componentCode).toBe(STORED_CODE);
  });

  it('(d) a dangling matchedBlueprint.id self-heals to cold-gen (no throw)', async () => {
    const handshakeStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryGguiSessionStore();
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
      { handshakeId, props: {} },
      CTX,
    );
    // Self-heal: falls through to cold-gen rather than throwing.
    expect(out.cache.hit).toBe(false);
    const stored = await renderStore.get(out.sessionId);
    const render = stored?.render as ComponentGguiSession | undefined;
    expect(render?.componentCode).toBe(COLD_CODE);
  });

  it('(e) cold-gen registers exactly once and mints a bp_<uuid> id', async () => {
    const { harness, handshakeId } = await buildColdGenHarness();
    const out = await harness.handler.handler(
      { handshakeId, props: {} },
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
    // The cold-gen mint stamps full engine provenance from the
    // generator's own metadata claim (flat-encoded in storage).
    expect(entries[0].metadata['sourceKind']).toBe('llm');
    expect(entries[0].metadata['sourceGenerator']).toBe('fake-generator');
    expect(entries[0].metadata['sourceModel']).toBe('fake');
  });

  it('(f) override.contract is the agent safety valve: cold-gens against the agents fresh draft, does NOT reuse the available proposed cached blueprint', async () => {
    // Reuse is RIGHT THERE: `buildAcceptCacheHarness` pre-seeds a stored
    // Blueprint (componentCode = STORED_CODE) at `storedUuid` AND an
    // `origin:'cache'` handshake record whose `matchedBlueprint`
    // references it. Test (c) proves that an ACCEPT against this exact
    // setup REUSES the stored blueprint. Here we drive the OTHER half:
    // an `override.contract` carrying a fresh, conforming SUPERSET
    // contract (adds `actionSpec.refresh` the cached pure-display contract
    // lacks — the "genuinely-needed surface missing" scenario). The
    // handler's §6 point-read is gated on `override === undefined`
    // (render.ts), so an override structurally bypasses the cached
    // blueprint and cold-gens against the agent's draft. This verifies the
    // safety valve at the mechanism level — "the cache PROPOSES, the agent
    // DISPOSES" — rather than assuming it: even with a reusable blueprint
    // present and named, the agent's override wins.
    const { harness, storedUuid, handshakeId } = await buildAcceptCacheHarness();
    const out = await harness.handler.handler(
      {
        handshakeId,
        props: {},
        override: { contract: OVERRIDE_CONTRACT },
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
    const stored = await harness.renderStore.get(out.sessionId);
    const render = stored?.render as ComponentGguiSession | undefined;
    expect(render?.componentCode).toBe(COLD_CODE);
    expect(render?.componentCode).not.toBe(STORED_CODE);

    // The cached blueprint is still intact in the registry (override
    // didn't mutate it); the cold-gen ADDED a second, fresh blueprint.
    const entries = await harness.vectorStore.listByScope(APP_ID);
    const keys = entries.map((e) => e.key);
    expect(keys).toContain(storedUuid);
    expect(keys).toContain(out.blueprintId);
  });

  it('passes cacheHit to postSuccessHook (true on blueprint reuse, false on cold gen)', async () => {
    const seen: boolean[] = [];
    const postSuccessHook: GguiRenderHandlerDeps['postSuccessHook'] = async (
      a,
    ) => {
      seen.push(a.cacheHit);
    };

    // Cache-hit path: ACCEPT + origin:'cache' reuses the stored blueprint.
    const cache = await buildAcceptCacheHarness({ postSuccessHook });
    await cache.harness.handler.handler(
      { handshakeId: cache.handshakeId, props: {} },
      CTX,
    );
    expect(typeof seen.at(-1)).toBe('boolean');
    expect(seen.at(-1)).toBe(true);

    // Cold-gen path: origin:'agent' with no matchedBlueprint → generation.
    const cold = await buildColdGenHarness({ postSuccessHook });
    await cold.harness.handler.handler(
      { handshakeId: cold.handshakeId, props: {} },
      CTX,
    );
    expect(typeof seen.at(-1)).toBe('boolean');
    expect(seen.at(-1)).toBe(false);
  });

  // ── reuse × action-bearing contract (the SCHEMA_MISMATCH seam) ──────
  //
  // The live bug: the cache-hit projection copies the matched
  // blueprint's actionSpec/streamSpec/propsSpec/contextSpec/
  // clientCapabilities but DROPS agentCapabilities. commitCachedGguiSession's
  // schema-compat escape hatch reads cacheHit.agentCapabilities to exempt
  // a cross-MCP `nextStep` from the ggui-registry check — with the field
  // dropped, the exempt set is empty and any reused blueprint whose
  // actionSpec.nextStep is a domain tool fails "tool not registered".
  // The V1/V2/S1/S2 cache tests never reused an action-bearing contract,
  // so this seam stayed untested. `makeSchemaCompatStub` replicates the
  // real escape-hatch logic; the harness threads it through the deps.
  it('cache-reuse of a blueprint with agentCapabilities + actionSpec.nextStep does NOT throw SCHEMA_MISMATCH', async () => {
    const { harness, handshakeId } = await buildAcceptCacheHarnessFor(
      AGENT_TOOL_CONTRACT,
      { checkRenderContracts: makeSchemaCompatStub() },
    );
    const out = await harness.handler.handler(
      { handshakeId, props: {} },
      CTX,
    );
    expect(out).toBeDefined();
    expect(out.cache.hit).toBe(true);
  });

  it('schema-compat stub: nextStep without agentCapabilities throws; with it, passes', () => {
    const stub = makeSchemaCompatStub();
    expect(() => stub({ actionSpec: AGENT_TOOL_CONTRACT.actionSpec })).toThrow(
      /not registered/,
    );
    expect(() =>
      stub({
        actionSpec: AGENT_TOOL_CONTRACT.actionSpec,
        agentCapabilities: AGENT_TOOL_CONTRACT.agentCapabilities,
      }),
    ).not.toThrow();
  });
});

// ── §6 reuse point-read is seed-pool-aware (cross-deployment) ─────────
//
// A seed-pool blueprint lives in a SEPARATE registry under a different
// scope (`'shared'`) than the per-app cache. The handshake matcher fans
// out across pools (decide-handshake.ts), so it can PROPOSE an
// `origin:'cache'` reuse of a seed-pool blueprint. But the render-time
// §6 point-read used to read ONLY the per-app store under `ctx.appId` —
// so the proposed seed blueprint resolved to `null` and render fell
// through to cold-gen, silently defeating cross-deployment reuse.
//
// The fix mirrors the matcher's pool fan-out: the point-read tries the
// per-app store FIRST, then each seed pool under `pool.scope`, stopping
// at the first hit. Per-app-first is load-bearing — a deployment's own
// blueprint wins over a seed-pool one with the same id.
describe('createGguiRenderHandler — seed-pool-aware reuse point-read', () => {
  const SHARED_SCOPE = 'shared';
  const SEED_CODE = 'export default function Seed(){ return null; }';

  /**
   * Build a `BlueprintPool` (registry + scope) and register a blueprint
   * carrying `componentCode` under `scope` at `uuid`. Returns the pool
   * plus its (separate) stores so callers can also register a per-app
   * row at the same uuid for the ordering test.
   */
  async function buildSeedPool(opts: {
    readonly uuid: string;
    readonly contract: DataContract;
    readonly componentCode: string;
    readonly scope: string;
  }): Promise<BlueprintPool> {
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    await registerBlueprint(
      { embedding: fakeEmbedding, vectorStore, index },
      opts.scope,
      {
        kind: 'template',
        contract: opts.contract,
        intent: 'a test card',
        componentCode: opts.componentCode,
        source: { kind: 'user' },
      },
      { mintId: () => opts.uuid },
    );
    return {
      registry: { embedding: fakeEmbedding, vectorStore, index },
      scope: opts.scope,
    };
  }

  /**
   * Build the render handler with an EMPTY per-app cache PLUS
   * `seedPools`, and seed an `origin:'cache'` handshake whose
   * `matchedBlueprint.id` references a blueprint that lives ONLY in a
   * seed pool. When `perAppRow` is set, ALSO register a row at the SAME
   * uuid in the per-app store (the ordering test) so we can prove
   * per-app-first.
   */
  async function buildSeedPoolHarness(opts: {
    readonly uuid: string;
    readonly contract: DataContract;
    readonly seedPools: readonly BlueprintPool[];
    readonly perAppRow?: { readonly componentCode: string };
  }): Promise<{
    readonly handler: ReturnType<typeof createGguiRenderHandler>;
    readonly renderStore: InMemoryGguiSessionStore;
    readonly handshakeId: string;
  }> {
    const handshakeStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryGguiSessionStore();
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();

    if (opts.perAppRow) {
      await registerBlueprint(
        { embedding: fakeEmbedding, vectorStore, index },
        APP_ID,
        {
          kind: 'template',
          contract: opts.contract,
          intent: 'a test card',
          componentCode: opts.perAppRow.componentCode,
          source: { kind: 'llm', generator: 'fake-generator', model: 'fake' },
        },
        { mintId: () => opts.uuid },
      );
    }

    const handshakeId = 'hs-seed-1';
    const record: HandshakeRecord = {
      handshakeId,
      action: 'reuse',
      reason: 'test',
      input: {
        intent: 'a test card',
        blueprintDraft: { contract: opts.contract },
      },
      target: {},
      suggestion: {
        origin: 'cache',
        rationale: 'test',
        blueprintMeta: {
          contractHash: blueprintKey(opts.contract),
          variance: {},
        },
      },
      effectiveContract: opts.contract,
      matchedBlueprint: {
        id: opts.uuid,
        contractKey: blueprintKey(opts.contract),
        variantKey: variantKey(undefined),
      },
      appId: APP_ID,
      createdAt: new Date().toISOString(),
    };
    await seedHandshake(handshakeStore, handshakeId, record);

    const handler = createGguiRenderHandler({
      handshakeStore,
      renderStore,
      generation: {
        uiGenerator: {
          slug: 'ui-gen-default-fake',
          tier: 'default',
          model: 'fake',
          generate: fakeGenerator(COLD_CODE),
        },
        resolveLlm: () => null,
        blueprints: { get: async () => null, list: async () => [] },
        // EMPTY per-app cache — the seed blueprint is NOT here.
        cache: { embedding: fakeEmbedding, vectorStore, index },
        seedPools: opts.seedPools,
      },
      generator: fakeGenerator(COLD_CODE),
    });
    return { handler, renderStore, handshakeId };
  }

  it('ACCEPT reuses a blueprint that lives ONLY in a seed pool (per-app miss → pool hit)', async () => {
    const uuid = 'bp_55555555-5555-4555-8555-555555555555';
    const pool = await buildSeedPool({
      uuid,
      contract: CONTRACT,
      componentCode: SEED_CODE,
      scope: SHARED_SCOPE,
    });
    const { handler, renderStore, handshakeId } = await buildSeedPoolHarness({
      uuid,
      contract: CONTRACT,
      seedPools: [pool],
    });

    const out = await handler.handler({ handshakeId, props: {} }, CTX);

    // The inverse of the dangling-id fall-through test: the per-app store
    // is empty, but the seed pool resolves the matched UUID, so render
    // REUSES it instead of cold-genning.
    expect(out.cache.hit).toBe(true);
    expect(out.cache.cachedBlueprintId).toBe(uuid);
    expect(out.blueprintId).toBe(uuid);

    const stored = await renderStore.get(out.sessionId);
    const render = stored?.render as ComponentGguiSession | undefined;
    expect(render?.componentCode).toBe(SEED_CODE);
    expect(render?.componentCode).not.toBe(COLD_CODE);
  });

  it('seed-pool ACCEPT reuse preserves agentCapabilities on the committed render (tool-bearing blueprint)', async () => {
    // This test guards the "capability-agnostic reuse" seam for blueprints
    // that live ONLY in a seed pool. Historically the §6 cache-hit
    // projection dropped `agentCapabilities` from the `cacheHit` arg passed
    // to `commitCachedGguiSession`, leaving the committed ComponentGguiSession without
    // a capability catalog. Downstream consumers (schema-compat escape hatch,
    // iframe bootstrap-meta derivation) reading `agentCapabilities` from the
    // committed render would see an empty set, silently breaking cross-MCP
    // nextStep resolution and tool-list projection.
    //
    // The fix (render.ts, the `...(blueprintHit.contract.agentCapabilities …)`
    // spread) projects the seed blueprint's capability catalog into cacheHit
    // before it reaches `commitCachedGguiSession`. `commitCachedGguiSession` then
    // projects `cacheHit.agentCapabilities` onto the ComponentGguiSession it
    // passes to `checkRenderContracts`. We capture what the hook receives
    // (the OUTPUT of the reuse projection) and assert the catalog is intact.
    //
    // Non-tautological confirmation: if the projection spread were removed,
    // `capturedCaps` would be `undefined` and the `toEqual` assertion below
    // would fail. The capture is on the hook's INBOUND shape, not the
    // input contract — the assertion only passes if the projection chain
    // carried the field all the way to the commit call.
    const uuid = 'bp_77777777-7777-4777-8777-777777777777';

    // A contract carrying a tool with serverInfo (canonical cross-MCP tool).
    const SEED_CONTRACT: DataContract = {
      propsSpec: { properties: {} },
      agentCapabilities: {
        tools: {
          table_order_place: {
            serverInfo: { name: 'table-order-mcp' },
            toolInfo: {
              inputSchema: { type: 'object', properties: {} },
              description: 'place a table order',
            },
          },
        },
      },
      actionSpec: {
        placeOrder: {
          label: 'Place Order',
          nextStep: 'table_order_place',
          schema: { type: 'object', properties: {} },
        },
      },
    };

    // Capture hook — mirrors makeSchemaCompatStub's typed parameter shape.
    // `checkRenderContracts` receives the committed ComponentGguiSession (the
    // reuse OUTPUT), and `shape.agentCapabilities` is the projected value.
    let capturedCaps: Parameters<
      NonNullable<GguiRenderHandlerDeps['checkRenderContracts']>
    >[0]['agentCapabilities'];
    const capturingHook: NonNullable<GguiRenderHandlerDeps['checkRenderContracts']> =
      (shape) => {
        capturedCaps = shape.agentCapabilities;
      };

    const pool = await buildSeedPool({
      uuid,
      contract: SEED_CONTRACT,
      componentCode: SEED_CODE,
      scope: SHARED_SCOPE,
    });

    // Build the handler directly (mirrors buildSeedPoolHarness but adds the
    // capture hook). EMPTY per-app cache — blueprint lives ONLY in the pool.
    const handshakeStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryGguiSessionStore();
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const handshakeId = 'hs-seed-agentcaps-1';
    const seedRecord: HandshakeRecord = {
      handshakeId,
      action: 'reuse',
      reason: 'test',
      input: {
        intent: 'a test card',
        blueprintDraft: { contract: SEED_CONTRACT },
      },
      target: {},
      suggestion: {
        origin: 'cache',
        rationale: 'test',
        blueprintMeta: {
          contractHash: blueprintKey(SEED_CONTRACT),
          variance: {},
        },
      },
      effectiveContract: SEED_CONTRACT,
      matchedBlueprint: {
        id: uuid,
        contractKey: blueprintKey(SEED_CONTRACT),
        variantKey: variantKey(undefined),
      },
      appId: APP_ID,
      createdAt: new Date().toISOString(),
    };
    await seedHandshake(handshakeStore, handshakeId, seedRecord);

    const handler = createGguiRenderHandler({
      handshakeStore,
      renderStore,
      checkRenderContracts: capturingHook,
      generation: {
        uiGenerator: {
          slug: 'ui-gen-default-fake',
          tier: 'default',
          model: 'fake',
          generate: fakeGenerator(COLD_CODE),
        },
        resolveLlm: () => null,
        blueprints: { get: async () => null, list: async () => [] },
        cache: { embedding: fakeEmbedding, vectorStore, index },
        seedPools: [pool],
      },
      generator: fakeGenerator(COLD_CODE),
    });

    const out = await handler.handler({ handshakeId, props: {} }, CTX);

    // Reuse MUST have come from the seed pool.
    expect(out.cache.hit).toBe(true);
    expect(out.cache.cachedBlueprintId).toBe(uuid);

    // `capturedCaps` was set by the capture hook when `commitCachedGguiSession`
    // called `checkRenderContracts` with the committed ComponentGguiSession.
    // This is the OUTPUT of the projection — not the input contract.
    // Deep equality covers serverInfo.name verbatim (the narrowest sanity
    // we need; the hook's type uses Record<string,unknown> for tools values,
    // so member-level assertions belong in the toEqual comparison).
    expect(capturedCaps).toEqual(SEED_CONTRACT.agentCapabilities);
  });

  it('per-app store WINS over a seed pool with the same id (per-app-first ordering)', async () => {
    const uuid = 'bp_66666666-6666-4666-8666-666666666666';
    // Seed pool carries SEED_CODE under the same uuid…
    const pool = await buildSeedPool({
      uuid,
      contract: CONTRACT,
      componentCode: SEED_CODE,
      scope: SHARED_SCOPE,
    });
    // …but the per-app store carries STORED_CODE under that SAME uuid.
    const { handler, renderStore, handshakeId } = await buildSeedPoolHarness({
      uuid,
      contract: CONTRACT,
      seedPools: [pool],
      perAppRow: { componentCode: STORED_CODE },
    });

    const out = await handler.handler({ handshakeId, props: {} }, CTX);

    expect(out.cache.hit).toBe(true);
    expect(out.blueprintId).toBe(uuid);

    // Per-app-first: the per-app STORED_CODE is served, NOT the seed
    // pool's SEED_CODE.
    const stored = await renderStore.get(out.sessionId);
    const render = stored?.render as ComponentGguiSession | undefined;
    expect(render?.componentCode).toBe(STORED_CODE);
    expect(render?.componentCode).not.toBe(SEED_CODE);
  });
});

describe('createGguiRenderHandler — variance-aware input reshape (Tasks 6+7)', () => {
  /** The reshaped input raw-shape as a parseable zod object. */
  function inputObject() {
    const handler = buildHandler({
      handshakeStore: new InMemoryKeyValueStore(),
      renderStore: new InMemoryGguiSessionStore(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
      coldCode: COLD_CODE,
    });
    return z.object(handler.inputSchema);
  }

  // (g) Schema acceptance / rejection.
  it('(g) accepts ACCEPT — {handshakeId, props:{}} (no override)', () => {
    const parsed = inputObject().parse({ handshakeId: 'hs_1', props: {} });
    expect(parsed.handshakeId).toBe('hs_1');
    expect(parsed.override).toBeUndefined();
  });

  it('(g) accepts override.variance — {handshakeId, override:{variance:{persona:"x"}}, props:{}}', () => {
    const parsed = inputObject().parse({
      handshakeId: 'hs_1',
      override: { variance: { persona: 'x' } },
      props: {},
    });
    expect(parsed.override?.variance?.persona).toBe('x');
    expect(parsed.override?.contract).toBeUndefined();
  });

  it('(g) accepts override.contract — {handshakeId, override:{contract}, props:{}}', () => {
    const parsed = inputObject().parse({
      handshakeId: 'hs_1',
      override: { contract: OVERRIDE_CONTRACT },
      props: {},
    });
    expect(parsed.override?.contract).toBeDefined();
  });

  it('(g) REJECTS an empty override:{} — omit override to accept instead', () => {
    expect(() =>
      inputObject().parse({ handshakeId: 'hs_1', override: {}, props: {} }),
    ).toThrow();
  });

  it('(g) REJECTS a shape missing props', () => {
    expect(() => inputObject().parse({ handshakeId: 'hs_1' })).toThrow();
  });

  // (h) override.variance RE-RESOLUTION.
  //
  // Seed a cache harness whose stored blueprint sits at the DEFAULT
  // variant (variance `{}`). An `override.variance:{persona:'x'}` moves
  // the variant axis, so the effective `(contractKey, variantKey)` no
  // longer matches the proposed default-variant row.
  const PERSONA_VARIANCE = { persona: 'x' } as const;

  it('(h) override.variance REUSES a blueprint registered at the new (contractKey, variantKey)', async () => {
    const { harness, handshakeId } = await buildAcceptCacheHarness();
    // Register a SECOND blueprint at the SAME contract but the persona
    // variant — the row the re-resolution must find.
    const personaUuid = 'bp_22222222-2222-4222-8222-222222222222';
    await registerBlueprint(
      {
        embedding: fakeEmbedding,
        vectorStore: harness.vectorStore,
        index: harness.index,
      },
      APP_ID,
      {
        kind: 'template',
        contract: CONTRACT,
        intent: 'a test card',
        componentCode: STORED_CODE,
        source: { kind: 'llm', generator: 'fake-generator', model: 'fake' },
        variance: PERSONA_VARIANCE,
      },
      { mintId: () => personaUuid },
    );

    const out = await harness.handler.handler(
      { handshakeId, override: { variance: PERSONA_VARIANCE }, props: {} },
      CTX,
    );

    // Re-resolved to the persona-variant row, NOT the proposed default
    // one — reuse hit, and the wire variantKey is the new variant.
    expect(out.cache.hit).toBe(true);
    expect(out.blueprintId).toBe(personaUuid);
    expect(out.variantKey).toBe(variantKey(PERSONA_VARIANCE));
    expect(out.variantKey).not.toBe(variantKey({}));
  });

  it('(h) override.variance with NO row at the new variantKey cold-gens, registered under the new variantKey', async () => {
    // No persona-variant row is pre-seeded — only the proposed default
    // row exists. The re-resolution misses → cold-gen.
    const { harness, storedUuid, handshakeId } = await buildAcceptCacheHarness();

    const out = await harness.handler.handler(
      { handshakeId, override: { variance: PERSONA_VARIANCE }, props: {} },
      CTX,
    );

    expect(out.cache.hit).toBe(false);
    // A FRESH bp_<uuid> was minted — not the proposed default row.
    expect(out.blueprintId).not.toBe(storedUuid);
    expect(out.blueprintId).toMatch(/^bp_/);
    // (c)-style: the wire variantKey is the EFFECTIVE (new) variant, not
    // the default sentinel.
    expect(out.variantKey).toBe(variantKey(PERSONA_VARIANCE));
    expect(out.variantKey).not.toBe(variantKey({}));

    // The cold-gen row is registered under the new variantKey — a
    // SUBSEQUENT accept-style re-resolution at that exact variant finds
    // it. We assert registration directly via the index.
    const reread = await harness.index.getId(
      APP_ID,
      `template:${blueprintKey(CONTRACT)}:${variantKey(PERSONA_VARIANCE)}`,
    );
    expect(reread).toBe(out.blueprintId);

    // The served code is the COLD-GEN output (the persona variant had no
    // stored component), not the default row's STORED_CODE.
    const stored = await harness.renderStore.get(out.sessionId);
    const render = stored?.render as ComponentGguiSession | undefined;
    expect(render?.componentCode).toBe(COLD_CODE);
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
      renderStore: new InMemoryGguiSessionStore(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
      coldCode: COLD_CODE,
    });
    expect(typeof handler.description).toBe('string');
    return handler.description as string;
  }

  it('describes omitting override (ACCEPT) as REUSING the proposed contract (fast path, no regeneration)', () => {
    const d = description();
    expect(d).toMatch(/CALL SHAPE: ggui_render/);
    expect(d).toMatch(/REUSES the contract the handshake proposed/);
    expect(d).toMatch(/no regeneration/);
  });

  it('describes override.contract as fresh generation from your own contract (STRICT)', () => {
    const d = description();
    expect(d).toMatch(/override/);
    expect(d).toMatch(/generates fresh/);
    expect(d).toMatch(/STRICT/);
    expect(d).toMatch(/this call fails/);
  });

  it('teaches override.variance re-aims the variant while keeping the agreed contract', () => {
    const d = description();
    expect(d).toMatch(/override\.variance re-aims the variant/);
    expect(d).toMatch(/keeping the agreed contract/);
    expect(d).toMatch(/distinct cached component/);
  });

  it('teaches the variance/data boundary (design signals vs per-user data)', () => {
    const d = description();
    // variance carries design-shaping signals; per-user runtime data
    // belongs in props/contextSpec, never variance.
    expect(d).toMatch(/VARIANCE is design-shaping signals only/);
    expect(d).toMatch(/persona\/aesthetic\/mood/);
    expect(d).toMatch(/per-user runtime data goes in props\/contextSpec, NOT variance/);
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

describe('createGguiRenderHandler — resultMeta forwards App.theme to the wire slice (St3 M2.1)', () => {
  const THEME: AppTheme = {
    mode: 'dark',
    cssVariables: { '--ggui-color-primary-600': '#7c3aed' },
    name: 'violet',
  };

  /** Seed a committed component render carrying a `theme` sidecar, then
   *  drive the handler's `resultMeta` and parse the emitted wire meta —
   *  the ASSEMBLED `McpAppAiGguiRenderMeta`, not the intermediate view. */
  async function emitWireMeta(
    overrides: Partial<ComponentGguiSession>,
  ): Promise<ReturnType<typeof parseMcpAppAiGguiRenderMeta>> {
    const renderStore = new InMemoryGguiSessionStore();
    const sessionId = 'render-theme-1';
    const nowMs = Date.now();
    const render: ComponentGguiSession = {
      id: sessionId,
      appId: APP_ID,
      type: 'component',
      componentCode: STORED_CODE,
      contentType: 'application/javascript+react',
      createdAt: nowMs,
      lastActivityAt: nowMs,
      expiresAt: nowMs + 60_000,
      eventSequence: 0,
      ...overrides,
    };
    await renderStore.commit({ render, appId: APP_ID });

    const handler = buildHandler({
      handshakeStore: new InMemoryKeyValueStore(),
      renderStore,
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
      coldCode: COLD_CODE,
    });

    const output = {
      sessionId,
      resourceUri: `ui://ggui/render/${sessionId}`,
      action: 'create' as const,
      contractHash: 'hash',
      blueprintId: 'bp_x',
      variantKey: 'vk',
      shortCode: 'abcdefghjk234567',
      codeReady: true,
      cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' as const },
    };
    const meta = await handler.resultMeta?.(output, {}, CTX);
    return parseMcpAppAiGguiRenderMeta(meta);
  }

  it('stamps the render-sidecar theme onto the assembled wire meta', async () => {
    const parsed = await emitWireMeta({ theme: THEME });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta?.theme).toEqual(THEME);
  });

  it('omits theme from the wire meta when the render carries none', async () => {
    const parsed = await emitWireMeta({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta?.theme).toBeUndefined();
  });
});
