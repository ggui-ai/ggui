/**
 * #606 top-K ranking probe — does intent-only retrieval mis-rank the
 * true seed in realistic mixed pools, where contract+intent ranks it
 * higher?
 *
 * Context: stored vectors embed `composeEmbeddingInput(contract,
 * intent)` and `findBlueprintsByEmbedding` COMPOSES the query the same
 * way when a contract is passed — but the matcher's RAG call site drops
 * the contract (`blueprint-matcher.ts` builds `{ intent }` only), so
 * production retrieval is intent-only even for contract-bearing
 * handshakes. Run 5 measured the asymmetry (+0.371 mean top-1 cosine
 * on should-hits under Titan); THIS probe measures whether it moves
 * RANKS: pool = every distinct seed across the 28 hand-labeled pairs
 * (a mixed-family library), one query per semantic should-hit case,
 * both compositions, rank of the true seed recorded.
 *
 * Decision rule (stamped on #606): any case where intent-only puts the
 * true seed OUTSIDE the production top-20 while contract+intent keeps
 * it inside ⇒ promote to P1 + ship the call-site fix. Ranking holds ⇒
 * close-as-headroom with these outputs as the record.
 *
 * Run (local geometry):
 *   cd oss/packages/mcp-server-handlers && \
 *     tsx src/renders/match-precision/topk-probe.ts
 * Titan arm: prepend AWS creds + RND_EMBEDDER_MODULE=<bedrock module>.
 * Output: ../../../.tmp/rnd-economy-001/topk-<embedder>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createLocalEmbeddingProvider } from '@ggui-ai/embedding-local';
import {
  findBlueprintsByEmbedding,
  registerBlueprint,
  type BlueprintRegistryDeps,
} from '../blueprint-registry.js';
import { PAIRS, STUB_CODE, type MatchPair } from './pairs.js';

const SCOPE = 'topk-probe';
const OUT_DIR = pathResolve(process.cwd(), '../../../.tmp/rnd-economy-001');
const PRODUCTION_TOP_K = 20;

async function resolveEmbedding(): Promise<BlueprintRegistryDeps['embedding']> {
  const modulePath = process.env['RND_EMBEDDER_MODULE'];
  if (modulePath === undefined || modulePath.length === 0) {
    return createLocalEmbeddingProvider({
      cacheDir: join(homedir(), '.ggui', 'models'),
    });
  }
  const mod = (await import(pathResolve(modulePath))) as {
    createEmbedding?: () => BlueprintRegistryDeps['embedding'];
  };
  if (typeof mod.createEmbedding !== 'function') {
    throw new Error(`RND_EMBEDDER_MODULE must export createEmbedding()`);
  }
  return mod.createEmbedding();
}

/** Semantic should-hit cases: expected to reuse via the SEMANTIC tier
 *  (exact-key cases bypass retrieval entirely — ranking is moot). */
function semanticShouldHits(): MatchPair[] {
  return PAIRS.filter(
    (p) =>
      p.tier === 'gated' &&
      p.expect.verdict === 'hit' &&
      p.expect.strategy !== 'exact-key' &&
      // s-cosmetic-variance resolves exact-key in practice (run receipts).
      p.id !== 's-cosmetic-variance',
  );
}

async function main(): Promise<void> {
  const embedding = await resolveEmbedding();
  process.stdout.write(`embedding provider: ${embedding.id}\n`);
  mkdirSync(OUT_DIR, { recursive: true });

  // ── Build ONE mixed-family pool: every distinct seed across ALL pairs.
  const registry: BlueprintRegistryDeps = {
    embedding,
    vectorStore: new InMemoryVectorStore(),
    index: new InMemoryBlueprintIndex(),
  };
  const seen = new Set<string>();
  let poolSize = 0;
  for (const pair of PAIRS) {
    for (const s of pair.seeds) {
      if (seen.has(s.intent)) continue;
      seen.add(s.intent);
      await registerBlueprint(registry, SCOPE, {
        kind: 'template',
        contract: s.contract,
        intent: s.intent,
        componentCode: STUB_CODE,
        source: { kind: 'user' },
        // Unique variance per row: pairs SHARE contract consts, and a
        // same-(kind, contractKey, variantKey) registration REPLACES the
        // earlier row (intent overwritten — the double-null bug in probe
        // run 1). variantKey shifts with variance; the embedding does
        // NOT (composeEmbeddingInput = contract+intent only), so rows
        // coexist without touching the geometry under test.
        variance: { ...(s.variance ?? {}), seedPrompt: `pool-row-${poolSize}` },
      });
      poolSize++;
    }
  }
  process.stdout.write(`pool: ${poolSize} distinct seeds (mixed families)\n\n`);

  interface CaseRow {
    id: string;
    trueSeedIntent: string;
    rankIntentOnly: number | null;
    rankBoth: number | null;
    top1IntentOnly: boolean;
    top1Both: boolean;
    outsideK_intentOnly: boolean;
    outsideK_both: boolean;
    cosTrue_intentOnly: number | null;
    cosTrue_both: number | null;
  }

  const rows: CaseRow[] = [];
  for (const pair of semanticShouldHits()) {
    // Convention from pairs.ts: seeds[0] is the expected hit target.
    const trueIntent = pair.seeds[0]!.intent;
    const query = { intent: pair.probe.intent, contract: pair.probe.contract };

    const rankOf = async (withContract: boolean): Promise<{ rank: number | null; cos: number | null }> => {
      const candidates = await findBlueprintsByEmbedding(
        registry,
        SCOPE,
        withContract && query.contract !== undefined
          ? { intent: query.intent, contract: query.contract }
          : { intent: query.intent },
        { topK: poolSize },
      );
      const i = candidates.findIndex((c) => c.blueprint.intent === trueIntent);
      return i === -1
        ? { rank: null, cos: null }
        : { rank: i + 1, cos: candidates[i]!.cosine };
    };

    const intentOnly = await rankOf(false);
    const both = await rankOf(true);
    rows.push({
      id: pair.id,
      trueSeedIntent: trueIntent.slice(0, 60),
      rankIntentOnly: intentOnly.rank,
      rankBoth: both.rank,
      top1IntentOnly: intentOnly.rank === 1,
      top1Both: both.rank === 1,
      outsideK_intentOnly: intentOnly.rank === null || intentOnly.rank > PRODUCTION_TOP_K,
      outsideK_both: both.rank === null || both.rank > PRODUCTION_TOP_K,
      cosTrue_intentOnly: intentOnly.cos,
      cosTrue_both: both.cos,
    });
    process.stdout.write(
      `${pair.id.padEnd(26)} rank: intent-only=${String(intentOnly.rank).padStart(2)}  c+i=${String(both.rank).padStart(2)}` +
        `${(intentOnly.rank ?? 99) > PRODUCTION_TOP_K ? '  << OUTSIDE TOP-20 (intent-only)' : ''}\n`,
    );
  }

  const promoteTriggers = rows.filter((r) => r.outsideK_intentOnly && !r.outsideK_both);
  const summary = {
    probedAt: new Date().toISOString(),
    embedding: embedding.id,
    poolSize,
    productionTopK: PRODUCTION_TOP_K,
    cases: rows.length,
    top1_intentOnly: rows.filter((r) => r.top1IntentOnly).length,
    top1_both: rows.filter((r) => r.top1Both).length,
    meanRank_intentOnly:
      rows.reduce((a, r) => a + (r.rankIntentOnly ?? poolSize + 1), 0) / rows.length,
    meanRank_both:
      rows.reduce((a, r) => a + (r.rankBoth ?? poolSize + 1), 0) / rows.length,
    outsideTop20_intentOnly: rows.filter((r) => r.outsideK_intentOnly).map((r) => r.id),
    outsideTop20_both: rows.filter((r) => r.outsideK_both).map((r) => r.id),
    PROMOTE_TRIGGERS: promoteTriggers.map((r) => r.id),
  };
  const outName = `topk-${embedding.id.replace(/[^a-z0-9-]/gi, '-')}.json`;
  writeFileSync(pathResolve(OUT_DIR, outName), JSON.stringify({ summary, rows }, null, 2));
  process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\nfull → ${pathResolve(OUT_DIR, outName)}\n`);
}

main().catch((err) => {
  process.stderr.write(`topk-probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
