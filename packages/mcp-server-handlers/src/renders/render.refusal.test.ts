/**
 * `ggui_render` — the pre-generation refusal projection (ggui#786).
 *
 * The hook contract changes: `preValidationGate` no longer THROWS to
 * reject (the old docstring said the gate "owns the wire envelope"), it
 * RETURNS a refusal and the HANDLER owns the envelope. Returning a
 * refusal is the only conformant way to refuse; a gate that throws stays
 * on the prose/JSON-RPC path and is a conformance failure.
 *
 * What these tests fix in place — all four are the ruling's invariants,
 * not implementation detail:
 *
 *   1. The projection happens BEFORE `z.object(inputSchema).parse`. The
 *      pin is a DELIBERATELY MALFORMED input: if the projection sat one
 *      statement later, this call would raise a ZodError instead of
 *      returning the envelope. That is the exact inverse of the existing
 *      ordering pin in `update-input-alignment.contract.test.ts`
 *      ("a malformed payload costs zero gate evaluations and zero store
 *      reads") — same technique, opposite direction, so the two together
 *      fix both orderings.
 *   2. Nothing is committed and no handshake is READ — spies, not
 *      inspection of the result.
 *   3. `postSuccessHook` never fires. A refusal is not a settled render;
 *      metering it would bill the refused call.
 *   4. No `_meta`. A refusal exposes no mount affordance.
 *
 * A gate that returns `undefined` must leave today's behaviour exactly
 * as it is — that arm is the control, and it passes both before and
 * after the change.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryGguiSessionStore,
  InMemoryKeyValueStore,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  EmbeddingProvider,
  UiGenerateResult,
} from '@ggui-ai/mcp-server-core';
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { createGguiRenderHandler } from './render.js';
import { handshakeRecordKey, type HandshakeRecord } from './handshake.js';
import { isHandlerFailure, type HandlerContext } from '../types.js';

const APP_ID = 'app-refusal';
const CTX: HandlerContext = { appId: APP_ID, requestId: 'req-refusal-1' };

/** Pure-display contract — no actionSpec, so no `nextStep` on success. */
const CONTRACT: DataContract = { propsSpec: { properties: {} } };
const COLD_CODE = 'export default function Cold(){ return null; }';

/** Fixed 4-dim embedding so the in-memory vector store is deterministic. */
const fakeEmbedding: EmbeddingProvider = {
  id: 'mock',
  dimensions: 4,
  embed: async () => [0, 0, 0, 0],
};

/** Pre-resolved generator escape hatch — fixed componentCode, no LLM. */
async function fakeGenerator(input: {
  request: { sessionId: string };
}): Promise<UiGenerateResult> {
  return {
    ok: true,
    response: { sessionId: input.request.sessionId, componentCode: COLD_CODE },
    metadata: {
      provider: 'anthropic',
      generator: 'fake-generator',
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      cacheHit: false,
    },
  };
}

/** Seed an `origin:'agent'` create handshake the render call consumes. */
async function seedAgentHandshake(
  store: InMemoryKeyValueStore,
  handshakeId: string,
): Promise<void> {
  const record: HandshakeRecord = {
    handshakeId,
    action: 'create',
    reason: 'test',
    input: { intent: 'a test card', blueprintDraft: { contract: CONTRACT } },
    target: {},
    suggestion: {
      origin: 'agent',
      rationale: 'test',
      blueprintMeta: { contractHash: blueprintKey(CONTRACT), variance: {} },
    },
    effectiveContract: CONTRACT,
    appId: APP_ID,
    createdAt: new Date().toISOString(),
  };
  await store.set(handshakeRecordKey(APP_ID, handshakeId), JSON.stringify(record));
}

/**
 * The refusal a deployment's gate returns. `hard_cap_exceeded` is the
 * abuse-path code the "commit nothing" invariant exists for — a
 * committed row per refused call would be a write on the refuser's
 * behalf on exactly that path.
 */
const REFUSAL = {
  code: 'hard_cap_exceeded' as const,
  message: 'the configured render cap for this app was reached',
  fix: 'the cap resets at the start of the next period; no action restores it sooner',
  retry: 'next-period' as const,
  handshake: 'intact' as const,
};

/**
 * Build a render handler over instrumented stores. `gate` is threaded
 * straight onto `preValidationGate`.
 */
function buildHarness(
  gate: NonNullable<Parameters<typeof createGguiRenderHandler>[0]>['preValidationGate'],
) {
  const handshakeStore = new InMemoryKeyValueStore();
  const renderStore = new InMemoryGguiSessionStore();
  const handshakeGet = vi.spyOn(handshakeStore, 'get');
  const commit = vi.spyOn(renderStore, 'commit');
  const postSuccessHook = vi.fn();
  const handler = createGguiRenderHandler({
    handshakeStore,
    renderStore,
    postSuccessHook,
    ...(gate ? { preValidationGate: gate } : {}),
    generation: {
      uiGenerator: {
        slug: 'ui-gen-default-fake',
        tier: 'default',
        model: 'fake',
        generate: fakeGenerator,
      },
      resolveLlm: () => null,
      blueprints: { get: async () => null, list: async () => [] },
      cache: {
        embedding: fakeEmbedding,
        vectorStore: new InMemoryVectorStore(),
        index: new InMemoryBlueprintIndex(),
      },
    },
    generator: fakeGenerator,
  });
  return {
    handler,
    handshakeStore,
    renderStore,
    handshakeGet,
    commit,
    postSuccessHook,
  };
}

describe('ggui_render — a gate that RETURNS a refusal', () => {
  it('projects the refusal to a HandlerFailure whose data is {outcome, refusal}', async () => {
    const h = buildHarness(async () => REFUSAL);
    const handshakeId = 'hs-refused-1';
    await seedAgentHandshake(h.handshakeStore, handshakeId);

    const out = await h.handler.handler({ handshakeId, props: {} }, CTX);

    expect(isHandlerFailure(out)).toBe(true);
    if (!isHandlerFailure(out)) throw new Error('expected a refusal envelope');
    expect(out.data).toEqual({ outcome: 'refused', refusal: REFUSAL });
  });

  it('refuses a SYNTACTICALLY INVALID input — proof the projection runs before the parse', async () => {
    // `{}` carries no handshakeId and no props: `z.object(inputSchema)
    // .parse` would raise a ZodError. Returning the envelope instead is
    // the only way this call can succeed, so it pins the ordering.
    const h = buildHarness(async () => REFUSAL);

    const out = await h.handler.handler({}, CTX);

    expect(isHandlerFailure(out)).toBe(true);
    if (!isHandlerFailure(out)) throw new Error('expected a refusal envelope');
    expect(out.data).toEqual({ outcome: 'refused', refusal: REFUSAL });
  });

  it('carries no identity fields — nothing was parsed, nothing committed', async () => {
    const h = buildHarness(async () => REFUSAL);

    const out = await h.handler.handler({}, CTX);

    if (!isHandlerFailure(out)) throw new Error('expected a refusal envelope');
    for (const absent of [
      'sessionId',
      'resourceUri',
      'action',
      'contractHash',
      'blueprintId',
      'variantKey',
      'cache',
      'error',
      'nextStep',
      'shortCode',
      'handshakeId',
    ]) {
      expect(absent in (out.data as object), `refused data must omit ${absent}`).toBe(
        false,
      );
    }
  });

  it('reads no handshake, commits no session, fires no postSuccessHook', async () => {
    const h = buildHarness(async () => REFUSAL);
    const handshakeId = 'hs-refused-2';
    await seedAgentHandshake(h.handshakeStore, handshakeId);
    // Seeding used `set`; only reads after this point count.
    h.handshakeGet.mockClear();

    const out = await h.handler.handler({ handshakeId, props: {} }, CTX);

    expect(isHandlerFailure(out)).toBe(true);
    expect(h.handshakeGet).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.postSuccessHook).not.toHaveBeenCalled();
    expect(await h.renderStore.get('render_1')).toBeNull();
  });

  it('leads the model-visible text with the code, then message + fix', async () => {
    const h = buildHarness(async () => REFUSAL);

    const out = await h.handler.handler({}, CTX);

    if (!isHandlerFailure(out)) throw new Error('expected a refusal envelope');
    expect(out.errorText.startsWith(`${REFUSAL.code}: `)).toBe(true);
    expect(out.errorText).toContain(REFUSAL.message);
    expect(out.errorText).toContain(REFUSAL.fix);
    // The refused arm has its OWN text builder: the §7.1 failure text
    // says "this handshakeId — it is consumed", which is FALSE here.
    expect(out.errorText).not.toContain('it is consumed');
  });

  it('exposes no _meta — resultMeta narrows the failure marker away', async () => {
    const h = buildHarness(async () => REFUSAL);

    const out = await h.handler.handler({}, CTX);

    expect(await h.handler.resultMeta?.(out, {}, CTX)).toBeUndefined();
  });

  it('accepts a SYNCHRONOUS gate — the hook returns a refusal or a promise of one', async () => {
    const h = buildHarness(() => REFUSAL);

    const out = await h.handler.handler({}, CTX);

    expect(isHandlerFailure(out)).toBe(true);
    if (!isHandlerFailure(out)) throw new Error('expected a refusal envelope');
    expect(out.data).toEqual({ outcome: 'refused', refusal: REFUSAL });
  });
});

describe('ggui_render — a gate that returns undefined (control)', () => {
  it('lets the render proceed and the success result carries outcome:rendered', async () => {
    const h = buildHarness(async () => undefined);
    const handshakeId = 'hs-allowed-1';
    await seedAgentHandshake(h.handshakeStore, handshakeId);

    const out = await h.handler.handler({ handshakeId, props: {} }, CTX);

    expect(isHandlerFailure(out)).toBe(false);
    if (isHandlerFailure(out)) {
      throw new Error(`expected success, got: ${out.errorText}`);
    }
    expect(out.outcome).toBe('rendered');
    expect(typeof out.sessionId).toBe('string');
    expect(out.sessionId.length).toBeGreaterThan(0);
    expect(h.commit).toHaveBeenCalled();
    expect(h.postSuccessHook).toHaveBeenCalled();
  });

  it('still validates the wire input — a malformed call after an allow throws', async () => {
    // The gate does not replace input validation; an allowed call with a
    // malformed payload lands on the ordinary parse error, unchanged.
    const h = buildHarness(async () => undefined);

    await expect(h.handler.handler({}, CTX)).rejects.toThrow();
  });
});

describe('ggui_render — no gate at all (control)', () => {
  it('is unchanged: OSS deployments that bind no gate render normally', async () => {
    const h = buildHarness(undefined);
    const handshakeId = 'hs-nogate-1';
    await seedAgentHandshake(h.handshakeStore, handshakeId);

    const out = await h.handler.handler({ handshakeId, props: {} }, CTX);

    expect(isHandlerFailure(out)).toBe(false);
    if (isHandlerFailure(out)) {
      throw new Error(`expected success, got: ${out.errorText}`);
    }
    expect(out.outcome).toBe('rendered');
  });
});
