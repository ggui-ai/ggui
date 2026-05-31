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
import type { DataContract } from '@ggui-ai/protocol';
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
import type { BlueprintMatchResult } from './blueprint-matcher.js';
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

describe('buildCacheReuseResult', () => {
  it('projects a matched blueprint into an ATOMIC origin:cache reuse', () => {
    const cachedContract: DataContract = {
      contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
    };
    const code = 'export default () => null;';
    const result = buildCacheReuseResult(
      { id: 'template:abc', contractKey: 'abc', componentCode: code, contract: cachedContract },
      'match-semantic: judge matched (confidence=0.90)',
    );
    expect(result.action).toBe('reuse');
    // Atomic: served contract is the CACHED blueprint's own contract.
    expect(result.effectiveContract).toBe(cachedContract);
    expect(result.suggestion.origin).toBe('cache');
    expect(result.suggestion.blueprintMeta.blueprintId).toBe('template:abc');
    expect(result.suggestion.blueprintMeta.contractHash).toBe('abc');
    expect(result.suggestion.blueprintMeta.codeHash).toBe(
      createHash('sha256').update(code).digest('hex'),
    );
    expect(result.suggestion.blueprintMeta.generator).toBe(DEFAULT_GENERATOR_SLUG);
    expect(result.reason).toMatch(/match-semantic/);
  });

  it('honors a custom generator slug', () => {
    const r = buildCacheReuseResult(
      { id: 'x', contractKey: 'x', componentCode: 'a', contract: {} },
      'r',
      'ui-gen-advanced-opus',
    );
    expect(r.suggestion.blueprintMeta.generator).toBe('ui-gen-advanced-opus');
  });

  it('is deterministic — same blueprint + reason → identical result', () => {
    const bp = { id: 'x', contractKey: 'x', componentCode: 'a', contract: {} as DataContract };
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
  });

  it('substitutes the empty contract + loud findings for a MALFORMED draft', () => {
    const malformed = { propsSpec: 'not-an-object' };
    const r = buildCreateFallback(malformed, 'no-creds: ...');
    expect(r.action).toBe('create');
    expect(r.effectiveContract).toEqual({});
    expect(r.suggestion.validationFindings?.length ?? 0).toBeGreaterThan(0);
    expect(r.suggestion.validationFindings?.[0]?.severity).toBe('error');
  });

  it('honors a custom generator slug', () => {
    const r = buildCreateFallback({ propsSpec: { properties: {} } }, 'r', 'slug-z');
    expect(r.suggestion.blueprintMeta.generator).toBe('slug-z');
  });
});

// ---------------------------------------------------------------------------
// decideHandshake orchestration
// ---------------------------------------------------------------------------

function hit(strategy: 'exact-key' | 'semantic', over: {
  id?: string;
  reason?: string;
  judgeConfidence?: number;
} = {}): BlueprintMatchResult {
  return {
    strategy,
    blueprint: mkBlueprint({ id: over.id ?? `bp-${strategy}`, contractKey: over.id ?? strategy }),
    cosine: strategy === 'exact-key' ? 1 : 0.8,
    reason: over.reason ?? `${strategy} match`,
    ...(strategy === 'semantic' && over.judgeConfidence !== undefined
      ? { judgeConfidence: over.judgeConfidence }
      : {}),
  };
}

const miss: BlueprintMatchResult = { strategy: 'no-match', reason: 'no candidates', candidates: [] };

describe('decideHandshake — pre-match', () => {
  it('short-circuits on a pre-match hit (find-similar never runs)', async () => {
    const preResult = buildCacheReuseResult(
      { id: 'curated-1', contractKey: 'c1', componentCode: 'x', contract: {} },
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
