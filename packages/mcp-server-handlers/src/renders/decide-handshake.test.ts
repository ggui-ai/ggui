/**
 * Atomic tests for the shared handshake-decision core (`decideHandshake`)
 * and its pure projection helpers (`buildCacheReuseResult`,
 * `buildCreateFallback`).
 *
 * The orchestration spine is tested in ISOLATION: `matchBlueprint` and
 * `ensureConformingContract` are mocked so the assertions pin the pure
 * decision logic — pre-match short-circuit, pool fan-out, exact-key-wins,
 * highest-confidence-semantic-pick, and the create / no-LLM fallbacks —
 * without touching a real registry or LLM. The real find-similar wiring is
 * covered by `blueprint-matcher.test.ts` + the live `cache-reuse-probe`.
 */
import { createHash } from 'node:crypto';
import { summarizeContract, type DataContract } from '@ggui-ai/protocol';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import { variantKey } from '@ggui-ai/protocol/blueprint-key';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../types.js';
import type { Blueprint as RegistryBlueprint } from './blueprint-registry.js';
import type { InstalledBlueprintsProvider } from './installed-blueprints-provider.js';
import type { BlueprintMatchHit, BlueprintMatchResult } from './blueprint-matcher.js';
import { matchBlueprint } from './blueprint-matcher.js';
import { ensureConformingContract } from '@ggui-ai/negotiator';
import type { EnsureConformingResult } from '@ggui-ai/negotiator';
import {
  buildCacheReuseResult,
  buildCreateFallback,
  decideHandshake,
  type BlueprintPool,
  type HandshakeDecisionAdapter,
} from './decide-handshake.js';
import { DEFAULT_GENERATOR_SLUG } from './handshake.js';

vi.mock('./blueprint-matcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./blueprint-matcher.js')>();
  return { ...actual, matchBlueprint: vi.fn() };
});
vi.mock('@ggui-ai/negotiator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ggui-ai/negotiator')>();
  return { ...actual, ensureConformingContract: vi.fn() };
});

const mockMatch = vi.mocked(matchBlueprint);
const mockEnsure = vi.mocked(ensureConformingContract);

const CTX: HandlerContext = { appId: 'app-1', requestId: 'r' };

function mkBlueprint(over: Partial<RegistryBlueprint> & { id: string }): RegistryBlueprint {
  return {
    id: over.id,
    kind: over.kind ?? 'template',
    contractKey: over.contractKey ?? 'key-1',
    variantKey: over.variantKey ?? variantKey(over.variance),
    variance: over.variance ?? {},
    contract: over.contract ?? { propsSpec: { properties: {} } },
    intent: over.intent ?? 'an intent',
    componentCode: over.componentCode ?? 'export default () => null;',
    createdAt: over.createdAt ?? '2026-05-30T00:00:00.000Z',
    hitCount: over.hitCount ?? 0,
    provenance: over.provenance ?? 'synth',
  };
}

/**
 * A registry pool — backed by the REAL in-memory doubles so it typechecks
 * cleanly (no casts). matchBlueprint is mocked, so the store is never
 * actually queried; the value is just threaded through.
 */
function pool(over: Partial<BlueprintPool> = {}): BlueprintPool {
  return {
    registry: over.registry ?? {
      embedding: new MockEmbeddingProvider(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
    },
    ...(over.scope !== undefined ? { scope: over.scope } : {}),
    ...(over.label !== undefined ? { label: over.label } : {}),
    ...(over.installedBlueprints !== undefined
      ? { installedBlueprints: over.installedBlueprints }
      : {}),
  };
}

const DRAFT = { contract: { propsSpec: { properties: {} } } as DataContract };

function adapter(over: Partial<HandshakeDecisionAdapter> = {}): HandshakeDecisionAdapter {
  return {
    resolveLlm: over.resolveLlm ?? (() => ({ async call() { return ''; } })),
    ...(over.pools !== undefined ? { pools: over.pools } : {}),
    ...(over.preMatch !== undefined ? { preMatch: over.preMatch } : {}),
    ...(over.generatorSlug !== undefined ? { generatorSlug: over.generatorSlug } : {}),
    ...(over.warn !== undefined ? { warn: over.warn } : {}),
  };
}

beforeEach(() => {
  mockMatch.mockReset();
  mockEnsure.mockReset();
});

// ---------------------------------------------------------------------------
// Pure projection helpers
// ---------------------------------------------------------------------------

const BP_UUID = 'bp_11111111-1111-1111-1111-111111111111';

describe('buildCacheReuseResult', () => {
  it('projects a matched blueprint into an ATOMIC origin:cache reuse', () => {
    const cachedContract: DataContract = {
      contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
    };
    const code = 'export default () => null;';
    const result = buildCacheReuseResult(
      {
        id: BP_UUID,
        contractKey: 'abc',
        variantKey: 'v-abc',
        componentCode: code,
        contract: cachedContract,
      },
      'match-semantic: judge matched (confidence=0.90)',
    );
    expect(result.action).toBe('reuse');
    // Atomic: served contract is the CACHED blueprint's own contract.
    expect(result.effectiveContract).toBe(cachedContract);
    expect(result.suggestion.origin).toBe('cache');
    // blueprintId is set ONLY on cache reuse — the stored durable UUID.
    expect(result.suggestion.blueprintMeta.blueprintId).toBe(BP_UUID);
    expect(result.suggestion.blueprintMeta.contractHash).toBe('abc');
    expect(result.suggestion.blueprintMeta.codeHash).toBe(
      createHash('sha256').update(code).digest('hex'),
    );
    expect(result.suggestion.blueprintMeta.generator).toBe(DEFAULT_GENERATOR_SLUG);
    expect(result.reason).toMatch(/match-semantic/);
    // proposedContractSummary equals summarizeContract(cachedContract) —
    // the same lossy summary the matcher's judge feeds (one source of truth).
    expect(result.suggestion.proposedContractSummary).toBe(
      summarizeContract(cachedContract),
    );
    // Matched-ref threaded for the paired render's §6 point-read.
    expect(result.matchedBlueprint).toEqual({
      id: BP_UUID,
      contractKey: 'abc',
      variantKey: 'v-abc',
    });
  });

  it('honors a custom generator slug', () => {
    const r = buildCacheReuseResult(
      { id: 'x', contractKey: 'x', variantKey: 'vx', componentCode: 'a', contract: {} },
      'r',
      'ui-gen-advanced-opus',
    );
    expect(r.suggestion.blueprintMeta.generator).toBe('ui-gen-advanced-opus');
  });

  it('is deterministic — same blueprint + reason → identical result', () => {
    const bp = {
      id: 'x',
      contractKey: 'x',
      variantKey: 'vx',
      componentCode: 'a',
      contract: {} as DataContract,
    };
    expect(buildCacheReuseResult(bp, 'r')).toEqual(buildCacheReuseResult(bp, 'r'));
  });
});

describe('buildCreateFallback', () => {
  it('keeps a CLEAN draft verbatim with origin:agent and no findings', () => {
    const clean: DataContract = { propsSpec: { properties: {} } };
    const r = buildCreateFallback(clean, 'no-creds: ...');
    expect(r.action).toBe('create');
    expect(r.suggestion.origin).toBe('agent');
    expect(r.effectiveContract).toEqual(clean);
    expect(r.suggestion.validationFindings).toBeUndefined();
    expect(r.suggestion.blueprintMeta.generator).toBe(DEFAULT_GENERATOR_SLUG);
    // No throwaway provisional id — blueprintId is minted ONLY at
    // render-time registration (absent on origin:agent).
    expect(r.suggestion.blueprintMeta.blueprintId).toBeUndefined();
    // proposedContractSummary projects the clean draft.
    expect(r.suggestion.proposedContractSummary).toBe(summarizeContract(clean));
    // No matched-ref on a create decision.
    expect(r.matchedBlueprint).toBeUndefined();
  });

  it('substitutes the empty contract + loud findings for a MALFORMED draft', () => {
    const malformed = { propsSpec: 'not-an-object' };
    const r = buildCreateFallback(malformed, 'no-creds: ...');
    expect(r.action).toBe('create');
    expect(r.effectiveContract).toEqual({});
    expect(r.suggestion.validationFindings?.length ?? 0).toBeGreaterThan(0);
    expect(r.suggestion.validationFindings?.[0]?.severity).toBe('error');
    expect(r.suggestion.blueprintMeta.blueprintId).toBeUndefined();
    // Summary of the substituted empty contract.
    expect(r.suggestion.proposedContractSummary).toBe(summarizeContract({}));
  });

  it('honors a custom generator slug', () => {
    const r = buildCreateFallback({ propsSpec: { properties: {} } }, 'r', 'slug-z');
    expect(r.suggestion.blueprintMeta.generator).toBe('slug-z');
  });
});

// ---------------------------------------------------------------------------
// decideHandshake orchestration
// ---------------------------------------------------------------------------

const EMPTY_GAP = {
  actions: [],
  props: [],
  context: [],
  streams: [],
  gadgets: [],
} as const;

function hit(strategy: 'exact-key' | 'semantic', over: {
  id?: string;
  reason?: string;
  judgeConfidence?: number;
  coverage?: BlueprintMatchHit['coverage'];
} = {}): BlueprintMatchResult {
  return {
    strategy,
    blueprint: mkBlueprint({ id: over.id ?? `bp-${strategy}`, contractKey: over.id ?? strategy }),
    cosine: strategy === 'exact-key' ? 1 : 0.8,
    reason: over.reason ?? `${strategy} match`,
    coverage: over.coverage ?? EMPTY_GAP,
    ...(strategy === 'semantic' && over.judgeConfidence !== undefined
      ? { judgeConfidence: over.judgeConfidence }
      : {}),
  };
}

const miss: BlueprintMatchResult = { strategy: 'no-match', reason: 'no candidates', candidates: [] };

describe('decideHandshake — pre-match', () => {
  it('short-circuits on a pre-match hit (find-similar never runs)', async () => {
    const preResult = buildCacheReuseResult(
      { id: 'curated-1', contractKey: 'c1', variantKey: 'cv1', componentCode: 'x', contract: {} },
      'curated',
    );
    const preMatch = vi.fn(async () => preResult);
    const r = await decideHandshake(
      adapter({ preMatch, pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r).toBe(preResult);
    expect(preMatch).toHaveBeenCalledOnce();
    expect(mockMatch).not.toHaveBeenCalled();
  });

  it('falls through when pre-match returns undefined', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {},
      origin: 'agent',
      method: 'verbatim',
      findings: [],
      reasoning: 'clean',
    } satisfies EnsureConformingResult);
    const preMatch = vi.fn(async () => undefined);
    const r = await decideHandshake(
      adapter({ preMatch, pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(preMatch).toHaveBeenCalledOnce();
    expect(mockMatch).toHaveBeenCalledOnce();
    expect(r.action).toBe('create');
  });

  it('fails open on an operational pre-match error (warns, runs find-similar)', async () => {
    mockMatch.mockResolvedValue(hit('exact-key', { id: 'bp-ek' }));
    const warn = vi.fn();
    const preMatch = vi.fn(async () => {
      throw new Error('curated backend flap');
    });
    const r = await decideHandshake(
      adapter({ preMatch, pools: [pool()], warn }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-ek');
  });
});

describe('decideHandshake — find-similar across pools', () => {
  it('reuses on an exact-key hit and does NOT query later pools', async () => {
    mockMatch.mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: 'app' }), pool({ scope: 'shared' })] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-ek');
    expect(mockMatch).toHaveBeenCalledOnce(); // pool 2 never reached
  });

  it('an exact-key in a LATER pool beats a semantic in an earlier pool', async () => {
    mockMatch
      .mockResolvedValueOnce(hit('semantic', { id: 'bp-sem', judgeConfidence: 0.95 }))
      .mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: 'app' }), pool({ scope: 'shared' })] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-ek');
    expect(mockMatch).toHaveBeenCalledTimes(2);
  });

  it('reuses the HIGHEST-confidence semantic hit across pools', async () => {
    mockMatch
      .mockResolvedValueOnce(hit('semantic', { id: 'bp-lo', judgeConfidence: 0.65 }))
      .mockResolvedValueOnce(hit('semantic', { id: 'bp-hi', judgeConfidence: 0.92 }));
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: 'app' }), pool({ scope: 'shared' })] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-hi');
    expect(mockMatch).toHaveBeenCalledTimes(2);
  });

  it('defaults a pool with no scope to ctx.appId, and uses pool.scope otherwise', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    await decideHandshake(
      adapter({ pools: [pool(), pool({ scope: 'shared' })] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(mockMatch.mock.calls[0]?.[1]).toBe('app-1'); // default → ctx.appId
    expect(mockMatch.mock.calls[1]?.[1]).toBe('shared');
  });

  it('threads the request variance from blueprintDraft.variance into the match query', async () => {
    mockMatch.mockResolvedValue(hit('exact-key', { id: 'bp-ek' }));
    const variance = { persona: 'minimalist' } as const;
    await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: { ...DRAFT, variance },
      ctx: CTX,
    });
    // The query (3rd matchBlueprint arg) carries the request variance so the
    // now-variance-aware matcher keys the exact-key lookup on it.
    expect(mockMatch.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ variance }),
    );
  });

  it('omits variance from the match query when blueprintDraft carries none', async () => {
    // DRAFT has no variance field, so the conditional spread must NOT set a
    // `variance` key — this pins the exactOptionalPropertyTypes-safe spread
    // against a future naive `variance: variance` that would leak an
    // undefined key when variance is absent.
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {},
      origin: 'agent',
      method: 'verbatim',
      findings: [],
      reasoning: 'clean',
    });
    await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(mockMatch.mock.calls[0]?.[2]).not.toHaveProperty('variance');
  });

  it('threads the resolved llm + per-pool installedBlueprints into matchDeps', async () => {
    mockMatch.mockResolvedValue(hit('exact-key'));
    const bridge: InstalledBlueprintsProvider = {
      ensureCached: vi.fn(async () => {}),
      invalidate: vi.fn(),
      deps: {
        embedding: new MockEmbeddingProvider(),
        vectorStore: new InMemoryVectorStore(),
        index: new InMemoryBlueprintIndex(),
      },
    };
    const llm = { async call() { return ''; } };
    await decideHandshake(
      adapter({ resolveLlm: () => llm, pools: [pool({ installedBlueprints: bridge })] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    const matchDeps = mockMatch.mock.calls[0]?.[0];
    expect(matchDeps?.llm).toBe(llm);
    expect(matchDeps?.installedBlueprints).toBe(bridge);
  });

  it('fails open on an operational pool error — warns and tries the next pool', async () => {
    mockMatch
      .mockRejectedValueOnce(new Error('registry hiccup'))
      .mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const warn = vi.fn();
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: 'app' }), pool({ scope: 'shared' })], warn }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-ek');
  });

  it('re-throws a programmer error from a pool (TypeError)', async () => {
    mockMatch.mockRejectedValue(new TypeError('bug'));
    await expect(
      decideHandshake(adapter({ pools: [pool()] }), {
        intent: 'i', blueprintDraft: DRAFT, ctx: CTX,
      }),
    ).rejects.toThrow(/bug/);
  });
});

describe('decideHandshake — coverage tiebreak + COVERAGE_GAP findings (P2-16)', () => {
  const GAP = {
    actions: ['decrement'],
    props: [],
    context: [],
    streams: [],
    gadgets: [],
  } as const;

  it('prefers a FULLY-COVERING hit over a gapped one even at lower confidence', async () => {
    // bp-gap has higher confidence but a coverage gap; bp-full covers
    // fully. Coverage wins the tiebreak before confidence.
    mockMatch
      .mockResolvedValueOnce(
        hit('semantic', { id: 'bp-gap', judgeConfidence: 0.95, coverage: GAP }),
      )
      .mockResolvedValueOnce(hit('semantic', { id: 'bp-full', judgeConfidence: 0.7 }));
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: 'app' }), pool({ scope: 'shared' })] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-full');
    // The winning fully-covering reuse carries NO coverage-gap findings.
    expect(
      r.suggestion.validationFindings?.some((f) => f.code === 'COVERAGE_GAP'),
    ).toBeFalsy();
  });

  it('a gapped reuse carries COVERAGE_GAP warn findings, one per missing surface', async () => {
    mockMatch.mockResolvedValueOnce(
      hit('semantic', { id: 'bp-gap', judgeConfidence: 0.9, coverage: GAP }),
    );
    const r = await decideHandshake(
      adapter({ pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-gap');
    const gapFindings =
      r.suggestion.validationFindings?.filter((f) => f.code === 'COVERAGE_GAP') ??
      [];
    expect(gapFindings).toHaveLength(1);
    expect(gapFindings[0]?.severity).toBe('warn');
    expect(gapFindings[0]?.path).toBe('actionSpec.decrement');
    expect(gapFindings[0]?.message).toMatch(/decrement/);
  });

  it('the COVERAGE_GAP message steers default-accept / override-if and names the surface', async () => {
    mockMatch.mockResolvedValueOnce(
      hit('semantic', { id: 'bp-gap', judgeConfidence: 0.9, coverage: GAP }),
    );
    const r = await decideHandshake(
      adapter({ pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    const msg =
      r.suggestion.validationFindings?.find((f) => f.code === 'COVERAGE_GAP')
        ?.message ?? '';
    // Default-accept steer: reuse is the priority, override is conditional.
    expect(msg).toMatch(/default.*accept/i);
    expect(msg).toMatch(/override.*if/i);
    // Names the missing surface.
    expect(msg).toMatch(/decrement/);
  });

  it('a PROP gap annotates required-vs-optional from the draft', async () => {
    const PROP_GAP = {
      actions: [],
      props: ['city', 'units', 'detail'],
      context: [],
      streams: [],
      gadgets: [],
    } as const;
    // Draft declares `city` required, `units` optional-via-absence, and
    // `detail` EXPLICITLY required:false — the missing-prop findings must
    // reflect each prop's required status from the draft. The explicit
    // `false` case locks the `=== true` (not truthy) comparison.
    const draftWithProps = {
      contract: {
        propsSpec: {
          properties: {
            city: { schema: { type: 'string' }, required: true },
            units: { schema: { type: 'string' } },
            detail: { schema: { type: 'string' }, required: false },
          },
        },
      } as DataContract,
    };
    mockMatch.mockResolvedValueOnce(
      hit('semantic', { id: 'bp-gap', judgeConfidence: 0.9, coverage: PROP_GAP }),
    );
    const r = await decideHandshake(
      adapter({ pools: [pool()] }),
      { intent: 'i', blueprintDraft: draftWithProps, ctx: CTX },
    );
    const findings =
      r.suggestion.validationFindings?.filter((f) => f.code === 'COVERAGE_GAP') ??
      [];
    const city = findings.find((f) => f.path === 'propsSpec.properties.city');
    const units = findings.find((f) => f.path === 'propsSpec.properties.units');
    const detail = findings.find((f) => f.path === 'propsSpec.properties.detail');
    expect(city?.message).toMatch(/required/i);
    expect(units?.message).toMatch(/optional/i);
    // Explicit required:false must read as optional (NOT required) — pins
    // the `=== true` comparison; a future `if (required)` truthy check
    // would not regress here, but it WOULD on `units` (undefined) above.
    expect(detail?.message).toMatch(/optional/i);
    expect(detail?.message).not.toMatch(/required/i);
  });

  it('breaks a coverage tie on judgeConfidence (both gapped → higher wins)', async () => {
    mockMatch
      .mockResolvedValueOnce(
        hit('semantic', { id: 'bp-lo', judgeConfidence: 0.7, coverage: GAP }),
      )
      .mockResolvedValueOnce(
        hit('semantic', { id: 'bp-hi', judgeConfidence: 0.9, coverage: GAP }),
      );
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: 'app' }), pool({ scope: 'shared' })] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-hi');
  });
});

describe('decideHandshake — create / fallback', () => {
  it('runs ensureConformingContract create path when no pool matches', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: { propsSpec: { properties: {} } },
      origin: 'synth',
      method: 'llm-repair',
      findings: [{ code: 'X', severity: 'error', path: 'p', message: 'm' }],
      reasoning: 'repaired',
    });
    const r = await decideHandshake(
      adapter({ pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('create');
    expect(r.suggestion.origin).toBe('synth');
    expect(r.suggestion.validationFindings?.length).toBe(1);
    expect(mockEnsure).toHaveBeenCalledOnce();
    // No throwaway provisional id on the synth-create path (D4) and no
    // matched-ref; proposedContractSummary projects the conforming contract.
    expect(r.suggestion.blueprintMeta.blueprintId).toBeUndefined();
    expect(r.matchedBlueprint).toBeUndefined();
    expect(r.suggestion.proposedContractSummary).toBe(
      summarizeContract({ propsSpec: { properties: {} } }),
    );
  });

  it('returns a no-creds create fallback when no LLM resolves', async () => {
    mockMatch.mockResolvedValue(miss);
    const r = await decideHandshake(
      adapter({ resolveLlm: () => undefined, pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('create');
    expect(r.reason).toMatch(/no-creds/);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('skips the probe entirely when no pools are declared', async () => {
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    const r = await decideHandshake(
      adapter({ pools: [] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(mockMatch).not.toHaveBeenCalled();
    expect(r.action).toBe('create');
  });

  it('degrades to buildCreateFallback on an operational synth error', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockRejectedValue(new Error('provider 503'));
    const r = await decideHandshake(
      adapter({ pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('create');
    expect(r.reason).toMatch(/negotiator-degraded/);
  });

  it('stamps the adapter generator slug on the create suggestion', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    const r = await decideHandshake(
      adapter({ pools: [pool()], generatorSlug: 'ui-gen-advanced-opus' }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.suggestion.blueprintMeta.generator).toBe('ui-gen-advanced-opus');
  });
});
