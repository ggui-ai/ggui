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
 * Arms (env, all optional; unset = the historical run above):
 *   - `RND_EMBEDDER_MODULE` — another embedding geometry (see
 *     `resolveEmbedding`).
 *   - `RND_JUDGE_MODULE` (+ `RND_JUDGE_LABEL`) — another rerank judge
 *     behind the same `LLMCaller` seam (see `resolveJudge`).
 *   - `RND_TOP_K`, `RND_MIN_COSINE`, `RND_JUDGE_THRESHOLD` — pass those
 *     `matchBlueprint` options explicitly, so a run measures the judge
 *     at a stated gate whatever default its checkout carries; `0` for
 *     `RND_MIN_COSINE` opens the gate (every candidate reaches the
 *     judge), for a floor sweep read offline from the recorded cosines.
 *   - `RND_OUT_DIR` — output directory, resolved against the working
 *     directory (default: the repo's `.tmp/rnd-economy-001`).
 * Every run records, per pair and run, the top-K the matcher retrieved
 * (id, cosine, cached intent) and each judge call (order, wall-clock,
 * candidates shown, decision or error).
 *
 * Experiments: rnd/gen-ui/economy/experiments/001-match-precision-instrument.md
 * (and 002, the second-judge arm)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve as pathResolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createLocalEmbeddingProvider } from '@ggui-ai/embedding-local';
import type { LLMCaller, ToolSchema } from '@ggui-ai/negotiator';
import { isRecord } from '@ggui-ai/protocol';
import {
  anthropicProbeJudge,
  DEFAULT_PROBE_JUDGE_MODEL,
} from '../probe-anthropic-judge.js';
import { matchBlueprint, type MatchBlueprintOptions } from '../blueprint-matcher.js';
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
const OUT_DIR = pathResolve(
  process.cwd(),
  process.env['RND_OUT_DIR'] ?? '../../../.tmp/rnd-economy-001',
);

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

/**
 * The rerank judge for this run.
 *
 * Default: the Anthropic probe judge (the control every receipted
 * number was taken under).
 *
 * Judge arm: set `RND_JUDGE_MODULE` to the absolute path of a module
 * exporting `createJudge(): LLMCaller` and the SAME pairs run with that
 * caller behind the rerank's `callStructured` seam — the matcher, the
 * prompt and the candidate list are unchanged; only who answers moves.
 * Loaded by path, like `RND_EMBEDDER_MODULE`, so this script names no
 * provider. `RND_JUDGE_LABEL` names the arm in the summary and the
 * output file (default: the module's file name).
 */
async function resolveJudge(): Promise<{ readonly llm: LLMCaller; readonly label: string }> {
  const modulePath = process.env['RND_JUDGE_MODULE'];
  if (modulePath === undefined || modulePath.length === 0) {
    return { llm: anthropicProbeJudge(resolveKey()), label: DEFAULT_PROBE_JUDGE_MODEL };
  }
  const mod = (await import(pathResolve(modulePath))) as {
    createJudge?: () => LLMCaller;
  };
  if (typeof mod.createJudge !== 'function') {
    throw new Error(`RND_JUDGE_MODULE (${modulePath}) must export createJudge(): LLMCaller`);
  }
  const llm = mod.createJudge();
  if (typeof llm.callStructured !== 'function') {
    throw new Error(
      `RND_JUDGE_MODULE (${modulePath}) createJudge() returned an LLMCaller without callStructured — the rerank judge answers through a forced tool`,
    );
  }
  const label = process.env['RND_JUDGE_LABEL'];
  return {
    llm,
    label:
      label !== undefined && label.length > 0
        ? label
        : basename(modulePath).replace(/\.[cm]?[jt]s$/, ''),
  };
}

/** A whole or fractional number from the env, range-checked; unset ⇒ undefined. */
function numberFromEnv(
  name: string,
  lo: number,
  hi: number,
  whole: boolean,
): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < lo || value > hi || (whole && !Number.isInteger(value))) {
    throw new Error(`${name}=${raw} is not a ${whole ? 'whole ' : ''}number in [${lo}, ${hi}]`);
  }
  return value;
}

/** The `matchBlueprint` options this run passes — empty ⇒ production defaults. */
function resolveMatchOptions(): MatchBlueprintOptions {
  const topK = numberFromEnv('RND_TOP_K', 1, 200, true);
  const minCosineForRerank = numberFromEnv('RND_MIN_COSINE', 0, 1, false);
  const judgeThreshold = numberFromEnv('RND_JUDGE_THRESHOLD', 0, 1, false);
  return {
    ...(topK !== undefined ? { topK } : {}),
    ...(minCosineForRerank !== undefined ? { minCosineForRerank } : {}),
    ...(judgeThreshold !== undefined ? { judgeThreshold } : {}),
  };
}

// --- judge-call recording --------------------------------------------------

/** One call through the judge seam, as the probe saw it. */
interface JudgeCallRecord {
  /** 1-based order across the whole probe run — a judge module's own log joins on it. */
  readonly seq: number;
  readonly wallMs: number;
  /** Candidates the judge was shown (the rerank message's own `CANDIDATES (n)` count). */
  readonly shown: number | null;
  readonly outcome:
    | { readonly kind: 'decision'; readonly matchId: string | null; readonly confidence: number }
    | { readonly kind: 'unparsed' }
    | { readonly kind: 'threw'; readonly message: string };
}

function readDecision(raw: unknown): JudgeCallRecord['outcome'] {
  if (!isRecord(raw)) return { kind: 'unparsed' };
  const matchId = raw['matchId'];
  const confidence = raw['confidence'];
  return (typeof matchId === 'string' || matchId === null) && typeof confidence === 'number'
    ? { kind: 'decision', matchId, confidence }
    : { kind: 'unparsed' };
}

/**
 * Wrap a judge so every structured call is recorded — the rerank itself
 * reports no latency or raw decision to the matcher's trace, and turns a
 * thrown call into a quiet no-match, so without this a failed call reads
 * exactly like a declined one. Errors are recorded and re-thrown
 * unchanged; the matcher still sees what the judge did.
 */
function recordingJudge(inner: LLMCaller): {
  readonly llm: LLMCaller;
  /** The calls since the last take, in order. */
  take(): readonly JudgeCallRecord[];
} {
  const structured = inner.callStructured?.bind(inner);
  if (structured === undefined) {
    throw new Error('recordingJudge: the judge has no callStructured');
  }
  let seq = 0;
  let pending: JudgeCallRecord[] = [];
  const llm: LLMCaller = {
    call: (system, user, maxTokens) => inner.call(system, user, maxTokens),
    async callStructured(
      system: string,
      user: string,
      tool: ToolSchema,
      maxTokens?: number,
    ): Promise<unknown> {
      seq += 1;
      const n = seq;
      const shownMatch = /^CANDIDATES \((\d+)\)$/m.exec(user);
      const shown = shownMatch !== null ? Number(shownMatch[1]) : null;
      const t0 = performance.now();
      try {
        const out = await structured(system, user, tool, maxTokens);
        pending.push({ seq: n, wallMs: performance.now() - t0, shown, outcome: readDecision(out) });
        return out;
      } catch (err) {
        pending.push({
          seq: n,
          wallMs: performance.now() - t0,
          shown,
          outcome: { kind: 'threw', message: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
    },
  };
  return {
    llm,
    take() {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

type RecordingJudge = ReturnType<typeof recordingJudge>;

// --- result shapes ---------------------------------------------------------

interface RunRecord {
  readonly strategy: string;
  readonly decision: string | undefined;
  readonly cosine: number | undefined;
  readonly judgeConfidence: number | undefined;
  readonly judgeReason: string | undefined;
  readonly hitBlueprintIntent: string | undefined;
  /** The top-K the matcher retrieved (its trace's candidate list), best first. */
  readonly candidates: readonly {
    readonly id: string;
    readonly cosine: number;
    readonly cachedIntent: string | undefined;
  }[];
  /** Every judge call this run made, in order (none when the gate or a key decided). */
  readonly judgeCalls: readonly JudgeCallRecord[];
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
  judge: RecordingJudge,
  embedding: BlueprintRegistryDeps['embedding'],
  options: MatchBlueprintOptions,
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
      const result = await matchBlueprint(
        { registry, llm: judge.llm },
        SCOPE,
        {
          intent: pair.probe.intent,
          ...(pair.probe.contract !== undefined ? { contract: pair.probe.contract } : {}),
          ...(pair.probe.variance !== undefined ? { variance: pair.probe.variance } : {}),
        },
        options,
      );
      const recorded = {
        candidates: (traced?.candidates ?? []).map((c) => ({
          id: c.key,
          cosine: c.score,
          cachedIntent: c.cachedIntent,
        })),
        judgeCalls: judge.take(),
      };
      runs.push(
        result.strategy === 'no-match'
          ? {
              strategy: 'no-match',
              decision: traced?.decision,
              cosine: result.candidates[0]?.cosine,
              judgeConfidence: traced?.judgeConfidence,
              judgeReason: result.judgeReason ?? traced?.judgeReason,
              hitBlueprintIntent: undefined,
              ...recorded,
            }
          : {
              strategy: result.strategy,
              decision: traced?.decision,
              cosine: result.cosine,
              judgeConfidence: result.judgeConfidence,
              judgeReason: traced?.judgeReason,
              hitBlueprintIntent: result.blueprint.intent,
              ...recorded,
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

/**
 * Resolve the embedding provider for this run.
 *
 * Default: the local provider (fast, free, deterministic geometry).
 *
 * Wire-fidelity arm: set `RND_EMBEDDER_MODULE` to the absolute path of
 * a module exporting `createEmbedding(): EmbeddingProvider` and the
 * probe runs the SAME pairs under that provider's geometry instead —
 * cosine scales are model-relative, so comparing instrument numbers
 * against a deployment that embeds with a different model requires
 * re-running the probe under that model's provider. The module is
 * loaded by path (never a package name) so this script stays free of
 * any dependency on where such a provider lives.
 */
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
    throw new Error(
      `RND_EMBEDDER_MODULE (${modulePath}) must export createEmbedding(): EmbeddingProvider`,
    );
  }
  const provider = mod.createEmbedding();
  if (typeof provider.embed !== 'function' || typeof provider.id !== 'string') {
    throw new Error(
      `RND_EMBEDDER_MODULE (${modulePath}) createEmbedding() returned a non-EmbeddingProvider`,
    );
  }
  return provider;
}

/** Nearest-rank percentile of a non-empty sample; null when empty. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

async function main(): Promise<void> {
  const resolvedJudge = await resolveJudge();
  const judge = recordingJudge(resolvedJudge.llm);
  const options = resolveMatchOptions();
  const embedding = await resolveEmbedding();
  process.stdout.write(
    `embedding provider: ${embedding.id} · judge: ${resolvedJudge.label} · options: ${JSON.stringify(options)}\n`,
  );
  mkdirSync(OUT_DIR, { recursive: true });

  const results: PairResult[] = [];
  for (const pair of PAIRS) {
    const r = await runPair(pair, judge, embedding, options);
    results.push(r);
    const first = r.runs[0];
    const flag = r.tier === 'debated' ? '~' : r.verdictOk && r.strategyOk && r.decisionOk ? 'ok' : 'XX';
    process.stdout.write(
      `[${flag}] ${r.id.padEnd(26)} ${String(first.strategy).padEnd(10)} ` +
        `decision=${String(first.decision).padEnd(24)} cos=${first.cosine?.toFixed(3) ?? '  -  '} ` +
        `judge=${first.judgeConfidence?.toFixed(2) ?? '  - '} calls=${first.judgeCalls.length}` +
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

  // Every judge call of the run (all runs of all pairs), for the
  // paired latency read and the error count.
  const calls = results.flatMap((r) => r.runs.flatMap((run) => run.judgeCalls));
  const answeredMs = calls
    .filter((c) => c.outcome.kind === 'decision')
    .map((c) => c.wallMs);

  const overridden = Object.keys(options).length > 0;
  const summary = {
    probedAt: new Date().toISOString(),
    pairs: results.length,
    thresholds: overridden ? options : 'production defaults (no overrides passed)',
    embedding: embedding.id,
    judgeModel: resolvedJudge.label,
    judgeCalls: {
      total: calls.length,
      decided: answeredMs.length,
      unparsed: calls.filter((c) => c.outcome.kind === 'unparsed').length,
      threw: calls.filter((c) => c.outcome.kind === 'threw').length,
      p50Ms: percentile(answeredMs, 50),
      p95Ms: percentile(answeredMs, 95),
    },
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

  // The default (local) geometry keeps the historical `results.json`
  // name; alternate-embedder runs write alongside it so geometries can
  // be diffed without clobbering the series. A judge arm or an explicit
  // option set names all three axes, so every arm of a paired run gets
  // its own file.
  const embedderArm = (process.env['RND_EMBEDDER_MODULE'] ?? '').length > 0;
  const judgeArm = (process.env['RND_JUDGE_MODULE'] ?? '').length > 0;
  const optionTag = [
    options.topK !== undefined ? `k${options.topK}` : '',
    options.minCosineForRerank !== undefined ? `c${options.minCosineForRerank}` : '',
    options.judgeThreshold !== undefined ? `j${options.judgeThreshold}` : '',
  ].join('');
  const outName =
    judgeArm || overridden
      ? `results-${[embedding.id, resolvedJudge.label, optionTag]
          .filter((part) => part.length > 0)
          .join('-')
          .replace(/[^\w.-]+/g, '_')}.json`
      : embedderArm
        ? `results-${embedding.id}.json`
        : 'results.json';
  writeFileSync(
    pathResolve(OUT_DIR, outName),
    JSON.stringify({ summary, results }, null, 2),
  );
  process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`full detail → ${pathResolve(OUT_DIR, outName)}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `match-precision-probe failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
