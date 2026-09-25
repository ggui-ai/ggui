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
import {
  MATCHED_INTENT_MAX_CHARS,
  dataContractSchema,
  handshakeSuggestionSchema,
  summarizeContract,
  type DataContract,
} from '@ggui-ai/protocol';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../types.js';
import type { Blueprint as RegistryBlueprint } from './blueprint-registry.js';
import { composeExactKey } from './blueprint-registry.js';
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
import type { HandshakeNegotiatorResult } from './handshake.js';

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
    source: over.source ?? { kind: 'user' },
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
    ...(over.resolveRerank !== undefined ? { resolveRerank: over.resolveRerank } : {}),
    ...(over.pools !== undefined ? { pools: over.pools } : {}),
    ...(over.preMatch !== undefined ? { preMatch: over.preMatch } : {}),
    ...(over.warn !== undefined ? { warn: over.warn } : {}),
    ...(over.toolIdentityCatalog !== undefined
      ? { toolIdentityCatalog: over.toolIdentityCatalog }
      : {}),
    ...(over.onBlueprintMatch !== undefined
      ? { onBlueprintMatch: over.onBlueprintMatch }
      : {}),
    ...(over.reuseMode !== undefined ? { reuseMode: over.reuseMode } : {}),
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
    const source = {
      kind: 'llm',
      generator: 'ui-gen-default',
      model: 'anthropic/claude-haiku-4-5',
    } as const;
    const result = buildCacheReuseResult(
      {
        id: BP_UUID,
        contractKey: 'abc',
        variantKey: 'v-abc',
        componentCode: code,
        contract: cachedContract,
        variance: {},
        source,
      },
      'match-semantic: judge matched (confidence=0.90)',
      0.87,
    'match-exact',
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
    // Provenance is the MATCHED row's own stored source — never a
    // deployment-level slug.
    expect(result.suggestion.blueprintMeta.source).toEqual(source);
    expect(result.reason).toMatch(/match-semantic/);
    // proposedContractSummary equals summarizeContract(cachedContract) —
    // the same lossy summary the matcher's judge feeds (one source of truth).
    expect(result.suggestion.proposedContractSummary).toBe(
      summarizeContract(cachedContract),
    );
    // Matched-ref threaded for the paired render's §6 point-read.
    if (result.action === 'declined') throw new Error('expected a decision, got declined');
    expect(result.matchedBlueprint).toEqual({
      id: BP_UUID,
      contractKey: 'abc',
      variantKey: 'v-abc',
      // #564: the matcher's measured cosine rides the ref so the paired
      // render reports the real similarity on the wire.
      cosine: 0.87,
    });
  });

  it("stamps a user-sourced row's provenance verbatim (no engine fabrication)", () => {
    const r = buildCacheReuseResult(
      {
        id: 'x',
        contractKey: 'x',
        variantKey: 'vx',
        componentCode: 'a',
        contract: {},
        variance: {},
        source: { kind: 'user' },
      },
      'r',
      1,
    'match-exact',
    );
    expect(r.suggestion.blueprintMeta.source).toEqual({ kind: 'user' });
  });

  it("projects the matched blueprint's variance onto blueprintMeta.variance (NOT {})", () => {
    const variance = { persona: 'minimalist', aesthetic: 'monochrome' } as const;
    const r = buildCacheReuseResult(
      {
        id: BP_UUID,
        contractKey: 'abc',
        variantKey: 'v-abc',
        componentCode: 'x',
        contract: {},
        variance,
        source: { kind: 'user' },
      },
      'match-semantic',
      0.9,
      'match-semantic',
    );
    expect(r.suggestion.blueprintMeta.variance).toEqual(variance);
  });

  it('is deterministic — same blueprint + reason → identical result', () => {
    const bp = {
      id: 'x',
      contractKey: 'x',
      variantKey: 'vx',
      componentCode: 'a',
      contract: {} as DataContract,
      variance: {},
      source: { kind: 'user' } as const,
    };
    expect(buildCacheReuseResult(bp, 'r', 0.5, 'match-exact')).toEqual(buildCacheReuseResult(bp, 'r', 0.5, 'match-exact'));
  });
});

describe('buildCreateFallback', () => {
  it('keeps a CLEAN draft verbatim with origin:agent and no findings', () => {
    const clean: DataContract = { propsSpec: { properties: {} } };
    const r = buildCreateFallback(clean, 'no-creds: ...', 'no-creds');
    expect(r.action).toBe('create');
    expect(r.suggestion.origin).toBe('agent');
    expect(r.effectiveContract).toEqual(clean);
    expect(r.suggestion.validationFindings).toBeUndefined();
    // No source on create — provenance is minted at render-time
    // registration, never at handshake (gen pending).
    expect(r.suggestion.blueprintMeta.source).toBeUndefined();
    // No throwaway provisional id — blueprintId is minted ONLY at
    // render-time registration (absent on origin:agent).
    expect(r.suggestion.blueprintMeta.blueprintId).toBeUndefined();
    // proposedContractSummary projects the clean draft.
    expect(r.suggestion.proposedContractSummary).toBe(summarizeContract(clean));
    // No matched-ref on a create decision.
    if (r.action === 'declined') throw new Error('expected a decision, got declined');
    expect(r.matchedBlueprint).toBeUndefined();
  });

  // ggui#523 item 3 — the empty contract is no longer a thing the server
  // proposes. A dirty draft is reduced to its conforming SUBSET (origin
  // synth, one finding per dropped entry, summary marked PARTIAL), or
  // DECLINED when nothing survives.
  it('proposes the conforming SUBSET of a partly-malformed draft — never `{}`', () => {
    const partly = {
      propsSpec: { properties: { title: { required: true, schema: { type: 'string' } } } },
      actionSpec: {
        ok: { label: 'Ok', schema: { type: 'object' } },
        bad: { type: 'object' }, // flat schema, no wrapper — refused
      },
    };
    const r = buildCreateFallback(partly, 'no-creds: ...', 'no-creds');
    // ggui#1343: the salvaged-subset arm carries the fallback kind too.
    expect('reasonKind' in r ? r.reasonKind : undefined).toBe('no-creds');
    if (r.action === 'declined') throw new Error('expected a salvaged create, got declined');
    expect(r.action).toBe('create');
    expect(r.suggestion.origin).toBe('synth');
    expect(r.effectiveContract).not.toEqual({});
    expect(Object.keys(r.effectiveContract.actionSpec ?? {})).toEqual(['ok']);
    expect(Object.keys(r.effectiveContract.propsSpec?.properties ?? {})).toEqual(['title']);
    const findings = r.suggestion.validationFindings ?? [];
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === 'error')).toBe(true);
    expect(findings.some((f) => f.path.startsWith('actionSpec.bad'))).toBe(true);
    expect(r.suggestion.proposedContractSummary).toMatch(/^PARTIAL/);
    expect(r.suggestion.proposedContractSummary).toContain('actionSpec.bad');
    expect(r.suggestion.blueprintMeta.blueprintId).toBeUndefined();
  });

  it('DECLINES a draft with nothing salvageable — no contract, no `{}`, findings loud', () => {
    const malformed = { propsSpec: 'not-an-object' };
    const r = buildCreateFallback(malformed, 'no-creds: ...', 'no-creds');
    expect(r.action).toBe('declined');
    expect(r.effectiveContract).toBeNull();
    expect(r.suggestion.origin).toBe('agent');
    expect(r.suggestion.validationFindings?.length ?? 0).toBeGreaterThan(0);
    expect(r.suggestion.validationFindings?.[0]?.severity).toBe('error');
    expect(r.suggestion.proposedContractSummary).toMatch(/^DECLINED/);
    expect(r.suggestion.proposedContractSummary).toContain('propsSpec');
    expect(r.suggestion.blueprintMeta.blueprintId).toBeUndefined();
    // The one thing this posture forbids:
    expect(r.suggestion.proposedContractSummary).not.toBe(summarizeContract({}));
  });

  it('defaults blueprintMeta.variance to {} when no requestVariance is threaded', () => {
    const r = buildCreateFallback({ propsSpec: { properties: {} } }, 'r', 'no-creds');
    expect(r.suggestion.blueprintMeta.variance).toEqual({});
  });

  it('projects the threaded request variance onto blueprintMeta.variance (NOT {})', () => {
    const requestVariance = { persona: 'power-user' } as const;
    const r = buildCreateFallback(
      { propsSpec: { properties: {} } },
      'r',
      'no-creds',
      requestVariance,
    );
    expect(r.suggestion.blueprintMeta.variance).toEqual(requestVariance);
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
  intent?: string;
} = {}): BlueprintMatchResult {
  return {
    strategy,
    blueprint: mkBlueprint({
      id: over.id ?? `bp-${strategy}`,
      contractKey: over.id ?? strategy,
      ...(over.intent !== undefined ? { intent: over.intent } : {}),
    }),
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
      {
        id: 'curated-1',
        contractKey: 'c1',
        variantKey: 'cv1',
        componentCode: 'x',
        contract: {},
        variance: {},
        source: { kind: 'curated' },
      },
      'curated',
      1,
    'match-exact',
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

describe('decideHandshake — forceCreate (ggui#1335)', () => {
  // A pre-match AND a pool that would both reuse: the only thing that can
  // keep the decision off the cache is forceCreate itself.
  const curated = () =>
    buildCacheReuseResult(
      {
        id: 'curated-1',
        contractKey: 'c1',
        variantKey: 'cv1',
        componentCode: 'x',
        contract: {},
        variance: {},
        source: { kind: 'curated' },
      },
      'curated',
      1,
    'match-exact',
    );
  const clean: EnsureConformingResult = {
    contract: {},
    origin: 'agent',
    method: 'verbatim',
    findings: [],
    reasoning: 'clean',
  };

  it('never proposes the cache: skips the pre-match, every pool probe and the reuse-policy read', async () => {
    mockMatch.mockResolvedValue(hit('exact-key', { id: 'bp-ek' }));
    mockEnsure.mockResolvedValue(clean);
    const preMatch = vi.fn(async () => curated());
    const reuseMode = vi.fn(() => 'full' as const);
    const r = await decideHandshake(
      adapter({ preMatch, reuseMode, pools: [pool(), pool({ scope: 'shared' })] }),
      { intent: 'i', blueprintDraft: DRAFT, forceCreate: true, ctx: CTX },
    );
    expect(r.action).toBe('create');
    expect(r.suggestion.origin).not.toBe('cache');
    expect(preMatch).not.toHaveBeenCalled();
    expect(mockMatch).not.toHaveBeenCalled();
    expect(reuseMode).not.toHaveBeenCalled();
    expect(mockEnsure).toHaveBeenCalledOnce();
  });

  it('control: the same adapter WITHOUT forceCreate reuses', async () => {
    mockMatch.mockResolvedValue(hit('exact-key', { id: 'bp-ek' }));
    const preMatch = vi.fn(async () => undefined);
    const r = await decideHandshake(
      adapter({ preMatch, pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, forceCreate: false, ctx: CTX },
    );
    expect(r.action).toBe('reuse');
    expect(r.suggestion.origin).toBe('cache');
    expect(preMatch).toHaveBeenCalledOnce();
    expect(mockMatch).toHaveBeenCalledOnce();
  });
});

// #1336 — the agent sees the card a JUDGED hit proposes, but never a card
// from a pool shared across apps (one app's stored intent never reaches
// another app's agent) and never on an exact-key hit (no judge ran).
describe('decideHandshake — blueprintMeta.matchedIntent (#1336)', () => {
  it("carries the stored intent on a semantic hit from the app's own pool", async () => {
    mockMatch.mockResolvedValueOnce(
      hit('semantic', { id: 'bp-sem', judgeConfidence: 0.9, intent: 'Weekly haircut availability grid' }),
    );
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.matchedIntent).toBe('Weekly haircut availability grid');
  });

  it('treats a pool whose scope IS the requesting app as its own pool', async () => {
    mockMatch.mockResolvedValueOnce(hit('semantic', { id: 'bp-sem', judgeConfidence: 0.9, intent: 'own card' }));
    const r = await decideHandshake(adapter({ pools: [pool({ scope: CTX.appId })] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(r.suggestion.blueprintMeta.matchedIntent).toBe('own card');
  });

  it('omits it on a semantic hit from a pool shared across apps', async () => {
    mockMatch
      .mockResolvedValueOnce(miss)
      .mockResolvedValueOnce(hit('semantic', { id: 'bp-shared', judgeConfidence: 0.9, intent: 'another app’s card' }));
    const r = await decideHandshake(adapter({ pools: [pool(), pool({ scope: 'shared' })] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-shared');
    expect(r.suggestion.blueprintMeta).not.toHaveProperty('matchedIntent');
  });

  it('omits it on an exact-key hit (no judge ran)', async () => {
    mockMatch.mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek', intent: 'exact card' }));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-ek');
    expect(r.suggestion.blueprintMeta).not.toHaveProperty('matchedIntent');
  });

  it('cuts a long stored intent the way the judge cuts a candidate — 279 characters and "…" — and passes a 280-character intent verbatim', async () => {
    const long = 'x'.repeat(MATCHED_INTENT_MAX_CHARS + 50);
    mockMatch.mockResolvedValueOnce(hit('semantic', { id: 'bp-long', judgeConfidence: 0.9, intent: long }));
    const cut = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    const got = cut.suggestion.blueprintMeta.matchedIntent ?? '';
    expect(got).toHaveLength(MATCHED_INTENT_MAX_CHARS);
    expect(got.endsWith('…')).toBe(true);
    expect(got.slice(0, -1)).toBe(long.slice(0, MATCHED_INTENT_MAX_CHARS - 1));
    expect(handshakeSuggestionSchema.safeParse(cut.suggestion).success).toBe(true);

    const exact = 'y'.repeat(MATCHED_INTENT_MAX_CHARS);
    mockMatch.mockResolvedValueOnce(hit('semantic', { id: 'bp-exact', judgeConfidence: 0.9, intent: exact }));
    const kept = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(kept.suggestion.blueprintMeta.matchedIntent).toBe(exact);
  });

  it('emits the OWN pool card when it wins over a shared-pool hit, and nothing when the shared card wins', async () => {
    // Own 0.92 beats shared 0.65 → the own card is proposed, with its intent.
    mockMatch
      .mockResolvedValueOnce(hit('semantic', { id: 'bp-own', judgeConfidence: 0.92, intent: 'own card' }))
      .mockResolvedValueOnce(hit('semantic', { id: 'bp-shared', judgeConfidence: 0.65, intent: 'shared card' }));
    const won = await decideHandshake(adapter({ pools: [pool(), pool({ scope: 'shared' })] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(won.suggestion.blueprintMeta.blueprintId).toBe('bp-own');
    expect(won.suggestion.blueprintMeta.matchedIntent).toBe('own card');

    // Own 0.65 loses to shared 0.92 → the shared card is proposed and carries
    // NO intent, even though the own pool DID contribute a judged hit: the
    // member follows the card that won, never the pool that participated.
    mockMatch
      .mockResolvedValueOnce(hit('semantic', { id: 'bp-own', judgeConfidence: 0.65, intent: 'own card' }))
      .mockResolvedValueOnce(hit('semantic', { id: 'bp-shared', judgeConfidence: 0.92, intent: 'shared card' }));
    const lost = await decideHandshake(adapter({ pools: [pool(), pool({ scope: 'shared' })] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(lost.suggestion.blueprintMeta.blueprintId).toBe('bp-shared');
    expect(lost.suggestion.blueprintMeta).not.toHaveProperty('matchedIntent');
  });

  it('keeps it when gap findings are appended to the reuse (the merge spreads the suggestion that carries it)', async () => {
    mockMatch.mockResolvedValueOnce({
      strategy: 'semantic',
      blueprint: mkBlueprint({ id: 'bp-gapped', intent: 'gapped card', variance: { persona: 'minimalist' } }),
      cosine: 0.8,
      reason: 'semantic match',
      coverage: EMPTY_GAP,
      judgeConfidence: 0.9,
    });
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: { ...DRAFT, variance: { persona: 'power-user' } },
      ctx: CTX,
    });
    expect(r.suggestion.validationFindings?.some((f) => f.code === 'VARIANCE_GAP')).toBe(true);
    expect(r.suggestion.blueprintMeta.matchedIntent).toBe('gapped card');
  });

  it('omits it when the stored intent is blank', async () => {
    mockMatch.mockResolvedValueOnce(hit('semantic', { id: 'bp-blank', judgeConfidence: 0.9, intent: '   ' }));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-blank');
    expect(r.suggestion.blueprintMeta).not.toHaveProperty('matchedIntent');
  });

  it('omits it on a pre-match hit and on a create (agent) suggestion', async () => {
    const preResult = buildCacheReuseResult(
      mkBlueprint({ id: 'curated-1', intent: 'curated card' }),
      'curated',
      1,
      'match-exact',
    );
    const pre = await decideHandshake(
      adapter({ preMatch: vi.fn(async () => preResult), pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(pre.suggestion.origin).toBe('cache');
    expect(pre.suggestion.blueprintMeta).not.toHaveProperty('matchedIntent');

    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    const created = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(created.suggestion.origin).toBe('agent');
    expect(created.suggestion.blueprintMeta).not.toHaveProperty('matchedIntent');
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

  it("adapter.reuseMode 'exact-only' threads disableSemantic into EVERY pool probe (ggui#607)", async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    await decideHandshake(
      adapter({
        pools: [pool({ label: 'app' }), pool({ scope: 'shared' })],
        reuseMode: async () => 'exact-only' as const,
      }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(mockMatch.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ disableSemantic: true }),
    );
    expect(mockMatch.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({ disableSemantic: true }),
    );
  });

  it('absent reuseMode threads NO disableSemantic (full reuse is the default)', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i', blueprintDraft: DRAFT, ctx: CTX,
    });
    const opts = mockMatch.mock.calls[0]?.[3];
    expect(opts === undefined || opts.disableSemantic === undefined).toBe(true);
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

  // ggui#1235 — the judge as a PAIR travels from the adapter to the matcher
  // untouched; absent, the matcher keeps its own default (the LLM at 0.5).
  it('passes the adapter\'s resolveRerank pair to matchBlueprint as `rerank`, and nothing when the adapter has none', async () => {
    const llm = { async call() { return ''; } };
    const pair = { judge: async () => ({ matchId: null, confidence: 0, latencyMs: 0, tokenCost: { input: 0, output: 0 } }), threshold: 0 };
    mockMatch.mockResolvedValue(hit('exact-key', { id: 'bp-ek' }));
    await decideHandshake(
      adapter({ resolveLlm: () => llm, resolveRerank: () => pair, pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(mockMatch.mock.calls[0]?.[0]?.rerank).toBe(pair);
    mockMatch.mockClear();
    mockMatch.mockResolvedValue(hit('exact-key', { id: 'bp-ek' }));
    await decideHandshake(
      adapter({ resolveLlm: () => llm, pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(mockMatch.mock.calls[0]?.[0]).not.toHaveProperty('rerank');
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

  it("a cache reuse result carries the MATCHED blueprint's variance (round-trip), not the request variance", async () => {
    // The matched blueprint carries its OWN variance; the reuse result must
    // project THAT (the cached UI's variance), not the request's.
    const matchedVariance = { persona: 'minimalist', aesthetic: 'monochrome' };
    mockMatch.mockResolvedValueOnce({
      strategy: 'exact-key',
      blueprint: mkBlueprint({ id: 'bp-ek', variance: matchedVariance }),
      cosine: 1,
      reason: 'exact-key match',
      coverage: EMPTY_GAP,
    });
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      // Request carries a DIFFERENT variance — the reuse must ignore it.
      blueprintDraft: { ...DRAFT, variance: { persona: 'power-user' } },
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.variance).toEqual(matchedVariance);
  });
});

describe('decideHandshake — onBlueprintMatch observer (#490 Wave 1)', () => {
  it('calls adapter.onBlueprintMatch for every pool probed, with the match outcome', async () => {
    mockMatch.mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const calls: Array<{ pool: string; scope: string; result: BlueprintMatchResult }> = [];
    const onBlueprintMatch = vi.fn(
      (input: { pool: string; scope: string; result: BlueprintMatchResult }) => {
        calls.push(input);
      },
    );
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: '@e2e/pool' })], onBlueprintMatch }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('reuse');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.pool).toBe('@e2e/pool');
    expect(calls[0]?.result.strategy).toBe('exact-key');
  });

  it('calls the observer once per pool probed — a later pool is still probed and observed after an earlier miss', async () => {
    mockMatch
      .mockResolvedValueOnce(miss)
      .mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const calls: Array<{ pool: string; scope: string; result: BlueprintMatchResult }> = [];
    const onBlueprintMatch = vi.fn(
      (input: { pool: string; scope: string; result: BlueprintMatchResult }) => {
        calls.push(input);
      },
    );
    const r = await decideHandshake(
      adapter({
        pools: [pool({ label: 'first' }), pool({ label: 'second' })],
        onBlueprintMatch,
      }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('reuse');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ pool: 'first', result: { strategy: 'no-match' } });
    expect(calls[1]).toMatchObject({ pool: 'second', result: { strategy: 'exact-key' } });
  });

  // ggui#1130 — the observer is told WHAT was looked up, not only whether it hit: the
  // contract key, the variant key and the composed exact key the probe read the index
  // at — the same three the matcher keys on (blueprintKey(contract), variantKey(variance),
  // `template:<contractKey>:<variantKey>`). Hashes, never content. On a miss as on a hit,
  // so "missed on the contract" and "missed on the variant" stop reading alike.
  it('tells the observer the keys it looked up — contractKey, variantKey and the composed exactKey — on a miss and on a hit alike', async () => {
    mockMatch
      .mockResolvedValueOnce(miss)
      .mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const calls: Array<{ pool: string; lookup: { contractKey: string; variantKey: string; exactKey: string } }> = [];
    const onBlueprintMatch = vi.fn(
      (input: { pool: string; lookup: { contractKey: string; variantKey: string; exactKey: string } }) => {
        calls.push(input);
      },
    );
    await decideHandshake(
      adapter({ pools: [pool({ label: 'first' }), pool({ label: 'second' })], onBlueprintMatch }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    const contractKey = blueprintKey(DRAFT.contract);
    const vk = variantKey(undefined);
    const expected = { contractKey, variantKey: vk, exactKey: composeExactKey('template', contractKey, vk) };
    expect(calls).toHaveLength(2);
    expect(calls[0]?.lookup).toEqual(expected);
    expect(calls[1]?.lookup).toEqual(expected);
  });

  it('the variant axis is in the lookup: a request variance changes variantKey and exactKey, never contractKey', async () => {
    // a hit, so the decide resolves on the reuse path and no create-side mock is needed
    mockMatch.mockResolvedValue(hit('exact-key', { id: 'bp-v' }));
    const calls: Array<{ lookup: { contractKey: string; variantKey: string; exactKey: string } }> = [];
    await decideHandshake(
      adapter({ pools: [pool({ label: 'only' })], onBlueprintMatch: (input) => { calls.push(input); } }),
      { intent: 'i', blueprintDraft: { ...DRAFT, variance: { persona: 'terse' } }, ctx: CTX },
    );
    const contractKey = blueprintKey(DRAFT.contract);
    const vk = variantKey({ persona: 'terse' });
    expect(vk).not.toBe(variantKey(undefined));
    expect(calls[0]?.lookup).toEqual({ contractKey, variantKey: vk, exactKey: composeExactKey('template', contractKey, vk) });
  });

  it('observes a no-match outcome with strategy "no-match" when no pool hits', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {},
      origin: 'agent',
      method: 'verbatim',
      findings: [],
      reasoning: 'clean',
    } satisfies EnsureConformingResult);
    const calls: Array<{ pool: string; scope: string; result: BlueprintMatchResult }> = [];
    const onBlueprintMatch = vi.fn(
      (input: { pool: string; scope: string; result: BlueprintMatchResult }) => {
        calls.push(input);
      },
    );
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: '@e2e/pool' })], onBlueprintMatch }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('create');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.result.strategy).toBe('no-match');
  });

  it('absent onBlueprintMatch is a no-op — decideHandshake still works', async () => {
    mockMatch.mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
  });

  it('a throwing observer does not break decideHandshake — the exact-key match still resolves, and warn sees the observer failure', async () => {
    mockMatch.mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const onBlueprintMatch = vi.fn(() => {
      throw new Error('observer boom');
    });
    const warn = vi.fn();
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: '@e2e/pool' })], onBlueprintMatch, warn }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.action).toBe('reuse');
    expect(onBlueprintMatch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('onBlueprintMatch observer threw');
    expect(warn.mock.calls[0]?.[0]).toContain('observer boom');
  });

  it('a throwing observer with no warn channel still does not break decideHandshake', async () => {
    mockMatch.mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const onBlueprintMatch = vi.fn(() => {
      throw new Error('observer boom');
    });
    const r = await decideHandshake(adapter({ pools: [pool()], onBlueprintMatch }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
  });
});

describe('decideHandshake — quirky draft reaches the reuse-match gate (fallback-normalize)', () => {
  // A draft carrying mechanical LLM quirks that FAIL a raw
  // dataContractSchema.safeParse but normalizeDraft fixes deterministically:
  //   - a stray `propsSpec.required` array on the wrapper (Gemini's
  //     JSON-Schema reflex — illegal on the `.strict()` wrapper),
  //   - a capitalized `type: "OBJECT"` (canonical is lowercase),
  //   - a pipe-union `type: "STRING|null"` (canonical is a single type).
  // Pre-fix, the raw parse fails → the find-similar block is skipped
  // entirely → matchBlueprint is never reached → fall to create.
  // The draft is UNTRUSTED at this boundary (forgiving handshake) — the
  // contract field is nominally a DataContract but may carry malformed
  // values at runtime. Build it as an opaque JSON value so the literal's
  // illegal `type` strings don't need a type assertion, then thread it in.
  const quirkyContract: DataContract = JSON.parse(
    JSON.stringify({
      propsSpec: {
        properties: { title: { schema: { type: 'string' } } },
        required: ['title'],
      },
      actionSpec: {
        submit: {
          label: 'Submit',
          schema: {
            type: 'OBJECT',
            properties: { text: { type: 'STRING|null' } },
          },
        },
      },
    }),
  );
  const QUIRKY_DRAFT = { contract: quirkyContract };

  it('the quirky draft genuinely fails a RAW dataContractSchema parse (test premise)', () => {
    // Imported lazily to avoid colliding with the matcher/negotiator mocks
    // — this asserts the parse contract directly, the premise of the fix.
    expect(dataContractSchema.safeParse(QUIRKY_DRAFT.contract).success).toBe(
      false,
    );
  });

  it('reuses on an exact-key hit even though the RAW draft fails to parse', async () => {
    mockMatch.mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    // Pre-fix the raw parse fails, the matcher is skipped, and the flow
    // falls to the create path — stub ensureConformingContract so that
    // pre-fix branch yields a clean `create` (not a crash), making the
    // matchBlueprint-was-reached assertion the unambiguous RED signal.
    mockEnsure.mockResolvedValue({
      contract: { propsSpec: { properties: {} } },
      origin: 'agent',
      method: 'verbatim',
      findings: [],
      reasoning: 'clean',
    });
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: QUIRKY_DRAFT,
      ctx: CTX,
    });
    // Pre-fix this is `create` (matchBlueprint never called); post-fix the
    // normalized parse reaches the matcher and the exact-key hit is reused.
    expect(mockMatch).toHaveBeenCalledOnce();
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-ek');
    // The create path must NOT have run.
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('a CLEAN draft still parses verbatim and reuses (no regression to the verbatim path)', async () => {
    // The fallback-normalize is ONLY-ON-FAILURE: a clean draft must reach
    // the matcher via the RAW parse, unchanged.
    mockMatch.mockResolvedValueOnce(hit('exact-key', { id: 'bp-clean' }));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(mockMatch).toHaveBeenCalledOnce();
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-clean');
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

describe('decideHandshake — VARIANCE_GAP finding (D5)', () => {
  // A semantic hit whose matched blueprint carries `bpVariance`, so the
  // proposed (cached) variance can differ from the request's. The `hit()`
  // helper builds a default-variance blueprint, so build the result here.
  function semanticHitWithVariance(
    bpVariance: Record<string, unknown>,
  ): BlueprintMatchResult {
    return {
      strategy: 'semantic',
      blueprint: mkBlueprint({ id: 'bp-sem', variance: bpVariance }),
      cosine: 0.8,
      reason: 'semantic match',
      coverage: EMPTY_GAP,
      judgeConfidence: 0.9,
    };
  }

  it('a reuse whose proposed variance ≠ the request variance carries a VARIANCE_GAP warn finding naming the proposed variance', async () => {
    const proposed = { persona: 'minimalist', aesthetic: 'monochrome' };
    mockMatch.mockResolvedValueOnce(semanticHitWithVariance(proposed));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: { ...DRAFT, variance: { persona: 'power-user' } },
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    const findings =
      r.suggestion.validationFindings?.filter(
        (f) => f.code === 'VARIANCE_GAP',
      ) ?? [];
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.severity).toBe('warn');
    expect(finding?.path).toBe('variance');
    // Default-accept steer.
    expect(finding?.message).toMatch(/default.*accept/i);
    expect(finding?.message).toMatch(/override.*if/i);
    // Names the proposed variance via the bounded persona/aesthetic
    // projection (NOT the raw JSON of the whole block).
    expect(finding?.message).toContain('persona:"minimalist"');
    expect(finding?.message).toContain('aesthetic:"monochrome"');
    // And the requested side projects too.
    expect(finding?.message).toContain('persona:"power-user"');
  });

  it('projects the variance BOUNDED — unbounded context/seedPrompt collapse to a <set> marker, never inlined', async () => {
    // A big context object + a long seedPrompt must NOT be stringified into
    // the wire-carried message; they collapse to a presence marker so the
    // finding stays bounded.
    const longSeed = 'x'.repeat(5000);
    const bigContext = { huge: 'y'.repeat(5000) };
    mockMatch.mockResolvedValueOnce(
      semanticHitWithVariance({
        persona: 'minimalist',
        context: bigContext,
        seedPrompt: longSeed,
      }),
    );
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: { ...DRAFT, variance: { persona: 'power-user' } },
      ctx: CTX,
    });
    const msg =
      r.suggestion.validationFindings?.find((f) => f.code === 'VARIANCE_GAP')
        ?.message ?? '';
    expect(msg).toContain('context:<set>');
    expect(msg).toContain('seedPrompt:<set>');
    // The unbounded payloads never leak into the message.
    expect(msg).not.toContain(longSeed);
    expect(msg).not.toContain('y'.repeat(5000));
    expect(msg.length).toBeLessThan(500);
  });

  it('emits NO VARIANCE_GAP when the proposed variance equals the request variance', async () => {
    const same = { persona: 'minimalist' };
    mockMatch.mockResolvedValueOnce(semanticHitWithVariance(same));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: { ...DRAFT, variance: { ...same } },
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    expect(
      r.suggestion.validationFindings?.some((f) => f.code === 'VARIANCE_GAP'),
    ).toBeFalsy();
  });

  it('emits NO VARIANCE_GAP when both variances are empty/absent (variantKey-equivalent)', async () => {
    // Matched blueprint has {} variance; the request carries none — these
    // are variantKey-equivalent, so no false-flag.
    mockMatch.mockResolvedValueOnce(semanticHitWithVariance({}));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    expect(
      r.suggestion.validationFindings?.some((f) => f.code === 'VARIANCE_GAP'),
    ).toBeFalsy();
  });

  it('a gapped reuse with a variance delta carries BOTH COVERAGE_GAP and VARIANCE_GAP findings', async () => {
    mockMatch.mockResolvedValueOnce({
      strategy: 'semantic',
      blueprint: mkBlueprint({
        id: 'bp-sem',
        variance: { persona: 'minimalist' },
      }),
      cosine: 0.8,
      reason: 'semantic match',
      coverage: {
        actions: ['decrement'],
        props: [],
        context: [],
        streams: [],
        gadgets: [],
      },
      judgeConfidence: 0.9,
    });
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: { ...DRAFT, variance: { persona: 'power-user' } },
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    const codes = (r.suggestion.validationFindings ?? []).map((f) => f.code);
    expect(codes).toContain('COVERAGE_GAP');
    expect(codes).toContain('VARIANCE_GAP');
  });
});

describe('decideHandshake — fulfillability reuse gate (P3c)', () => {
  // A cached blueprint whose contract REQUIRES the agent to be able to call
  // `todo_add` (an action nextStep) — and records that tool's inputSchema
  // (required ['text']). The gate only proposes reuse when the requesting
  // agent's declared caps superset the required tools AND keep the recorded
  // schema satisfiable.
  function blueprintRequiring(
    required: string[],
    recordedRequiredFields: string[] = ['text'],
    id = 'bp-req',
  ): RegistryBlueprint {
    const actionSpec: DataContract['actionSpec'] = {};
    const tools: NonNullable<DataContract['agentCapabilities']>['tools'] = {};
    for (const t of required) {
      actionSpec[t] = { label: t, nextStep: t };
      tools[t] = {
        toolInfo: {
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: recordedRequiredFields,
          },
        },
      };
    }
    return mkBlueprint({
      id,
      contract: { actionSpec, agentCapabilities: { tools } },
    });
  }

  const exactKeyHit = (bp: RegistryBlueprint): BlueprintMatchResult => ({
    strategy: 'exact-key',
    blueprint: bp,
    cosine: 1,
    reason: 'exact-key match',
    coverage: EMPTY_GAP,
  });

  const semanticHit = (
    bp: RegistryBlueprint,
    judgeConfidence: number,
  ): BlueprintMatchResult => ({
    strategy: 'semantic',
    blueprint: bp,
    cosine: 0.8,
    reason: 'semantic match',
    coverage: EMPTY_GAP,
    judgeConfidence,
  });

  /** A draft declaring the given tools (bare-name → required-field list). */
  function draftDeclaring(
    spec: Record<string, { required?: string[]; version?: string }>,
  ): { contract: DataContract } {
    const tools: NonNullable<DataContract['agentCapabilities']>['tools'] = {};
    for (const [name, { required, version }] of Object.entries(spec)) {
      tools[name] = {
        ...(version !== undefined
          ? { serverInfo: { name: 'todo-server', version } }
          : {}),
        toolInfo: {
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            ...(required ? { required } : {}),
          },
        },
      };
    }
    return { contract: { propsSpec: { properties: {} }, agentCapabilities: { tools } } };
  }

  it('GATE PASS — reuses when the draft declares the blueprint-required tool', async () => {
    mockMatch.mockResolvedValueOnce(exactKeyHit(blueprintRequiring(['todo_add'])));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: draftDeclaring({ todo_add: { required: ['text'] } }),
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-req');
  });

  it('GATE DECLINE — falls through to create when the draft lacks a required tool', async () => {
    mockMatch.mockResolvedValueOnce(
      exactKeyHit(blueprintRequiring(['todo_add', 'todo_delete'])),
    );
    mockEnsure.mockResolvedValue({
      contract: { propsSpec: { properties: {} } },
      origin: 'agent',
      method: 'verbatim',
      findings: [],
      reasoning: 'clean',
    });
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: draftDeclaring({ todo_add: { required: ['text'] } }),
      ctx: CTX,
    });
    expect(r.action).not.toBe('reuse');
    expect(r.action).toBe('create');
    expect(mockEnsure).toHaveBeenCalledOnce();
  });

  it('SCHEMA-COMPAT DECLINE — falls through when the draft dropped a recorded-required field', async () => {
    // Blueprint recorded inputSchema.required = ['text']; the draft's CURRENT
    // todo_add no longer requires 'text' → required-subset violated → decline.
    mockMatch.mockResolvedValueOnce(exactKeyHit(blueprintRequiring(['todo_add'], ['text'])));
    mockEnsure.mockResolvedValue({
      contract: { propsSpec: { properties: {} } },
      origin: 'agent',
      method: 'verbatim',
      findings: [],
      reasoning: 'clean',
    });
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: draftDeclaring({ todo_add: { required: [] } }),
      ctx: CTX,
    });
    expect(r.action).not.toBe('reuse');
    expect(r.action).toBe('create');
  });

  it('SCHEMA-COMPAT PASS — reuses when the draft added an OPTIONAL field', async () => {
    // Draft now requires ['text','tags'] — still a superset of the
    // blueprint's ['text'], so optional-add is compatible.
    mockMatch.mockResolvedValueOnce(exactKeyHit(blueprintRequiring(['todo_add'], ['text'])));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: draftDeclaring({ todo_add: { required: ['text', 'tags'] } }),
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-req');
  });

  it('VERSION-INDEPENDENCE — reuses when serverInfo.version bumped but the schema is unchanged', async () => {
    mockMatch.mockResolvedValueOnce(exactKeyHit(blueprintRequiring(['todo_add'], ['text'])));
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: draftDeclaring({
        todo_add: { required: ['text'], version: '9.9.9' },
      }),
      ctx: CTX,
    });
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-req');
  });

  it('SEMANTIC-BEST GATE — an unfulfillable semantic hit is filtered, falls to create', async () => {
    mockMatch.mockResolvedValueOnce(
      semanticHit(blueprintRequiring(['todo_delete']), 0.95),
    );
    mockEnsure.mockResolvedValue({
      contract: { propsSpec: { properties: {} } },
      origin: 'agent',
      method: 'verbatim',
      findings: [],
      reasoning: 'clean',
    });
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: draftDeclaring({ todo_add: { required: ['text'] } }),
      ctx: CTX,
    });
    expect(r.action).not.toBe('reuse');
    expect(r.action).toBe('create');
  });

  it('SEMANTIC ACCUMULATION-GATE — reuses a lower-confidence FULFILLABLE hit over a higher-confidence UNfulfillable one', async () => {
    // Pool 1: the HIGHER-confidence semantic hit (0.95) requires `todo_delete`
    // — the draft can't fulfill it. Pool 2: a LOWER-confidence hit (0.7)
    // requires only `todo_add`, which the draft DOES declare.
    //
    // This pins ACCUMULATION-time gating (filter as hits arrive) vs
    // SELECTION-time gating (reduce-by-confidence, then check the winner):
    //   - accumulation: the unfulfillable 0.95 hit never enters semanticHits,
    //     so the fulfillable 0.7 hit is the only candidate → REUSE bp-lo-good.
    //   - selection: the 0.95 hit would win the reduce, then fail the gate →
    //     fall to CREATE, never reaching the fulfillable 0.7 hit.
    // The current code accumulation-gates, so we assert REUSE of bp-lo-good.
    mockMatch
      .mockResolvedValueOnce(
        semanticHit(blueprintRequiring(['todo_delete'], ['text'], 'bp-hi-bad'), 0.95),
      )
      .mockResolvedValueOnce(
        semanticHit(blueprintRequiring(['todo_add'], ['text'], 'bp-lo-good'), 0.7),
      );
    mockEnsure.mockResolvedValue({
      contract: { propsSpec: { properties: {} } },
      origin: 'agent',
      method: 'verbatim',
      findings: [],
      reasoning: 'clean',
    });
    const r = await decideHandshake(
      adapter({ pools: [pool({ label: 'app' }), pool({ scope: 'shared' })] }),
      {
        intent: 'i',
        blueprintDraft: draftDeclaring({ todo_add: { required: ['text'] } }),
        ctx: CTX,
      },
    );
    expect(r.action).toBe('reuse');
    expect(r.suggestion.blueprintMeta.blueprintId).toBe('bp-lo-good');
    // The create path must NOT have run — the fulfillable hit was reused.
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});

describe('decideHandshake — tool identity canonicalization (Slice 2)', () => {
  // A draft whose `todo_add` tool carries a NON-canonical serverInfo.name
  // ('todo' — a config-key / fabricated name). The per-app catalog maps the
  // bare tool name to the canonical identity its MCP server announced at
  // `initialize` ('@ggui-samples/mcp-todo'). When the adapter exposes a
  // `toolIdentityCatalog`, the handshake step must rewrite the draft's
  // serverInfo BEFORE keying, so the contract that reaches both the match
  // probe AND the create fallback carries the canonical name.
  function draftWithServerName(name: string): { contract: DataContract } {
    return {
      contract: {
        propsSpec: { properties: {} },
        agentCapabilities: {
          tools: {
            todo_add: {
              serverInfo: { name },
              toolInfo: {
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    };
  }

  const CANONICAL = { todo_add: { name: '@ggui-samples/mcp-todo', version: '0.0.1' } };

  it('canonicalizes serverInfo before the MATCH probe reads the contract (Tier 1)', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    await decideHandshake(
      adapter({
        pools: [pool()],
        toolIdentityCatalog: () => CANONICAL,
      }),
      {
        intent: 'i',
        blueprintDraft: draftWithServerName('todo'),
        ctx: CTX,
      },
    );
    // The query (3rd matchBlueprint arg) carries the CANONICALIZED contract.
    const query = mockMatch.mock.calls[0]?.[2];
    expect(
      query?.contract?.agentCapabilities?.tools?.todo_add?.serverInfo?.name,
    ).toBe('@ggui-samples/mcp-todo');
    expect(
      query?.contract?.agentCapabilities?.tools?.todo_add?.serverInfo?.version,
    ).toBe('0.0.1');
  });

  it('canonicalizes serverInfo before the CREATE fallback reads the draft (Tier 1)', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'synth', method: 'llm-repair', findings: [], reasoning: 'r',
    });
    await decideHandshake(
      adapter({
        pools: [pool()],
        toolIdentityCatalog: () => CANONICAL,
      }),
      {
        intent: 'i',
        blueprintDraft: draftWithServerName('todo'),
        ctx: CTX,
      },
    );
    // ensureConformingContract's draft (2nd arg `.draft`) is the
    // canonicalized contract, not the raw 'todo'-named one.
    const ensureArgs = mockEnsure.mock.calls[0]?.[1];
    const draft = ensureArgs?.draft as DataContract | undefined;
    expect(
      draft?.agentCapabilities?.tools?.todo_add?.serverInfo?.name,
    ).toBe('@ggui-samples/mcp-todo');
  });

  it('is a Tier-2 NO-OP when the adapter exposes no toolIdentityCatalog', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    await decideHandshake(
      adapter({ pools: [pool()] }), // no toolIdentityCatalog
      {
        intent: 'i',
        blueprintDraft: draftWithServerName('todo'),
        ctx: CTX,
      },
    );
    const query = mockMatch.mock.calls[0]?.[2];
    // Unchanged — the raw config-key name flows downstream untouched.
    expect(
      query?.contract?.agentCapabilities?.tools?.todo_add?.serverInfo?.name,
    ).toBe('todo');
  });

  it('is a NO-OP when toolIdentityCatalog resolves to undefined (no catalog declared)', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    await decideHandshake(
      adapter({
        pools: [pool()],
        toolIdentityCatalog: () => undefined,
      }),
      {
        intent: 'i',
        blueprintDraft: draftWithServerName('todo'),
        ctx: CTX,
      },
    );
    const query = mockMatch.mock.calls[0]?.[2];
    expect(
      query?.contract?.agentCapabilities?.tools?.todo_add?.serverInfo?.name,
    ).toBe('todo');
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
    if (r.action === 'declined') throw new Error('expected a decision, got declined');
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

  it('the create suggestion carries NO provenance (source absent — gen pending)', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: {}, origin: 'agent', method: 'verbatim', findings: [], reasoning: 'clean',
    });
    const r = await decideHandshake(
      adapter({ pools: [pool()] }),
      { intent: 'i', blueprintDraft: DRAFT, ctx: CTX },
    );
    expect(r.suggestion.blueprintMeta.source).toBeUndefined();
  });

  it('the synth/create result carries the REQUEST variance on blueprintMeta.variance', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockResolvedValue({
      contract: { propsSpec: { properties: {} } },
      origin: 'synth',
      method: 'llm-repair',
      findings: [],
      reasoning: 'repaired',
    });
    const requestVariance = { persona: 'power-user' };
    const r = await decideHandshake(adapter({ pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: { ...DRAFT, variance: requestVariance },
      ctx: CTX,
    });
    expect(r.action).toBe('create');
    expect(r.suggestion.blueprintMeta.variance).toEqual(requestVariance);
  });

  it('the no-creds create fallback carries the REQUEST variance on blueprintMeta.variance', async () => {
    mockMatch.mockResolvedValue(miss);
    const requestVariance = { persona: 'power-user' };
    const r = await decideHandshake(
      adapter({ resolveLlm: () => undefined, pools: [pool()] }),
      {
        intent: 'i',
        blueprintDraft: { ...DRAFT, variance: requestVariance },
        ctx: CTX,
      },
    );
    expect(r.action).toBe('create');
    expect(r.suggestion.blueprintMeta.variance).toEqual(requestVariance);
  });
});

describe('reasonKind — the bounded kind beside every reason (ggui#1343)', () => {
  const kindOf = (r: HandshakeNegotiatorResult): string | undefined =>
    'reasonKind' in r ? r.reasonKind : undefined;
  const cleanWith = (method: EnsureConformingResult['method']): EnsureConformingResult =>
    method === 'declined'
      ? { contract: null, origin: 'agent', method, findings: [], reasoning: 'declined' }
      : {
          contract: {},
          origin: method === 'verbatim' ? 'agent' : 'synth',
          method,
          findings: [],
          reasoning: `reasoning for ${method}`,
        };

  it('an exact-key reuse → match-exact', async () => {
    mockMatch.mockResolvedValueOnce(hit('exact-key', { id: 'bp-ek' }));
    const r = await decideHandshake(adapter({ pools: [pool()] }), { intent: 'i', blueprintDraft: DRAFT, ctx: CTX });
    expect(r.action).toBe('reuse');
    expect(kindOf(r)).toBe('match-exact');
  });

  it('a semantic reuse → match-semantic', async () => {
    mockMatch.mockResolvedValueOnce(hit('semantic', { id: 'bp-sem' }));
    const r = await decideHandshake(adapter({ pools: [pool()] }), { intent: 'i', blueprintDraft: DRAFT, ctx: CTX });
    expect(r.action).toBe('reuse');
    expect(kindOf(r)).toBe('match-semantic');
  });

  it.each(['verbatim', 'normalized', 'llm-repair', 'salvaged-subset'] as const)(
    'a create whose conforming method is %s → the same kind',
    async (method) => {
      mockMatch.mockResolvedValue(miss);
      mockEnsure.mockResolvedValue(cleanWith(method));
      const r = await decideHandshake(adapter({ pools: [pool()] }), { intent: 'i', blueprintDraft: DRAFT, ctx: CTX });
      expect(r.action).toBe('create');
      expect(kindOf(r)).toBe(method);
    },
  );

  it('no LLM for the configured provider → no-creds', async () => {
    mockMatch.mockResolvedValue(miss);
    const r = await decideHandshake(adapter({ resolveLlm: () => undefined, pools: [pool()] }), {
      intent: 'i',
      blueprintDraft: DRAFT,
      ctx: CTX,
    });
    expect(r.action).toBe('create');
    expect(kindOf(r)).toBe('no-creds');
  });

  it('an operational failure under the repair → negotiator-degraded', async () => {
    mockMatch.mockResolvedValue(miss);
    mockEnsure.mockRejectedValue(new Error('provider 5xx'));
    const r = await decideHandshake(adapter({ pools: [pool()] }), { intent: 'i', blueprintDraft: DRAFT, ctx: CTX });
    expect(r.action).toBe('create');
    expect(kindOf(r)).toBe('negotiator-degraded');
  });
});
