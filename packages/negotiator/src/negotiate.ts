/**
 * Negotiator — top-level orchestrator over the public storage +
 * decision-engine seams.
 *
 * Pipeline:
 *   1. RAG search (per-scope + optional shared pool) via
 *      {@link ragSearch} — composes `EmbeddingProvider.embed` +
 *      `VectorStore.query` from `@ggui-ai/mcp-server-core`.
 *   2. Read session state (optional injectable).
 *   3. Fast-path for exact blueprint hits — skip the decision LLM.
 *   4. Otherwise call {@link makeDecision} with the RAG candidates and
 *      session stack; fold the picked blueprint's pool provenance into
 *      the return value.
 *
 * Timing logs (stable format — consumed by benchmarks):
 *   [negotiate] embedding: Xms | search: Xms | candidates: N
 *   [negotiate] candidate: <id8> | <description> | hash=<h16>
 *   [negotiate] FAST PATH: blueprint=<id8> hash=<h12> | LLM decision: 0ms | total: Xms
 *   [negotiate] LLM PATH: action=X blueprint=<id8> hash=<h12> | LLM decision: Xms | total: Xms
 *
 * ### Public surface + semver weight
 *
 * Exported:
 *   - `negotiate(deps, input)` — runtime orchestrator.
 *   - `NegotiateDeps` — injection shape (embedding / vectors / llm +
 *     optional session-state reader + optional progress callback).
 *   - `NegotiateInput` — agent signal + config.
 *   - `NegotiateConfig` — minimum fields the orchestrator actually
 *     reads. Pool selection is expressed as `includeSharedPool:
 *     boolean` rather than a `poolMode` enum, so callers decide
 *     shared-pool inclusion explicitly at each call site.
 *   - `NegotiateResult` — the decision result returned to callers.
 *
 * ### Why this package, not `mcp-server-core`
 *
 * `mcp-server-core` locks storage/runtime seams MCP server
 * implementers bind against (`EmbeddingProvider`, `VectorStore`,
 * `Negotiator`). `negotiate()` is a *composition* over those seams —
 * decision-engine semantics, not a new seam. Adding it to
 * `mcp-server-core` would drag the LLM prompts + tool-schemas into a
 * package whose job is to stay minimal and runtime-agnostic.
 */

import type {
  DataContract,
  NegotiatorAlternative,
  NegotiatorDecision,
} from '@ggui-ai/protocol';
import type {
  EmbeddingProvider,
  VectorStore,
} from '@ggui-ai/mcp-server-core';
import type { LLMCaller } from './llm-caller.js';
import type { SessionState } from './session.js';
import type { NegotiatorDecisionInput } from './decision-input.js';
import { ragSearch } from './rag-search.js';
import { makeDecision } from './decision.js';

/** Empty session state for cold starts and benchmarks. */
const EMPTY_SESSION: SessionState = {
  stack: [],
  conversationHistory: [],
};

/**
 * Minimum config the orchestrator reads.
 *
 * `appId` is the primary RAG scope (per-app registered UIs live
 * here). `sessionId` keys the optional `readSessionState` callback.
 * `includeSharedPool` (default `false`) gates whether to also search
 * the global `"shared"` pool in parallel and fold its hits into the
 * candidate set.
 */
export interface NegotiateConfig {
  appId: string;
  sessionId: string;
  /** Also search the shared (global) pool in parallel. Default `false`. */
  includeSharedPool?: boolean;
}

/**
 * Agent signal + config for a single negotiation call. Bundled as one
 * object so future additive fields don't force yet another positional
 * arg on the public API.
 */
export interface NegotiateInput {
  agent: {
    /** Raw data the agent wants to render. */
    data?: Record<string, unknown>;
    /** Natural-language prompt. Used as RAG query when present. */
    prompt?: string;
    /** Free-form context string or structured map. Forwarded to the decision LLM. */
    context?: string | Record<string, unknown>;
    /**
     * Names of MCP tools the agent invokes (catalog seed). Merged
     * into the decision's `agentCapabilities.tools` deterministically
     * (see {@link makeDecision}).
     */
    agentTools?: string[];
    /**
     * Browser-capability gadget catalog the app exposes (default
     * `STDLIB_GADGETS`, operator-extensible). Forwarded to
     * the decision LLM so it knows which gadget bindings are
     * available; canonical entries enrich partial LLM output
     * downstream (see {@link mergeGadgets}).
     */
    gadgets?: readonly import('@ggui-ai/protocol').GadgetDescriptor[];
  };
  config: NegotiateConfig;
}

/**
 * Dependencies injected into {@link negotiate}. Public field names
 * (`embedding` / `vectors` / `llm`) align with {@link ragSearch}'s
 * already-shipped deps shape.
 */
export interface NegotiateDeps {
  /**
   * Embedding provider for the RAG search step. **Optional** —
   * when omitted (paired with omitted `vectors`), the negotiator
   * skips RAG entirely and runs the decision LLM against an empty
   * candidate list. OSS without vector-store infrastructure binds
   * with `embedding: undefined, vectors: undefined` and still gets
   * useful negotiation via the decision LLM alone.
   *
   * `embedding` and `vectors` are paired — both must be present for
   * RAG to fire, or both must be absent. A half-bound config (one
   * present, one missing) is a configuration bug; the search step
   * skips and logs a warn rather than erroring, but consumers
   * should fix the binding.
   */
  embedding?: EmbeddingProvider;
  vectors?: VectorStore;
  llm: LLMCaller;
  /** Optional: read current session state for stack-aware decisions. */
  readSessionState?: (sessionId: string) => Promise<SessionState | null>;
  /** Optional: surface pipeline progress to consumers. */
  onProgress?: (phase: string, summary: string) => void;
}

/**
 * Output shape — mirrors the legacy `DecisionResult` so the
 * back-compat shim can return the object verbatim. See `NegotiateDeps`
 * semver note.
 */
export interface NegotiateResult {
  decision: NegotiatorDecision;
  alternatives: NegotiatorAlternative[];
  /** Stored contract hash from blueprint match — deterministic pool key. */
  storedContractHash?: string;
  /** Which pool the matched blueprint's code lives in. */
  storedPoolSource?: 'shared' | 'private';
  embeddingLatencyMs: number;
  searchLatencyMs: number;
  decisionLatencyMs: number;
}

/**
 * Orchestrate one negotiation call — RAG search, session read, fast
 * path, decision LLM. See module docstring for the pipeline outline.
 */
export async function negotiate(
  deps: NegotiateDeps,
  input: NegotiateInput,
): Promise<NegotiateResult> {
  const { agent, config } = input;
  const negotiateStart = Date.now();
  deps.onProgress?.('negotiating', 'Analyzing request...');

  // Step 1: RAG search (per-app + optional shared pool in parallel).
  // `embedding` + `vectors` are optional. When either is missing,
  // ragSearch is a no-op (returns empty options + 0 latency); the
  // decision LLM runs against zero candidates and falls back to
  // "create" via its standard branching. OSS without RAG infrastructure
  // gets useful negotiation from the decision LLM alone.
  const queryText = agent.prompt ?? JSON.stringify(agent.data ?? {});
  const emptyResult = { options: [], embeddingLatencyMs: 0, searchLatencyMs: 0 };
  const ragDeps =
    deps.embedding !== undefined && deps.vectors !== undefined
      ? { embedding: deps.embedding, vectors: deps.vectors }
      : undefined;
  const [appResult, sharedResult] = await Promise.all([
    ragDeps
      ? ragSearch(ragDeps, { prompt: queryText, scope: config.appId })
      : Promise.resolve(emptyResult),
    ragDeps && config.includeSharedPool
      ? ragSearch(ragDeps, { prompt: queryText, scope: 'shared' })
      : Promise.resolve(emptyResult),
  ]);

  const ragResult = {
    options: [...appResult.options, ...sharedResult.options],
    embeddingLatencyMs: Math.max(
      appResult.embeddingLatencyMs,
      sharedResult.embeddingLatencyMs,
    ),
    searchLatencyMs: Math.max(
      appResult.searchLatencyMs,
      sharedResult.searchLatencyMs,
    ),
  };

  // eslint-disable-next-line no-console
  console.log(
    `[negotiate] embedding: ${ragResult.embeddingLatencyMs}ms | search: ${ragResult.searchLatencyMs}ms | candidates: ${ragResult.options.length}`,
  );
  for (const opt of ragResult.options) {
    // eslint-disable-next-line no-console
    console.log(
      `[negotiate] candidate: ${opt.blueprintId?.slice(-8) ?? 'none'} | ${opt.description.slice(0, 80)} | hash=${opt.contractHash?.slice(0, 16) ?? 'none'}`,
    );
  }

  deps.onProgress?.(
    'blueprint_search',
    ragResult.options.length > 0
      ? `Found ${ragResult.options.length} blueprint candidate${ragResult.options.length > 1 ? 's' : ''}`
      : 'No blueprints found',
  );

  // Step 2: Read session state (falls back to EMPTY_SESSION).
  const sessionState = deps.readSessionState
    ? ((await deps.readSessionState(config.sessionId)) ?? EMPTY_SESSION)
    : EMPTY_SESSION;

  // Step 3: Fast-path for high-confidence exact matches — skip decision LLM.
  const exactOpt = ragResult.options.find((opt) =>
    opt.description.includes('exact'),
  );
  if (exactOpt) {
    const stackHasSameType = sessionState.stack.some(
      (item) => item.prompt && agent.prompt && item.prompt === agent.prompt,
    );
    const action = stackHasSameType ? ('update' as const) : ('create' as const);
    const totalMs = Date.now() - negotiateStart;

    // eslint-disable-next-line no-console
    console.log(
      `[negotiate] FAST PATH: blueprint=${exactOpt.blueprintId?.slice(-8)} hash=${exactOpt.contractHash?.slice(0, 12) ?? 'none'} | LLM decision: 0ms | total: ${totalMs}ms`,
    );
    deps.onProgress?.('deciding', 'Exact match found — fast path');

    // The agent's prompt is the outer-pipeline intent (`intent` is not
    // a contract field). Fallback contract is the empty contract — the
    // four-spec surface is omitted entirely (no props, no actions, no
    // streams, no context).
    const fallbackContract: DataContract = {};
    return {
      decision: {
        action,
        reasoning: `Exact blueprint match (high confidence). ${action === 'update' ? 'Updating existing view.' : 'Creating new view.'}`,
        blueprintId: exactOpt.blueprintId,
        contract: exactOpt.contract ?? fallbackContract,
      },
      alternatives: [],
      storedContractHash: exactOpt.contractHash,
      storedPoolSource: exactOpt.poolSource,
      embeddingLatencyMs: ragResult.embeddingLatencyMs,
      searchLatencyMs: ragResult.searchLatencyMs,
      decisionLatencyMs: 0,
    };
  }

  // Step 4: Build decision input + call the LLM.
  const decisionInput: NegotiatorDecisionInput = {
    agentData: agent.data,
    agentPrompt: agent.prompt,
    agentContext: agent.context,
    agentTools: agent.agentTools,
    ...(agent.gadgets
      ? { gadgets: agent.gadgets }
      : {}),
    sessionState,
    blueprintCandidates: ragResult.options.map((opt) => ({
      blueprintId: opt.blueprintId ?? opt.id,
      description: opt.description,
      contract: opt.contract,
      similarity:
        parseFloat(opt.description.match(/similarity: (\d+)%/)?.[1] ?? '0') / 100,
      verdict: (opt.description.includes('exact') ? 'exact' : 'partial') as
        | 'exact'
        | 'partial',
    })),
  };

  deps.onProgress?.('deciding', 'Choosing the best UI approach...');
  const decisionStart = Date.now();
  const { decision, alternatives } = await makeDecision(decisionInput, deps.llm);
  const decisionLatencyMs = Date.now() - decisionStart;
  const totalMs = Date.now() - negotiateStart;

  const pickedBlueprint = decision.blueprintId
    ? ragResult.options.find(
        (opt) => (opt.blueprintId ?? opt.id) === decision.blueprintId,
      )
    : undefined;

  // eslint-disable-next-line no-console
  console.log(
    `[negotiate] LLM PATH: action=${decision.action} blueprint=${decision.blueprintId?.slice(-8) ?? 'none'} hash=${pickedBlueprint?.contractHash?.slice(0, 12) ?? 'none'} | LLM decision: ${decisionLatencyMs}ms | total: ${totalMs}ms`,
  );

  return {
    decision,
    alternatives,
    storedContractHash: pickedBlueprint?.contractHash,
    storedPoolSource: pickedBlueprint?.poolSource,
    embeddingLatencyMs: ragResult.embeddingLatencyMs,
    searchLatencyMs: ragResult.searchLatencyMs,
    decisionLatencyMs,
  };
}
