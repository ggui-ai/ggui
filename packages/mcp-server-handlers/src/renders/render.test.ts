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
  InMemoryCodeStore,
  InMemoryKeyValueStore,
  InMemoryRenderIdentityStore,
  InMemoryGguiSessionStore,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  CodeStore,
  EmbeddingProvider,
  RenderIdentityRecord,
  RenderIdentityStore,
  UiGenerateResult,
} from '@ggui-ai/mcp-server-core';
import {
  renderOutputSchema,
  type AppTheme,
  type DataContract,
  type ComponentGguiSession,
} from '@ggui-ai/protocol';
import {
  asGguiRenderBootstrap,
  parseMcpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import * as matcherModule from './blueprint-matcher.js';
import { registerBlueprint } from './blueprint-registry.js';
import { CODE_DELIVERY_EVENTS } from './code-delivery-events.js';
import { handshakeRecordKey, type HandshakeRecord } from './handshake.js';
import { createGguiRenderHandler, type GguiRenderHandlerDeps } from './render.js';
import type { BlueprintPool } from './decide-handshake.js';
import {
  isHandlerFailure,
  type HandlerContext,
  type HandlerFailure,
} from '../types.js';

/**
 * Narrow a render invocation to the SUCCESS arm. The handler's result
 * union carries the opt-in {@link HandlerFailure} failure envelope;
 * these tests exercise success paths — a failure here is a test bug,
 * surfaced with the envelope's own text. The failure-envelope suite
 * below reads the raw union instead.
 */
function assertRenderSuccess<T>(
  result: T,
): asserts result is Exclude<T, HandlerFailure<unknown>> {
  if (isHandlerFailure(result)) {
    throw new Error(
      `expected render success, got failure envelope: ${result.errorText}`,
    );
  }
}

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
  /**
   * Optional render-row retention override. Threaded onto the handler
   * deps' `renderTtlMs` so tests can assert the committed row's
   * `expiresAt` reflects an operator-configured window instead of the
   * `DEFAULT_RENDER_TTL_MS` (1h) fallback.
   */
  readonly renderTtlMs?: number;
  /**
   * Optional durable render-identity side store. Threaded onto the
   * handler deps so tests can read back the record every commit site
   * writes. Omitted = the "no store bound" posture (no records, every
   * other path unchanged).
   */
  readonly renderIdentityStore?: RenderIdentityStore;
  /**
   * Optional content-addressable code-delivery pair. Both must be
   * present for the handler to mint a `codeUrl`; the code-delivery
   * suite below wires a rejecting store to exercise the arm where the
   * mint fails.
   */
  readonly codeStore?: GguiRenderHandlerDeps['codeStore'];
  readonly codeBaseUrl?: string;
  /**
   * Optional live-channel credential minter. Presence is what decides
   * whether a lost `codeUrl` leaves the envelope mountable, so the
   * code-delivery suite drives both postures through this seam.
   */
  readonly mintWsToken?: GguiRenderHandlerDeps['mintWsToken'];
  /**
   * Optional admission-control seam (#488). Presence is what decides
   * whether the handler's rate-limiter check runs at all; the
   * fairness-key suite drives it with a capturing fake to assert the
   * exact `limiterKey` string the handler composes.
   */
  readonly rateLimiter?: GguiRenderHandlerDeps['rateLimiter'];
}): ReturnType<typeof createGguiRenderHandler> {
  return createGguiRenderHandler({
    handshakeStore: opts.handshakeStore,
    renderStore: opts.renderStore,
    ...(opts.checkRenderContracts
      ? { checkRenderContracts: opts.checkRenderContracts }
      : {}),
    ...(opts.postSuccessHook ? { postSuccessHook: opts.postSuccessHook } : {}),
    ...(opts.renderTtlMs !== undefined ? { renderTtlMs: opts.renderTtlMs } : {}),
    ...(opts.renderIdentityStore
      ? { renderIdentityStore: opts.renderIdentityStore }
      : {}),
    ...(opts.codeStore ? { codeStore: opts.codeStore } : {}),
    ...(opts.codeBaseUrl !== undefined
      ? { codeBaseUrl: opts.codeBaseUrl }
      : {}),
    ...(opts.mintWsToken ? { mintWsToken: opts.mintWsToken } : {}),
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
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
  /** Agreed contract for the record. Defaults to {@link CONTRACT}. */
  readonly contract?: DataContract;
}): HandshakeRecord {
  const contract = opts.contract ?? CONTRACT;
  return {
    handshakeId: opts.handshakeId,
    action: opts.origin === 'cache' ? 'reuse' : 'create',
    reason: 'test',
    input: {
      intent: 'a test card',
      blueprintDraft: { contract },
    },
    target: {},
    suggestion: {
      origin: opts.origin,
      rationale: 'test',
      blueprintMeta: {
        contractHash: blueprintKey(contract),
        variance: {},
      },
    },
    effectiveContract: contract,
    ...(opts.matchedBlueprint ? { matchedBlueprint: opts.matchedBlueprint } : {}),
    appId: APP_ID,
    createdAt: new Date().toISOString(),
  };
}

/** Cache harness — pre-seeds a Blueprint at a known UUID + an
 *  origin:'cache' handshake record that references it. */
async function buildAcceptCacheHarness(extraOpts: {
  readonly postSuccessHook?: GguiRenderHandlerDeps['postSuccessHook'];
  readonly renderIdentityStore?: RenderIdentityStore;
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
    ...(extraOpts.renderIdentityStore
      ? { renderIdentityStore: extraOpts.renderIdentityStore }
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
  readonly renderTtlMs?: number;
  readonly renderIdentityStore?: RenderIdentityStore;
  /** #460 — injectable so a test can make registration fail. */
  readonly index?: InMemoryBlueprintIndex;
  /** Agreed contract for the seeded handshake. Defaults to {@link CONTRACT}. */
  readonly contract?: DataContract;
  /** Content-addressable code-delivery pair — see {@link buildHandler}. */
  readonly codeStore?: GguiRenderHandlerDeps['codeStore'];
  readonly codeBaseUrl?: string;
  /** Live-channel credential minter — see {@link buildHandler}. */
  readonly mintWsToken?: GguiRenderHandlerDeps['mintWsToken'];
  /** Admission-control seam (#488) — see {@link buildHandler}. */
  readonly rateLimiter?: GguiRenderHandlerDeps['rateLimiter'];
} = {}): Promise<{
  readonly harness: Harness;
  readonly handshakeId: string;
}> {
  const handshakeStore = new InMemoryKeyValueStore();
  const renderStore = new InMemoryGguiSessionStore();
  const vectorStore = new InMemoryVectorStore();
  const index = extraOpts.index ?? new InMemoryBlueprintIndex();

  const handshakeId = 'hs-cold-1';
  await seedHandshake(
    handshakeStore,
    handshakeId,
    buildRecord({
      handshakeId,
      origin: 'agent',
      ...(extraOpts.contract ? { contract: extraOpts.contract } : {}),
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
    ...(extraOpts.renderTtlMs !== undefined
      ? { renderTtlMs: extraOpts.renderTtlMs }
      : {}),
    ...(extraOpts.renderIdentityStore
      ? { renderIdentityStore: extraOpts.renderIdentityStore }
      : {}),
    ...(extraOpts.codeStore ? { codeStore: extraOpts.codeStore } : {}),
    ...(extraOpts.codeBaseUrl !== undefined
      ? { codeBaseUrl: extraOpts.codeBaseUrl }
      : {}),
    ...(extraOpts.mintWsToken ? { mintWsToken: extraOpts.mintWsToken } : {}),
    ...(extraOpts.rateLimiter ? { rateLimiter: extraOpts.rateLimiter } : {}),
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
    assertRenderSuccess(out);
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
    assertRenderSuccess(out);
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
    assertRenderSuccess(out);
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
    assertRenderSuccess(out);
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

  // Retention knob (spec §4 re-cut): operators align render-row
  // retention with chat-history lifetime so rehydration-by-refetch
  // outlives the hard-coded `DEFAULT_RENDER_TTL_MS` (1h). Drives the
  // same cold-gen happy path as (e) above, but with `renderTtlMs` set
  // to a 90-day window, and asserts the COMMITTED render's own
  // `expiresAt` (not the store's independent bucket-level TTL) reflects
  // it.
  it('renderTtlMs overrides the default 1h row expiry', async () => {
    const NOW = Date.now();
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const { harness, handshakeId } = await buildColdGenHarness({
      renderTtlMs: NINETY_DAYS_MS,
    });
    const out = await harness.handler.handler(
      { handshakeId, props: {} },
      CTX,
    );
    assertRenderSuccess(out);

    const stored = await harness.renderStore.get(out.sessionId);
    const render = stored?.render as ComponentGguiSession | undefined;
    expect(render?.expiresAt).toBeGreaterThan(NOW + 89 * 24 * 60 * 60 * 1000);
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
    assertRenderSuccess(out);
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
    assertRenderSuccess(out);
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
    assertRenderSuccess(out);

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
    assertRenderSuccess(out);

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
    assertRenderSuccess(out);

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
    assertRenderSuccess(out);
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

    assertRenderSuccess(out);
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

  // §6 self-heal is documented as "Never throws" (render.ts: a dangling
  // binding or stale index resolves to null → cold-gen fallthrough). A
  // BlueprintIndex backed by a remote store (e.g. DynamoDB) can REJECT
  // rather than miss — a throttle, a network blip, a transient IAM
  // fault. Mirrors the existing "registration failure commits
  // blueprintId: null" test's monkeypatch-after-seed idiom (durable
  // render identity suite, below): register normally first, THEN
  // install the fault so setup is unaffected.
  it('(h) a rejecting index.getId cannot fail the render — falls through to cold-gen, no throw', async () => {
    const handshakeStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryGguiSessionStore();
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();

    // Seed the default-variant row BEFORE the fault is installed — this
    // registration must succeed normally.
    const storedUuid = 'bp_33333333-3333-4333-8333-333333333333';
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

    // Install the fault AFTER setup — every getId from here on rejects,
    // both the §6 point-read (findExactAcrossPools) AND cold-gen's own
    // registerBlueprint dedup-check getId.
    index.getId = async () => {
      throw new Error('index unavailable (simulated fault)');
    };

    const handshakeId = 'hs-cache-rejecting-index';
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

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // override.variance re-resolves via findExactAcrossPools →
      // findBlueprintExact → index.getId, which now REJECTS.
      const out = await handler.handler(
        { handshakeId, override: { variance: PERSONA_VARIANCE }, props: {} },
        CTX,
      );

      // Never throws — degrades exactly like a genuine miss. The §6
      // point-read AND cold-gen's own dedup-check getId both hit the
      // same fault, so the cold-gen write is ALSO swallowed
      // (safelyRegisterBlueprint's existing guard) — same
      // wire-shape as the "registration failure" test below.
      assertRenderSuccess(out);
      expect(out.cache.hit).toBe(false);
      expect(out.blueprintId).toBe('');

      const warned = warn.mock.calls.some(
        ([first]) =>
          typeof first === 'string' &&
          first.includes('index unavailable (simulated fault)'),
      );
      expect(warned).toBe(true);
    } finally {
      warn.mockRestore();
    }
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

describe('createGguiRenderHandler — isError failure envelope (ruling B)', () => {
  // Harness with a FAILING cloud-seam-shaped generator (the `generator`
  // escape hatch — the same seam `render-factory-deps` binds), plus a
  // capturing channel notifier so the "WS notify unchanged" promise is
  // observable.
  async function buildFailingHarness(
    behavior:
      | { readonly kind: 'result'; readonly error: import('@ggui-ai/protocol').GenerationError }
      | { readonly kind: 'throw'; readonly message: string },
  ): Promise<{
    readonly handler: ReturnType<typeof createGguiRenderHandler>;
    readonly renderStore: InMemoryGguiSessionStore;
    readonly handshakeStore: InMemoryKeyValueStore;
    readonly handshakeId: string;
    readonly notified: Array<{ sessionId: string; error?: string }>;
  }> {
    const handshakeStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryGguiSessionStore();
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const handshakeId = 'hs-fail-1';
    await seedHandshake(
      handshakeStore,
      handshakeId,
      buildRecord({ handshakeId, origin: 'agent' }),
    );
    const notified: Array<{ sessionId: string; error?: string }> = [];
    const handler = createGguiRenderHandler({
      handshakeStore,
      renderStore,
      channelNotifier: {
        notifyGguiSessionCommit(sessionId, render) {
          notified.push({
            sessionId,
            ...(render.type !== 'mcpApps' && render.type !== 'system' && render.error !== undefined
              ? { error: render.error }
              : {}),
          });
        },
      },
      generation: {
        uiGenerator: {
          slug: 'ui-gen-default-fake',
          tier: 'default',
          model: 'fake',
          generate: fakeGenerator(COLD_CODE),
        },
        resolveLlm: () => null,
        blueprints: { get: async () => null, list: async () => [] },
        cache: {
          embedding: fakeEmbedding,
          vectorStore,
          index,
        },
      },
      generator: async () => {
        if (behavior.kind === 'throw') throw new Error(behavior.message);
        return { ok: false, error: behavior.error };
      },
    });
    return { handler, renderStore, handshakeStore, handshakeId, notified };
  }

  // Harness with NO generator override and resolveLlm behavior injected —
  // the OSS credential-resolution failure paths. No cache deps, so the
  // failure cache marker exercises the ?? fallback branch.
  async function buildNoCredsHarness(
    resolveLlm: () => never | null,
  ): Promise<{
    readonly handler: ReturnType<typeof createGguiRenderHandler>;
    readonly renderStore: InMemoryGguiSessionStore;
    readonly handshakeId: string;
  }> {
    const handshakeStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryGguiSessionStore();
    const handshakeId = 'hs-nocreds-1';
    await seedHandshake(
      handshakeStore,
      handshakeId,
      buildRecord({ handshakeId, origin: 'agent' }),
    );
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
        resolveLlm,
        blueprints: { get: async () => null, list: async () => [] },
      },
    });
    return { handler, renderStore, handshakeId };
  }

  it('generation failure returns the HandlerFailure marker with the pinned schema-conformant envelope', async () => {
    const { handler, handshakeId } = await buildFailingHarness({
      kind: 'result',
      error: { code: 'PRODUCTION_FAILED', message: 'provider 500' },
    });
    const out = await handler.handler({ handshakeId, props: {} }, CTX);
    expect(isHandlerFailure(out)).toBe(true);
    if (!isHandlerFailure(out)) return;

    // structuredContent stays schema-conformant (isError:true results
    // are still validated against outputSchema by MCP SDK clients).
    const parsed = renderOutputSchema.parse(out.data);
    expect(parsed.error).toEqual({
      code: 'PRODUCTION_FAILED',
      message: 'provider 500',
    });
    // resourceUri ABSENT — nothing mountable.
    expect(parsed.resourceUri).toBeUndefined();
    // blueprintId '' — present-on-materialisation sentinel.
    expect(parsed.blueprintId).toBe('');
    expect(typeof parsed.variantKey).toBe('string');
    expect(typeof parsed.contractHash).toBe('string');
    expect(parsed.sessionId.length).toBeGreaterThan(0);
    // Pinned cold failure marker.
    expect(parsed.cache).toEqual({
      hit: false,
      llmCallsAvoided: 0,
      kind: 'cold',
      reason:
        'cold: generation failed — no stored component was produced or reused',
    });
    // nextStep never lands on the failure envelope — the content text
    // carries the recovery guidance instead.
    expect(parsed.nextStep).toBeUndefined();
    // Internal seams still ride the pre-parse data for in-process readers.
    expect(out.data.codeReady).toBe(false);
  });

  it('content text follows the pinned guidance format', async () => {
    const { handler, handshakeId } = await buildFailingHarness({
      kind: 'result',
      error: { code: 'PRODUCTION_FAILED', message: 'provider 500' },
    });
    const out = await handler.handler({ handshakeId, props: {} }, CTX);
    if (!isHandlerFailure(out)) throw new Error('expected failure envelope');
    expect(out.errorText.startsWith('PRODUCTION_FAILED: provider 500. ')).toBe(
      true,
    );
    expect(out.errorText).toContain(
      'Do not call ggui_render again with this handshakeId — it is consumed.',
    );
    expect(out.errorText).toContain('call ggui_handshake again once resolved.');
  });

  it('the handshake really is consumed — a retry on the same handshakeId rejects handshake_not_found', async () => {
    const { handler, handshakeId } = await buildFailingHarness({
      kind: 'result',
      error: { code: 'PRODUCTION_FAILED', message: 'provider 500' },
    });
    const out = await handler.handler({ handshakeId, props: {} }, CTX);
    expect(isHandlerFailure(out)).toBe(true);
    await expect(
      handler.handler({ handshakeId, props: {} }, CTX),
    ).rejects.toMatchObject({ code: 'handshake_not_found' });
  });

  it('cloud seam codes map through: VALIDATION_ERROR, NO_PLATFORM_KEY, and GENERATION_QUEUE_OVERLOADED verbatim, COMPILATION_ERROR folds to PRODUCTION_FAILED', async () => {
    const cases = [
      { in: 'VALIDATION_ERROR', outCode: 'VALIDATION_ERROR' },
      { in: 'NO_PLATFORM_KEY', outCode: 'NO_PLATFORM_KEY' },
      { in: 'COMPILATION_ERROR', outCode: 'PRODUCTION_FAILED' },
      { in: 'GENERATION_QUEUE_OVERLOADED', outCode: 'GENERATION_QUEUE_OVERLOADED' },
    ] as const;
    for (const kase of cases) {
      const { handler, handshakeId } = await buildFailingHarness({
        kind: 'result',
        error: { code: kase.in, message: `m-${kase.in}` },
      });
      const out = await handler.handler({ handshakeId, props: {} }, CTX);
      if (!isHandlerFailure(out)) throw new Error('expected failure envelope');
      expect(out.data.error.code).toBe(kase.outCode);
      expect(out.data.error.message).toBe(`m-${kase.in}`);
      expect(out.errorText.startsWith(`${kase.outCode}: m-${kase.in}.`)).toBe(
        true,
      );
    }
  });

  it('a throwing generator maps to PRODUCTION_FAILED', async () => {
    const { handler, handshakeId } = await buildFailingHarness({
      kind: 'throw',
      message: 'esbuild exploded',
    });
    const out = await handler.handler({ handshakeId, props: {} }, CTX);
    if (!isHandlerFailure(out)) throw new Error('expected failure envelope');
    expect(out.data.error.code).toBe('PRODUCTION_FAILED');
    expect(out.data.error.message).toContain('esbuild exploded');
  });

  it('resolveLlm returning null (no fallback card) maps to NO_CREDENTIALS, with the same pinned cache reason', async () => {
    const { handler, handshakeId } = await buildNoCredsHarness(() => null);
    const out = await handler.handler({ handshakeId, props: {} }, CTX);
    if (!isHandlerFailure(out)) throw new Error('expected failure envelope');
    expect(out.data.error.code).toBe('NO_CREDENTIALS');
    // No cache deps on this harness — the ?? fallback pins the same reason.
    expect(out.data.cache.reason).toBe(
      'cold: generation failed — no stored component was produced or reused',
    );
  });

  it('resolveLlm throwing maps to NO_CREDENTIALS', async () => {
    const { handler, handshakeId } = await buildNoCredsHarness(() => {
      throw new Error('keychain unreachable');
    });
    const out = await handler.handler({ handshakeId, props: {} }, CTX);
    if (!isHandlerFailure(out)) throw new Error('expected failure envelope');
    expect(out.data.error.code).toBe('NO_CREDENTIALS');
    expect(out.data.error.message).toContain('keychain unreachable');
  });

  it('the error GguiSession is STILL committed and the live notify fired (session-channel archaeology intact)', async () => {
    const { handler, renderStore, handshakeId, notified } =
      await buildFailingHarness({
        kind: 'result',
        error: { code: 'PRODUCTION_FAILED', message: 'provider 500' },
      });
    const out = await handler.handler({ handshakeId, props: {} }, CTX);
    if (!isHandlerFailure(out)) throw new Error('expected failure envelope');
    const stored = await renderStore.get(out.data.sessionId);
    const render = stored?.render;
    expect(render).toBeDefined();
    if (!render || render.type === 'mcpApps' || render.type === 'system') {
      throw new Error('expected a ComponentGguiSession error render');
    }
    expect(render.componentCode).toBe('');
    expect(render.error).toBe('provider 500');
    // The commit notify fan-out fired for the error render.
    expect(
      notified.some(
        (n) => n.sessionId === out.data.sessionId && n.error === 'provider 500',
      ),
    ).toBe(true);
  });

  it('NO _meta on failures — resultMeta yields undefined for the failure marker', async () => {
    const { handler, handshakeId } = await buildFailingHarness({
      kind: 'result',
      error: { code: 'PRODUCTION_FAILED', message: 'provider 500' },
    });
    const out = await handler.handler({ handshakeId, props: {} }, CTX);
    if (!isHandlerFailure(out)) throw new Error('expected failure envelope');
    const meta = await handler.resultMeta?.(out, { handshakeId, props: {} }, CTX);
    expect(meta).toBeUndefined();
  });

  it('success path is unchanged: resourceUri present, no error field, not a failure marker', async () => {
    const { harness, handshakeId } = await buildColdGenHarness();
    const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
    expect(isHandlerFailure(out)).toBe(false);
    assertRenderSuccess(out);
    const parsed = renderOutputSchema.parse(out);
    expect(typeof parsed.resourceUri).toBe('string');
    expect((parsed.resourceUri ?? '').length).toBeGreaterThan(0);
    expect(parsed.error).toBeUndefined();
  });
});

/**
 * Durable render-identity write-through (#430 slice 1).
 *
 * Every render commit also writes the side record that lets a
 * `ui://ggui/render/{sessionId}/{blueprintKey}` locator re-mint the
 * render after the render row itself is gone. These assert the record
 * the handler produces, not the store that holds it (that contract is
 * covered by `@ggui-ai/mcp-server-core`'s own port suite).
 *
 * The domain pin is the load-bearing assertion: `contractKey` MUST
 * equal `blueprintKey(effectiveContract)` — the 16-char
 * blueprint-registry key — and never the 64-char validators-bundle
 * contract hash. The two are different lengths AND different domains,
 * so equality (not just length) is what catches a wrong-domain write.
 */
describe('createGguiRenderHandler — durable render identity (#430 slice 1)', () => {
  /** Contract with a real declared prop, so "props verbatim" is observable. */
  const PROPS_CONTRACT: DataContract = {
    propsSpec: { properties: { title: { schema: { type: 'string' } } } },
  };
  /** Caller carrying a resolved user, so tenancy is observable on the record. */
  const USER_CTX: HandlerContext = { ...CTX, userId: 'user-9' };

  async function readRecord(
    store: InMemoryRenderIdentityStore,
    sessionId: string,
  ): Promise<RenderIdentityRecord> {
    const record = await store.get(sessionId);
    if (!record) {
      throw new Error(`expected a render-identity record for ${sessionId}`);
    }
    return record;
  }

  it('cold gen writes the full record — 16-char blueprintKey domain, variantKey, props, tenancy, seq', async () => {
    const renderIdentityStore = new InMemoryRenderIdentityStore();
    const { harness, handshakeId } = await buildColdGenHarness({
      renderIdentityStore,
      contract: PROPS_CONTRACT,
    });

    const out = await harness.handler.handler(
      { handshakeId, props: { title: 'Hello' } },
      USER_CTX,
    );
    assertRenderSuccess(out);

    const record = await readRecord(renderIdentityStore, out.sessionId);
    // Domain pin — EQUALITY with the blueprint key, plus its length.
    expect(record.contractKey).toBe(blueprintKey(PROPS_CONTRACT));
    expect(record.contractKey).toHaveLength(16);
    expect(record.variantKey).toBe(variantKey(undefined));
    expect(record.props).toEqual({ title: 'Hello' });
    expect(record.sessionId).toBe(out.sessionId);
    expect(record.appId).toBe(APP_ID);
    expect(record.userId).toBe('user-9');

    // `seqAtLastCommit` is sampled off the committed row, not guessed.
    const stored = await harness.renderStore.get(out.sessionId);
    expect(record.seqAtLastCommit).toBe(stored?.eventSequence);
    expect(record.createdAt).toBe(stored?.createdAt);
    expect(record.updatedAt).toBeGreaterThanOrEqual(record.createdAt);
  });

  it('cold gen writes the blueprintId AT the success commit — no post-commit mutation (#460)', async () => {
    const renderIdentityStore = new InMemoryRenderIdentityStore();
    const puts: Array<{ sessionId: string; blueprintId: string | null }> = [];
    const originalPut = renderIdentityStore.put.bind(renderIdentityStore);
    renderIdentityStore.put = async (record) => {
      puts.push({ sessionId: record.sessionId, blueprintId: record.blueprintId });
      await originalPut(record);
    };
    const { harness, handshakeId } = await buildColdGenHarness({
      renderIdentityStore,
    });

    const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
    assertRenderSuccess(out);

    const record = await readRecord(renderIdentityStore, out.sessionId);
    expect(record.blueprintId).not.toBeNull();
    // The commit-time id is the SAME one the wire surfaces.
    expect(record.blueprintId).toBe(out.blueprintId);
    expect(record.blueprintId).toMatch(/^bp_/);

    // Ordering pin: registration resolved BEFORE the success commit,
    // so the id arrives ON a commit's own put — never as a later
    // read-modify-write of an id-less record (the deleted backfill's
    // shape). The placeholder put legitimately carries null; the
    // SUCCESS put must already carry the id.
    const sessionPuts = puts.filter((w) => w.sessionId === out.sessionId);
    const idPuts = sessionPuts.filter((w) => w.blueprintId !== null);
    expect(idPuts.length).toBeGreaterThanOrEqual(1);
    expect(idPuts[0]!.blueprintId).toBe(out.blueprintId);
    // No put may DOWNGRADE the id back to null after it was written.
    const firstIdIdx = sessionPuts.findIndex((w) => w.blueprintId !== null);
    for (const later of sessionPuts.slice(firstIdIdx)) {
      expect(later.blueprintId).toBe(out.blueprintId);
    }
  });

  it('registration failure commits blueprintId: null and the render still succeeds (#460/#445)', async () => {
    const renderIdentityStore = new InMemoryRenderIdentityStore();
    const index = new InMemoryBlueprintIndex();
    // First registry touch throws — `safelyRegisterBlueprint` swallows
    // to undefined, the commit records null, the render is unharmed.
    index.getId = async () => {
      throw new Error('registry unavailable');
    };
    const { harness, handshakeId } = await buildColdGenHarness({
      renderIdentityStore,
      index,
    });

    const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
    assertRenderSuccess(out);

    const record = await readRecord(renderIdentityStore, out.sessionId);
    expect(record.blueprintId).toBeNull();
    // The wire mirrors the record: empty id on the failure path.
    expect(out.blueprintId).toBe('');
  });

  it('a themeId override re-commits LAST and its record keeps the commit-time blueprintId', async () => {
    const renderIdentityStore = new InMemoryRenderIdentityStore();
    const { harness, handshakeId } = await buildColdGenHarness({
      renderIdentityStore,
    });

    const out = await harness.handler.handler(
      { handshakeId, props: {}, themeId: 'dark' },
      CTX,
    );
    assertRenderSuccess(out);

    // Proves the overlay path actually ran — without the re-commit
    // there is no last write for this test to be about.
    const stored = await harness.renderStore.get(out.sessionId);
    const render = stored?.render;
    if (!render || render.type === 'mcpApps' || render.type === 'system') {
      throw new Error('expected a ComponentGguiSession from cold gen');
    }
    expect(render.themeId).toBe('dark');

    // The overlay commit lands AFTER the success commit wrote the
    // resolved id (#460 — resolved before that commit), so its record
    // must carry the id forward. Writing `null` here (or reading a
    // `resolvedBlueprintId` that has not settled yet) would silently
    // erase it.
    const record = await readRecord(renderIdentityStore, out.sessionId);
    expect(record.blueprintId).not.toBeNull();
    expect(record.blueprintId).toBe(out.blueprintId);
    expect(record.seqAtLastCommit).toBe(stored?.eventSequence);
  });

  it('cache reuse writes the reused blueprint id straight through', async () => {
    const renderIdentityStore = new InMemoryRenderIdentityStore();
    const { harness, handshakeId, storedUuid } = await buildAcceptCacheHarness({
      renderIdentityStore,
    });

    const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
    assertRenderSuccess(out);
    expect(out.blueprintId).toBe(storedUuid);

    const record = await readRecord(renderIdentityStore, out.sessionId);
    expect(record.blueprintId).toBe(storedUuid);
    expect(record.contractKey).toBe(blueprintKey(CONTRACT));
    expect(record.contractKey).toHaveLength(16);
  });

  it('no store bound — render succeeds', async () => {
    const { harness, handshakeId } = await buildColdGenHarness();
    const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
    assertRenderSuccess(out);
    expect(out.codeReady).toBe(true);
  });

  it('a rejecting store cannot fail the render — logs render_identity_write_failed', async () => {
    const rejecting: RenderIdentityStore = {
      durability: 'ephemeral',
      put: async () => {
        throw new Error('identity store offline');
      },
      get: async () => null,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { harness, handshakeId } = await buildColdGenHarness({
        renderIdentityStore: rejecting,
      });
      const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
      assertRenderSuccess(out);
      expect(out.codeReady).toBe(true);

      const events = warn.mock.calls
        .map(([first]) => (typeof first === 'string' ? first : ''))
        .filter((line) => line.includes('render_identity_write_failed'))
        .map((line) => JSON.parse(line) as {
          readonly msg: string;
          readonly sessionId: string;
          readonly appId: string;
          readonly error: string;
        });
      expect(events.length).toBeGreaterThan(0);
      const [event] = events;
      expect(event?.msg).toBe('render_identity_write_failed');
      expect(event?.sessionId).toBe(out.sessionId);
      expect(event?.appId).toBe(APP_ID);
      expect(event?.error).toBe('identity store offline');
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Content-addressable code delivery — what a lost `codeUrl` costs.
 *
 * `codeUrl` is the only STATIC delivery channel a compiled-component
 * envelope has: a bootstrap mounts on `codeUrl`, on a system-card
 * `kind`, or on the live trio, and nothing sits behind any of them
 * (`kind` is static too, but the handler excludes system renders from
 * this channel). So a rejected store write does not fall back onto
 * some second static path — it changes what the envelope can do, in a
 * way that is invisible on the wire (the render reports success
 * either way).
 *
 * Three things are pinned. The DEGRADE: the render still succeeds and,
 * when the deployment mints live-channel credentials, the envelope is
 * still mountable. The CONSEQUENCE: without those credentials the
 * envelope is NOT mountable — asserted through the host-facing
 * narrowing (`asGguiRenderBootstrap`) rather than by inspecting fields,
 * because that function IS how a host decides. And the SIGNAL: the
 * failure is named, with the live-channel posture on it, so the
 * difference between "slower first paint" and "nothing mounts" is
 * readable in the log.
 */
describe('createGguiRenderHandler — code-delivery channel', () => {
  const CODE_BASE_URL = 'https://renders.example.com';

  /** A code store whose every `put` rejects. */
  function rejectingCodeStore(message: string): CodeStore {
    return {
      durability: 'ephemeral',
      put: async () => {
        throw new Error(message);
      },
      get: async () => null,
      delete: async () => {},
      hashOf: () => 'a'.repeat(64),
    };
  }

  const MINT_WS: NonNullable<GguiRenderHandlerDeps['mintWsToken']> = () => ({
    wsUrl: 'wss://renders.example.com/ws',
    token: 'ws-token-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  /** Silence + capture `console.warn` for the duration of one test. */
  function spyOnWarn() {
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  /** The `render_code_write_failed` events emitted during a spy window. */
  function codeWriteEvents(
    warn: ReturnType<typeof spyOnWarn>,
  ): ReadonlyArray<{
    readonly msg: string;
    readonly sessionId: string;
    readonly appId: string;
    readonly liveChannelWired: boolean;
    readonly error: string;
  }> {
    return warn.mock.calls
      .map(([first]) => (typeof first === 'string' ? first : ''))
      .filter((line) => line.includes(CODE_DELIVERY_EVENTS.renderCodeWriteFailed))
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly msg: string;
            readonly sessionId: string;
            readonly appId: string;
            readonly liveChannelWired: boolean;
            readonly error: string;
          },
      );
  }

  it('mints codeUrl from the store hash and emits nothing when the write lands', async () => {
    const warn = spyOnWarn();
    try {
      const codeStore = new InMemoryCodeStore();
      const { harness, handshakeId } = await buildColdGenHarness({
        codeStore,
        codeBaseUrl: CODE_BASE_URL,
      });
      const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
      assertRenderSuccess(out);

      const expectedHash = codeStore.hashOf(COLD_CODE);
      expect(out.codeHash).toBe(expectedHash);
      expect(out.codeUrl).toBe(`${CODE_BASE_URL}/code/${expectedHash}.js`);
      expect(await codeStore.get(expectedHash)).toBe(COLD_CODE);
      // A healthy write is not an event. Asserting the empty case is
      // what keeps the failure arm below meaningful.
      expect(codeWriteEvents(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a rejecting store cannot fail the render — no codeUrl, and render_code_write_failed names it', async () => {
    const warn = spyOnWarn();
    try {
      const { harness, handshakeId } = await buildColdGenHarness({
        codeStore: rejectingCodeStore('code store offline'),
        codeBaseUrl: CODE_BASE_URL,
      });
      const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
      assertRenderSuccess(out);
      expect(out.codeReady).toBe(true);
      expect(out.codeUrl).toBeUndefined();
      expect(out.codeHash).toBeUndefined();

      const events = codeWriteEvents(warn);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event?.msg).toBe('render_code_write_failed');
      expect(event?.sessionId).toBe(out.sessionId);
      expect(event?.appId).toBe(APP_ID);
      expect(event?.error).toBe('code store offline');
    } finally {
      warn.mockRestore();
    }
  });

  it('without a live channel the envelope STILL mounts — inline codeB64 carries the code past the dead store (#471)', async () => {
    const warn = spyOnWarn();
    try {
      const { harness, handshakeId } = await buildColdGenHarness({
        codeStore: rejectingCodeStore('code store offline'),
        codeBaseUrl: CODE_BASE_URL,
      });
      const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
      assertRenderSuccess(out);

      // The host-facing narrowing is the authority on "can this mount":
      // runtimeUrl plus one mode discriminator. codeUrl is gone with
      // the store, but the size-capped inline `codeB64` channel is
      // independent of the store — the render mounts through it. (Until
      // #471 introduced codeB64, this exact scenario was unmountable.)
      const meta = await harness.handler.resultMeta?.(out, {}, CTX);
      const bootstrap = asGguiRenderBootstrap(meta);
      expect(bootstrap).toBeDefined();
      expect(bootstrap?.slice.codeUrl).toBeUndefined();
      expect(bootstrap?.slice.codeB64).toBe(
        Buffer.from(COLD_CODE, 'utf8').toString('base64'),
      );

      // The code-delivery event still reports the dead store honestly.
      const [event] = codeWriteEvents(warn);
      expect(event?.liveChannelWired).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('with a live channel the envelope still mounts — the WS subscribe carries the render', async () => {
    const warn = spyOnWarn();
    try {
      const { harness, handshakeId } = await buildColdGenHarness({
        codeStore: rejectingCodeStore('code store offline'),
        codeBaseUrl: CODE_BASE_URL,
        mintWsToken: MINT_WS,
      });
      const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
      assertRenderSuccess(out);
      expect(out.codeUrl).toBeUndefined();

      const meta = await harness.handler.resultMeta?.(out, {}, CTX);
      const bootstrap = asGguiRenderBootstrap(meta);
      expect(bootstrap).toBeDefined();
      // Mountable through the live trio specifically — not through a
      // codeUrl that quietly survived.
      expect(bootstrap?.slice.wsUrl).toBe('wss://renders.example.com/ws');
      expect(bootstrap?.slice.wsToken).toBe('ws-token-1');
      expect(bootstrap?.slice.codeUrl).toBeUndefined();

      const [event] = codeWriteEvents(warn);
      expect(event?.liveChannelWired).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('createGguiRenderHandler — admission-control key composition (#488)', () => {
  /** A rate limiter that always allows, capturing every `key` it was
   *  called with so tests can assert the exact bucket the handler
   *  composed. */
  function capturingRateLimiter(): {
    readonly rateLimiter: NonNullable<GguiRenderHandlerDeps['rateLimiter']>;
    readonly checkedKeys: string[];
  } {
    const checkedKeys: string[] = [];
    return {
      rateLimiter: {
        async check(input) {
          checkedKeys.push(input.key);
          return { allowed: true, remaining: 999, resetAt: Date.now() + 60_000 };
        },
      },
      checkedKeys,
    };
  }

  it('buckets a federated end-user (ctx.userId set, no apiKeyHash) by userId, not "anon"', async () => {
    const { rateLimiter, checkedKeys } = capturingRateLimiter();
    const { harness, handshakeId } = await buildColdGenHarness({ rateLimiter });
    const userCtx: HandlerContext = { ...CTX, userId: 'sub_abc123' };

    const out = await harness.handler.handler({ handshakeId, props: {} }, userCtx);
    assertRenderSuccess(out);

    expect(checkedKeys).toContain(`ggui_render:${APP_ID}:sub_abc123`);
  });

  it('still buckets an app-kind caller (apiKeyHash set) by apiKeyHash, unchanged', async () => {
    const { rateLimiter, checkedKeys } = capturingRateLimiter();
    const { harness, handshakeId } = await buildColdGenHarness({ rateLimiter });
    const appCtx: HandlerContext = { ...CTX, apiKeyHash: 'hash_xyz' };

    const out = await harness.handler.handler({ handshakeId, props: {} }, appCtx);
    assertRenderSuccess(out);

    expect(checkedKeys).toContain(`ggui_render:${APP_ID}:hash_xyz`);
  });

  it('still buckets a keyless/anonymous caller as "anon", unchanged', async () => {
    const { rateLimiter, checkedKeys } = capturingRateLimiter();
    const { harness, handshakeId } = await buildColdGenHarness({ rateLimiter });

    const out = await harness.handler.handler({ handshakeId, props: {} }, CTX);
    assertRenderSuccess(out);

    expect(checkedKeys).toContain(`ggui_render:${APP_ID}:anon`);
  });

  it('prefers apiKeyHash over userId when both are somehow set (apiKeyHash stays first in the composition)', async () => {
    const { rateLimiter, checkedKeys } = capturingRateLimiter();
    const { harness, handshakeId } = await buildColdGenHarness({ rateLimiter });
    const bothCtx: HandlerContext = {
      ...CTX,
      apiKeyHash: 'hash_xyz',
      userId: 'sub_abc123',
    };

    const out = await harness.handler.handler({ handshakeId, props: {} }, bothCtx);
    assertRenderSuccess(out);

    expect(checkedKeys).toContain(`ggui_render:${APP_ID}:hash_xyz`);
    expect(checkedKeys.some((k) => k.includes('sub_abc123'))).toBe(false);
  });
});
