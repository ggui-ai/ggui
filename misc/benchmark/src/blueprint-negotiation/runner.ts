/**
 * Blueprint-negotiation v0 runner — one run per corpus case.
 *
 * Drives `negotiate()` from `@ggui-ai/negotiator` directly with
 * in-memory deps. No LLM API calls: the stub `LLMCaller` returns a
 * deterministic `action: 'create'` response for miss cases, and hit
 * cases skip the LLM via the RAG fast path (exact score ≥ 0.45).
 *
 * What this exercises (real code paths):
 *   - `ragSearch` — embedding → vector query → filter + sort
 *   - fast-path short-circuit on high-confidence matches
 *   - decision-LLM fallback shape (via stub) for misses
 *
 * What this does NOT exercise (pre-generation discipline):
 *   - no generation loop, no compile, no component code
 *   - no A2UI / preview emission
 *   - no real-LLM decision grading — `reasoning` from the stub is
 *     static; only the deterministic `action` + `blueprintId`
 *     presence/absence matters for the bench
 */

import { createHash, randomUUID } from 'node:crypto';
import { negotiate, type NegotiateDeps } from '@ggui-ai/negotiator';
import type { LLMCaller } from '@ggui-ai/negotiator';
import type { EmbeddingProvider } from '@ggui-ai/mcp-server-core';
import { InMemoryVectorStore } from '@ggui-ai/mcp-server-core/in-memory';

import type { BlueprintSeedEntry, NegotiationCase } from './corpus.js';
import {
  deriveNegotiationMetrics,
  type ErrorClass,
  type NegotiationRunResult,
  type NegotiationRunTags,
  type ObservedOutcome,
} from './types.js';

export interface NegotiationRunnerDeps {
  /** Clock override. Defaults to `performance.now()` for sub-ms resolution. */
  readonly now?: () => number;
}

/**
 * Drive one negotiation case through `negotiate()` and classify the
 * outcome against the case's pre-registered expectation.
 */
export async function runNegotiationCase(
  kase: NegotiationCase,
  runIndex: number,
  deps: NegotiationRunnerDeps = {},
): Promise<NegotiationRunResult> {
  const now = deps.now ?? defaultNow;
  const errors: string[] = [];

  // Per-case app scope — keeps vector stores isolated between runs so
  // a hit case's entries can't leak into a clean-miss case run.
  const appId = `bench-neg-${kase.id}-${randomUUID().slice(0, 8)}`;
  const vectors = new InMemoryVectorStore();
  // Orthogonal embedder (not MockEmbeddingProvider): we want the
  // decision layer under test, not the embedder's similarity math.
  // Exact-string match → cosine 1.0 (fast-path); any other string →
  // cosine 0 (clean miss). See `BenchOrthogonalEmbedder` below.
  const embedding = new BenchOrthogonalEmbedder();
  const llm = buildStubLLMCaller();

  // Pre-seed the vector store. Each entry embeds its prompt under
  // the blueprintId as the vector key — the negotiator's RAG search
  // will surface it if the query-prompt is semantically similar.
  await seedVectorStore({ vectors, embedding, appId, entries: kase.seedEntries });

  const decisionStartedAt = now();
  let observedOutcome: ObservedOutcome;
  let observedBlueprintId: string | null;
  let errorClass: ErrorClass | null = null;
  let embeddingLatencyMs = 0;
  let searchLatencyMs = 0;
  let decisionLatencyMs = 0;

  try {
    const result = await negotiate(
      { embedding, vectors, llm } satisfies NegotiateDeps,
      {
        agent: { prompt: kase.prompt },
        config: {
          appId,
          sessionId: `sess-${kase.id}`,
          includeSharedPool: false,
        },
      },
    );
    embeddingLatencyMs = result.embeddingLatencyMs;
    searchLatencyMs = result.searchLatencyMs;
    decisionLatencyMs = result.decisionLatencyMs;

    observedBlueprintId = result.decision.blueprintId ?? null;
    observedOutcome = classifyOutcome({
      observedBlueprintId,
      expectedBlueprintId: kase.expectedBlueprintId,
      expectedOutcome: kase.expectedOutcome,
    });
  } catch (e) {
    observedBlueprintId = null;
    observedOutcome = 'error';
    errorClass = classifyError(e);
    errors.push(`negotiate threw: ${stringifyError(e)}`);
  }

  const decisionCompletedAt = now();

  const tags: NegotiationRunTags = {
    caseId: kase.id,
    registryMode: kase.registryMode,
    expectedOutcome: kase.expectedOutcome,
    observedOutcome,
    expectedBlueprintId: kase.expectedBlueprintId,
    observedBlueprintId,
    arbitrationObserved: false, // v0 — multi-registry not benchable
    confidence: null, // v0 — negotiator doesn't surface numeric confidence
    errorClass,
  };

  const checkpoints = { decisionStartedAt, decisionCompletedAt };

  return {
    caseId: kase.id,
    runIndex,
    checkpoints,
    stageLatencies: { embeddingLatencyMs, searchLatencyMs, decisionLatencyMs },
    tags,
    derived: deriveNegotiationMetrics(checkpoints, tags),
    errors,
  };
}

/**
 * Classify the outcome by comparing observed vs expected. The four
 * values are deliberately distinct — `wrong_hit` is NOT collapsed
 * into `miss`, per the v0 contract.
 */
export function classifyOutcome(params: {
  readonly observedBlueprintId: string | null;
  readonly expectedBlueprintId: string | null;
  readonly expectedOutcome: 'hit' | 'miss';
}): ObservedOutcome {
  const { observedBlueprintId, expectedBlueprintId, expectedOutcome } = params;
  if (observedBlueprintId === null) return 'miss';
  // Observed a hit:
  if (expectedOutcome === 'miss') return 'wrong_hit'; // shouldn't have hit at all
  // Expected hit, observed hit — check blueprint id matches.
  if (expectedBlueprintId !== null && observedBlueprintId !== expectedBlueprintId) {
    return 'wrong_hit';
  }
  return 'hit';
}

/**
 * Seed the vector store with corpus entries. The embedded text
 * mirrors what the negotiator later embeds at query time
 * (`agent.prompt`), so cosine similarity with semantically-close
 * queries climbs above the fast-path threshold (0.45).
 *
 * Metadata follows `rag-search.ts::buildOption` — the minimum set
 * the negotiator reads when materializing a candidate.
 */
async function seedVectorStore(params: {
  readonly vectors: InMemoryVectorStore;
  readonly embedding: EmbeddingProvider;
  readonly appId: string;
  readonly entries: readonly BlueprintSeedEntry[];
}): Promise<void> {
  for (const entry of params.entries) {
    const vector = await params.embedding.embed(entry.prompt);
    await params.vectors.putVector(params.appId, {
      key: entry.blueprintId,
      vector,
      metadata: {
        prompt: entry.prompt,
        intent: entry.prompt,
        category: entry.category,
        featured: false,
      },
    });
  }
}

/**
 * Bench-local embedder. Each unique input text hashes to a single
 * dimension in a 4096-length basis; that dimension is set to 1, the
 * rest to 0. Two inputs thus produce either cosine 1 (identical
 * strings — or vanishingly-rare hash collisions) or cosine 0.
 *
 * Why not reuse `MockEmbeddingProvider`? The mock is a sine hash —
 * unrelated strings routinely score above the negotiator's fast-path
 * threshold (0.45), turning what should be clean misses into
 * wrong_hits. The embedder's math is not what this bench tests. A
 * binary-similarity embedder makes the corpus's hit/miss labeling
 * deterministic: the negotiator's decision logic is what's under
 * observation.
 *
 * Collision probability at 4096 dims with <10 distinct strings: ~0.001%.
 */
class BenchOrthogonalEmbedder implements EmbeddingProvider {
  readonly id = 'bench-orthogonal';
  readonly dimensions = 4096;

  async embed(text: string): Promise<number[]> {
    const hash = createHash('sha256').update(text).digest();
    // Take the first 4 bytes → 32-bit int, modulo dimensions.
    const idx = hash.readUInt32BE(0) % this.dimensions;
    const vec = new Array<number>(this.dimensions).fill(0);
    vec[idx] = 1;
    return vec;
  }
}

/**
 * Deterministic stub LLMCaller for the bench. Returns a fixed
 * `action: 'create'` JSON response so miss cases route through
 * the decision path without firing a real LLM.
 *
 * Both `call` (text) and `callStructured` (tool-use) paths are
 * implemented: the negotiator prefers structured output when the
 * caller provides it, so we satisfy both.
 */
function buildStubLLMCaller(): LLMCaller {
  const stubDecision = {
    action: 'create' as const,
    reasoning: 'bench stub — no real LLM call',
    contract: { intent: 'bench' },
  };
  return {
    async call(
      _system: string,
      _user: string,
      _max?: number,
    ): Promise<string> {
      return JSON.stringify(stubDecision);
    },
    async callStructured<T>(
      _system: string,
      _user: string,
      _tool: { name: string; description: string; input_schema: Record<string, unknown> },
      _max?: number,
    ): Promise<T> {
      return stubDecision as unknown as T;
    },
  };
}

function classifyError(e: unknown): ErrorClass {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  if (msg.includes('embed')) return 'embedding_failed';
  if (msg.includes('vector') || msg.includes('query')) return 'vector_query_failed';
  if (msg.includes('llm') || msg.includes('model')) return 'llm_failed';
  if (msg.includes('timeout')) return 'timeout';
  return 'other';
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function defaultNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
