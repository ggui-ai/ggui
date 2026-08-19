#!/usr/bin/env node
/**
 * Match-precision probe — drives the REAL match stack offline over the
 * hand-labeled pair set in `pairs.ts`:
 *
 *   - real local embedding geometry (bge-small-en-v1.5 via
 *     `@ggui-ai/embedding-local`; the model cache directory defaults to
 *     `~/.ggui/models`, the same cache `ggui serve` populates),
 *   - the real LLM judge (same prompt/tool the matcher uses),
 *   - PRODUCTION thresholds as the control arm (no options passed to
 *     `matchBlueprint`, so minCosine/judgeThreshold/topK are exactly
 *     what every deployment runs).
 *
 * Per pair: a FRESH in-memory registry is seeded via `registerBlueprint`
 * (stub component code — the judge never reads code, so match-verdict
 * ground truth is fully exercised at ~zero cost), then `matchBlueprint`
 * runs once (three times for `debated` pairs — stability, not
 * correctness) with a collecting cache-trace sink as the decision
 * oracle. The H1 arm additionally runs retrieval BOTH ways on
 * contract-bearing probes — intent-only (production `ragArg`) vs
 * contract+intent (the stored-side composition) — recording top-1
 * cosine for each, measuring the embedding-asymmetry hypothesis with
 * zero production code change.
 *
 * REPORT, NEVER ASSERT: results go to `.tmp/rnd-economy-001/` +
 * stdout; this is an R&D instrument, not a CI gate. Judge threshold /
 * cosine-gate sweeps are computed post-hoc from the recorded values
 * (no extra LLM calls).
 *
 * Usage: pnpm -F @ggui-ai/mcp-server-handlers match-precision-probe
 *   (reads ANTHROPIC_API_KEY or ~/.ggui/credentials.json; ~30-40
 *   Haiku calls ≈ well under $1)
 *
 * Experiment: rnd/gen-ui/economy/experiments/001-match-precision-instrument.md
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createLocalEmbeddingProvider } from '@ggui-ai/embedding-local';
import type { LLMCaller, ToolSchema } from '@ggui-ai/negotiator';
import { matchBlueprint } from '../blueprint-matcher.js';
import {
  findBlueprintsByEmbedding,
  registerBlueprint,
  type BlueprintRegistryDeps,
} from '../blueprint-registry.js';
import {
  setCacheTraceSink,
  type CacheTraceEvent,
} from '../cache-trace-sink.js';
import { PAIRS, STUB_CODE, type MatchPair } from './pairs.js';

const SCOPE = 'match-precision-probe';
const DEBATED_RUNS = 3;
const OUT_DIR = pathResolve(process.cwd(), '../../../.tmp/rnd-economy-001');

// --- judge plumbing (same shape as cache-reuse-probe.ts) -------------------

function resolveKey(): string {
  const env = process.env['ANTHROPIC_API_KEY'];
  if (env) return env;
  const p = pathResolve(homedir(), '.ggui', 'credentials.json');
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as {
    apps?: { global?: { anthropic?: string } };
  };
  const k = parsed.apps?.global?.anthropic;
  if (!k) throw new Error(`no anthropic key (env or ${p})`);
  return k;
}

function anthropicJudge(apiKey: string): LLMCaller {
  return {
    async call(): Promise<string> {
      throw new Error('text mode unused');
    },
    async callStructured<T>(
      system: string,
      user: string,
      tool: ToolSchema,
    ): Promise<T> {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          system,
          messages: [{ role: 'user', content: user }],
          tools: [
            {
              name: tool.name,
              description: tool.description,
              input_schema: tool.input_schema,
            },
          ],
          tool_choice: { type: 'tool', name: tool.name },
        }),
      });
      const json = (await res.json()) as {
        content?: { type: string; input?: unknown }[];
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(`anthropic: ${json.error?.message}`);
      const block = json.content?.find((b) => b.type === 'tool_use');
      return block?.input as T;
    },
  };
}

// --- result shapes ---------------------------------------------------------

interface RunRecord {
  readonly strategy: string;
  readonly decision: string | undefined;
  readonly cosine: number | undefined;
  readonly judgeConfidence: number | undefined;
  readonly judgeReason: string | undefined;
  readonly hitBlueprintIntent: string | undefined;
}

interface PairResult {
  readonly id: string;
  readonly klass: MatchPair['klass'];
  readonly tier: MatchPair['tier'];
  readonly expect: MatchPair['expect'];
  readonly reuseWouldBeWrong: boolean;
  readonly runs: readonly RunRecord[];
  /** Level-(a) verdict of run 1 vs expectation. */
  readonly verdictOk: boolean;
  readonly strategyOk: boolean;
  readonly decisionOk: boolean;
  /** H1 arm: top-1 retrieval cosine, both query compositions. */
  readonly h1?: {
    readonly intentOnlyTop1: number | null;
    readonly contractPlusIntentTop1: number | null;
  };
}

// --- runner ----------------------------------------------------------------

async function runPair(
  pair: MatchPair,
  llm: LLMCaller,
  embedding: ReturnType<typeof createLocalEmbeddingProvider>,
): Promise<PairResult> {
  const registry: BlueprintRegistryDeps = {
    embedding,
    vectorStore: new InMemoryVectorStore(),
    index: new InMemoryBlueprintIndex(),
  };
  for (const s of pair.seeds) {
    await registerBlueprint(registry, SCOPE, {
      kind: 'template',
      contract: s.contract,
      intent: s.intent,
      componentCode: STUB_CODE,
      source: { kind: 'user' },
      ...(s.variance !== undefined ? { variance: s.variance } : {}),
    });
  }

  const runs: RunRecord[] = [];
  const runCount = pair.tier === 'debated' ? DEBATED_RUNS : 1;
  for (let i = 0; i < runCount; i++) {
    let traced: CacheTraceEvent | undefined;
    setCacheTraceSink({
      emit(event) {
        traced = event;
      },
    });
    try {
      const result = await matchBlueprint({ registry, llm }, SCOPE, {
        intent: pair.probe.intent,
        ...(pair.probe.contract !== undefined ? { contract: pair.probe.contract } : {}),
        ...(pair.probe.variance !== undefined ? { variance: pair.probe.variance } : {}),
      });
      runs.push(
        result.strategy === 'no-match'
          ? {
              strategy: 'no-match',
              decision: traced?.decision,
              cosine: result.candidates[0]?.cosine,
              judgeConfidence: traced?.judgeConfidence,
              judgeReason: result.judgeReason ?? traced?.judgeReason,
              hitBlueprintIntent: undefined,
            }
          : {
              strategy: result.strategy,
              decision: traced?.decision,
              cosine: result.cosine,
              judgeConfidence: result.judgeConfidence,
              judgeReason: traced?.judgeReason,
              hitBlueprintIntent: result.blueprint.intent,
            },
      );
    } finally {
      setCacheTraceSink(null);
    }
  }

  const first = runs[0];
  const gotHit = first.strategy !== 'no-match';
  const verdictOk = (pair.expect.verdict === 'hit') === gotHit;
  const strategyOk =
    pair.expect.strategy === undefined
      ? true
      : pair.expect.strategy === '!exact-key'
        ? first.strategy !== 'exact-key'
        : first.strategy === pair.expect.strategy;
  const decisionOk =
    pair.expect.decision === undefined ? true : first.decision === pair.expect.decision;

  // H1 arm — retrieval both ways, contract-bearing probes only.
  let h1: PairResult['h1'];
  if (pair.probe.contract !== undefined) {
    const intentOnly = await findBlueprintsByEmbedding(registry, SCOPE, {
      intent: pair.probe.intent,
    });
    const both = await findBlueprintsByEmbedding(registry, SCOPE, {
      intent: pair.probe.intent,
      contract: pair.probe.contract,
    });
    h1 = {
      intentOnlyTop1: intentOnly[0]?.cosine ?? null,
      contractPlusIntentTop1: both[0]?.cosine ?? null,
    };
  }

  return {
    id: pair.id,
    klass: pair.klass,
    tier: pair.tier,
    expect: pair.expect,
    reuseWouldBeWrong: pair.reuseWouldBeWrong,
    runs,
    verdictOk,
    strategyOk,
    decisionOk,
    ...(h1 !== undefined ? { h1 } : {}),
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}% (${n}/${d})`;
}

async function main(): Promise<void> {
  const llm = anthropicJudge(resolveKey());
  const embedding = createLocalEmbeddingProvider({
    cacheDir: join(homedir(), '.ggui', 'models'),
  });
  mkdirSync(OUT_DIR, { recursive: true });

  const results: PairResult[] = [];
  for (const pair of PAIRS) {
    const r = await runPair(pair, llm, embedding);
    results.push(r);
    const first = r.runs[0];
    const flag = r.tier === 'debated' ? '~' : r.verdictOk && r.strategyOk && r.decisionOk ? 'ok' : 'XX';
    process.stdout.write(
      `[${flag}] ${r.id.padEnd(26)} ${String(first.strategy).padEnd(10)} ` +
        `decision=${String(first.decision).padEnd(24)} cos=${first.cosine?.toFixed(3) ?? '  -  '} ` +
        `judge=${first.judgeConfidence?.toFixed(2) ?? '  - '}` +
        (r.h1
          ? ` | h1 intent=${r.h1.intentOnlyTop1?.toFixed(3)} c+i=${r.h1.contractPlusIntentTop1?.toFixed(3)}`
          : '') +
        '\n',
    );
  }

  // --- aggregates ----------------------------------------------------------
  const gated = results.filter((r) => r.tier === 'gated');
  const shouldHit = gated.filter((r) => r.expect.verdict === 'hit');
  const mustMiss = gated.filter((r) => r.expect.verdict === 'miss');
  const recallOk = shouldHit.filter((r) => r.verdictOk).length;
  const falseHits = mustMiss.filter((r) => !r.verdictOk);
  const strategyFails = gated.filter((r) => !r.strategyOk || !r.decisionOk);

  // Precision over ACTUAL hits, judged against system-level truth.
  const hits = gated.filter((r) => r.runs[0].strategy !== 'no-match');
  const wrongHits = hits.filter((r) => r.reuseWouldBeWrong);

  // H1: mean top-1 cosine delta on should-hit contract-bearing pairs vs
  // must-miss ones (the asymmetry matters only if it lifts the former
  // without lifting the latter).
  const h1Delta = (rs: readonly PairResult[]): number | null => {
    const ds = rs
      .filter((r) => r.h1?.intentOnlyTop1 != null && r.h1.contractPlusIntentTop1 != null)
      .map((r) => (r.h1!.contractPlusIntentTop1! - r.h1!.intentOnlyTop1!));
    return ds.length === 0 ? null : ds.reduce((a, b) => a + b, 0) / ds.length;
  };
  const h1ShouldHit = h1Delta(shouldHit);
  const h1MustMiss = h1Delta(mustMiss);

  // Debated stability: fraction of debated pairs where all runs agree.
  const debated = results.filter((r) => r.tier === 'debated');
  const stable = debated.filter((r) => {
    const verdicts = r.runs.map((run) => run.strategy !== 'no-match');
    return verdicts.every((v) => v === verdicts[0]);
  });

  const summary = {
    probedAt: new Date().toISOString(),
    pairs: results.length,
    thresholds: 'production defaults (no overrides passed)',
    embedding: embedding.id,
    judgeModel: 'claude-haiku-4-5',
    recall_shouldHit: pct(recallOk, shouldHit.length),
    falseHits_mustMiss: pct(falseHits.length, mustMiss.length),
    falseHitIds: falseHits.map((r) => r.id),
    precision_overHits: pct(hits.length - wrongHits.length, hits.length),
    wrongHitIds: wrongHits.map((r) => r.id),
    tierExpectationFails: strategyFails.map((r) => r.id),
    h1_meanTop1CosineDelta_shouldHit: h1ShouldHit,
    h1_meanTop1CosineDelta_mustMiss: h1MustMiss,
    debatedStability: pct(stable.length, debated.length),
  };

  writeFileSync(
    pathResolve(OUT_DIR, 'results.json'),
    JSON.stringify({ summary, results }, null, 2),
  );
  process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`full detail → ${pathResolve(OUT_DIR, 'results.json')}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `match-precision-probe failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
