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
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
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
import { renderOutputSchema } from '@ggui-ai/protocol';
import type { DataContract, GguiRenderOutput } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  createGguiRenderHandler,
  type GguiSessionPostFailureArgs,
  type GguiSessionPostSuccessArgs,
} from './render.js';
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

/**
 * Two guards on the seams #786 touched but did not pin.
 *
 * The envelope declaration is ONE line in `render.ts` and it is the only
 * thing that makes the transport enforce the presence rules: without it
 * `build-mcp.ts` falls back to `z.object(handler.outputSchema)`, a
 * REBUILT raw shape that carries no `superRefine` and so accepts a
 * refusal with committed state. The transport pins in
 * `build-mcp.test.ts` use a synthetic handler, and the suites above call
 * `handler.handler(...)` directly — so deleting the line left every
 * suite green while the wire silently lost both rules. This is the pin
 * that fails instead.
 *
 * The hook bundle's `action` is the other one. Demoting the six identity
 * fields to optional (to make room for the refused arm, where nothing is
 * committed) widened `GguiRenderOutput['action']` to include `undefined`
 * — and `GguiSessionPostSuccessArgs` read that type straight through,
 * even though the hook fires ONLY after a committed render. That is the
 * same strictness loss `CommittedIdentity` exists to undo, on a public
 * interface a deployment's hook implementation compiles against.
 */
describe('ggui_render — the seams #786 widened (drift guards)', () => {
  it('declares `outputEnvelopeSchema`, and the raw-shape fallback proves it load-bearing', () => {
    const h = buildHarness(undefined);

    // The declaration itself. Delete the line in render.ts and this fails.
    expect(h.handler.outputEnvelopeSchema).toBe(renderOutputSchema);

    // Why it matters: a refusal carrying committed state is exactly what
    // the presence rules reject — and exactly what the fallback admits.
    const leaky = {
      outcome: 'refused',
      sessionId: 'render_leak',
      refusal: {
        code: 'hard_cap_exceeded',
        message: 'the configured render cap for this app was reached',
        fix: 'the cap resets at the start of the next period',
        retry: 'next-period',
        handshake: 'intact',
      },
    };
    expect(h.handler.outputEnvelopeSchema?.safeParse(leaky).success).toBe(false);
    expect(z.object(h.handler.outputSchema).safeParse(leaky).success).toBe(true);
  });

  it('keeps `action` non-optional on the committed-arm hook bundle', () => {
    // Derived from the wire type, never re-listed: the hook fires only
    // after a commit, so its `action` is the wire field with `undefined`
    // removed.
    expectTypeOf<GguiSessionPostSuccessArgs['action']>().toEqualTypeOf<
      NonNullable<GguiRenderOutput['action']>
    >();
  });
});

// ─── #804: the failure seam ───────────────────────────────────────────────────
//
// A deployment that reserves something at `preValidationGate` (a trial
// render, a credit hold) needs the other end: `postFailureHook` fires on
// EVERY failure of a render whose gate passed — whether the handler throws
// or returns the `outcome:'failed'` envelope — and never on a refusal
// (nothing passed the gate) or a success (the reservation was consumed).

/** Build a render handler with both hooks captured; `generator` overrides the fake. */
function buildFailureHarness(opts: {
  readonly gate?: NonNullable<Parameters<typeof createGguiRenderHandler>[0]>['preValidationGate'];
  readonly generator?: NonNullable<Parameters<typeof createGguiRenderHandler>[0]>['generator'];
  readonly postSuccessHook?: NonNullable<Parameters<typeof createGguiRenderHandler>[0]>['postSuccessHook'];
  readonly postFailureHook: NonNullable<Parameters<typeof createGguiRenderHandler>[0]>['postFailureHook'];
  readonly checkRenderContracts?: NonNullable<Parameters<typeof createGguiRenderHandler>[0]>['checkRenderContracts'];
}) {
  const handshakeStore = new InMemoryKeyValueStore();
  const renderStore = new InMemoryGguiSessionStore();
  const postSuccessHook = opts.postSuccessHook ?? vi.fn();
  const handler = createGguiRenderHandler({
    handshakeStore,
    renderStore,
    postSuccessHook,
    postFailureHook: opts.postFailureHook,
    ...(opts.gate ? { preValidationGate: opts.gate } : {}),
    ...(opts.checkRenderContracts ? { checkRenderContracts: opts.checkRenderContracts } : {}),
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
    generator: opts.generator ?? fakeGenerator,
  });
  return { handler, handshakeStore, renderStore, postSuccessHook };
}

const GENERATION_ERROR = { code: 'PRODUCTION_FAILED' as const, message: 'provider 500' };

describe('ggui_render — postFailureHook (#804): every failure after the gate passed', () => {
  it('fires on the returned outcome:failed envelope with the session and the generation error', async () => {
    const postFailureHook = vi.fn();
    const h = buildFailureHarness({
      gate: async () => undefined,
      generator: async () => ({ ok: false, error: GENERATION_ERROR }),
      postFailureHook,
    });
    const handshakeId = 'hs-fail-envelope-1';
    await seedAgentHandshake(h.handshakeStore, handshakeId);
    const out = await h.handler.handler({ handshakeId, props: {} }, CTX);
    if (!isHandlerFailure(out) || out.data.outcome !== 'failed') {
      throw new Error('expected the FAILED arm of the failure envelope');
    }
    expect(postFailureHook).toHaveBeenCalledTimes(1);
    const args: GguiSessionPostFailureArgs = postFailureHook.mock.calls[0]?.[0];
    expect(args.ctx).toBe(CTX);
    expect(args.sessionId).toBe(out.data.sessionId);
    expect(args.surfacedAs).toBe('failed');
    expect(args.error).toEqual(GENERATION_ERROR);
    // Unchanged contract: the success hook observes EVERY settled render, a
    // failed envelope included (codeReady:false) — the failure hook is the
    // addition, not a replacement.
    expect(h.postSuccessHook).toHaveBeenCalledTimes(1);
  });

  it('fires on a failure the handler THROWS after the gate passed (no session minted yet)', async () => {
    const postFailureHook = vi.fn();
    const h = buildFailureHarness({ gate: async () => undefined, postFailureHook });
    // No handshake seeded: the handler throws HandshakeNotFound after the gate allowed the call.
    await expect(h.handler.handler({ handshakeId: 'hs-missing', props: {} }, CTX)).rejects.toThrow();
    expect(postFailureHook).toHaveBeenCalledTimes(1);
    const args: GguiSessionPostFailureArgs = postFailureHook.mock.calls[0]?.[0];
    expect(args.ctx).toBe(CTX);
    expect(args.sessionId).toBeUndefined();
    expect(args.surfacedAs).toBe('thrown');
    expect(args.error).toBeInstanceOf(Error);
    expect(h.postSuccessHook).not.toHaveBeenCalled();
  });

  it('does NOT fire on a refusal — nothing passed the gate', async () => {
    const postFailureHook = vi.fn();
    const h = buildFailureHarness({ gate: async () => REFUSAL, postFailureHook });
    const out = await h.handler.handler({ handshakeId: 'hs-refused-x', props: {} }, CTX);
    expect(isHandlerFailure(out) && out.data.outcome === 'refused').toBe(true);
    expect(postFailureHook).not.toHaveBeenCalled();
  });

  it('does NOT fire on success', async () => {
    const postFailureHook = vi.fn();
    const h = buildFailureHarness({ gate: async () => undefined, postFailureHook });
    const handshakeId = 'hs-ok-1';
    await seedAgentHandshake(h.handshakeStore, handshakeId);
    const out = await h.handler.handler({ handshakeId, props: {} }, CTX);
    expect(isHandlerFailure(out)).toBe(false);
    expect(postFailureHook).not.toHaveBeenCalled();
    expect(h.postSuccessHook).toHaveBeenCalledTimes(1);
  });

  it('a hook that throws masks nothing: the failed envelope is still returned, the original error still thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const throwing = vi.fn(async () => {
        throw new Error('release failed');
      });
      const envelope = buildFailureHarness({
        gate: async () => undefined,
        generator: async () => ({ ok: false, error: GENERATION_ERROR }),
        postFailureHook: throwing,
      });
      const handshakeId = 'hs-fail-envelope-2';
      await seedAgentHandshake(envelope.handshakeStore, handshakeId);
      const out = await envelope.handler.handler({ handshakeId, props: {} }, CTX);
      expect(isHandlerFailure(out) && out.data.outcome === 'failed').toBe(true);

      const thrown = buildFailureHarness({ gate: async () => undefined, postFailureHook: throwing });
      await expect(thrown.handler.handler({ handshakeId: 'hs-missing-2', props: {} }, CTX)).rejects.toThrow(
        /handshake/i,
      );
      expect(throwing).toHaveBeenCalledTimes(2);
      // The hook's own failure is reported, not silently dropped.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT fire when postSuccessHook throws after the response is assembled — the render settled', async () => {
    const postFailureHook = vi.fn();
    const h = buildFailureHarness({
      gate: async () => undefined,
      postSuccessHook: async () => {
        throw new Error('rag index write failed');
      },
      postFailureHook,
    });
    const handshakeId = 'hs-ok-2';
    await seedAgentHandshake(h.handshakeStore, handshakeId);
    // The success hook's contract is unchanged: the handler propagates its throw.
    await expect(h.handler.handler({ handshakeId, props: {} }, CTX)).rejects.toThrow('rag index write failed');
    expect(postFailureHook).not.toHaveBeenCalled();
  });

  it('fires on a failure thrown AFTER the session was minted, and carries that session', async () => {
    const postFailureHook = vi.fn();
    // The schema-compat check runs twice on a cold render: once before the
    // session is minted (inside its own rethrowing guard) and once inside
    // generation, after the mint. Throwing on the second call is a throw
    // with a session behind it.
    let calls = 0;
    const h = buildFailureHarness({
      gate: async () => undefined,
      checkRenderContracts: () => {
        calls += 1;
        if (calls >= 2) throw new Error('post-mint boom');
      },
      postFailureHook,
    });
    const handshakeId = 'hs-post-mint-throw';
    await seedAgentHandshake(h.handshakeStore, handshakeId);
    await expect(h.handler.handler({ handshakeId, props: {} }, CTX)).rejects.toThrow('post-mint boom');
    expect(postFailureHook).toHaveBeenCalledTimes(1);
    const args: GguiSessionPostFailureArgs = postFailureHook.mock.calls[0]?.[0];
    expect(args.surfacedAs).toBe('thrown');
    expect(typeof args.sessionId).toBe('string');
    expect(args.error).toBeInstanceOf(Error);
  });

  it('STILL fires when postSuccessHook throws on the FAILED envelope path — nothing was consumed there', async () => {
    // The mirror of the settled-success case: on a failed generation the
    // success hook also runs (metering observes every settled render); if
    // THAT throws, the render still failed and the seam must still fire —
    // once, with the session, carrying the throw the caller sees.
    const postFailureHook = vi.fn();
    const h = buildFailureHarness({
      gate: async () => undefined,
      generator: async () => ({ ok: false, error: GENERATION_ERROR }),
      postSuccessHook: async () => {
        throw new Error('metering write failed');
      },
      postFailureHook,
    });
    const handshakeId = 'hs-fail-then-hook-throws';
    await seedAgentHandshake(h.handshakeStore, handshakeId);
    await expect(h.handler.handler({ handshakeId, props: {} }, CTX)).rejects.toThrow('metering write failed');
    expect(postFailureHook).toHaveBeenCalledTimes(1);
    const args: GguiSessionPostFailureArgs = postFailureHook.mock.calls[0]?.[0];
    expect(args.surfacedAs).toBe('thrown');
    expect(typeof args.sessionId).toBe('string');
    expect(args.error).toBeInstanceOf(Error);
    expect((args.error as Error).message).toBe('metering write failed');
  });

  it('does NOT fire when the gate itself throws — the gate never passed', async () => {
    const postFailureHook = vi.fn();
    const h = buildFailureHarness({
      gate: async () => {
        throw new Error('gate exploded');
      },
      postFailureHook,
    });
    await expect(h.handler.handler({ handshakeId: 'hs-any', props: {} }, CTX)).rejects.toThrow('gate exploded');
    expect(postFailureHook).not.toHaveBeenCalled();
  });
});
