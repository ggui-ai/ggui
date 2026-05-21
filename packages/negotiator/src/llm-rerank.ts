/**
 * LLM rerank — Tier-2 precision oracle for the blueprint registry.
 *
 * Given a user's UI request (intent + contract structure) and a set
 * of candidate cached blueprints retrieved by RAG, ask a fast LLM
 * (Haiku 4.5) which candidate (if any) matches. Returns a structured
 * decision so the caller can branch deterministically.
 *
 * This module is the precision half of the blueprint-first
 * architecture: RAG retrieval is high-recall but low-precision (bge-
 * small confuses topic-similar but UI-divergent prompts); the LLM
 * judge restores precision. Combined break-even hit rate is ~10%;
 * realistic workloads observe 30-70%.
 */
import { summarizeContract } from '@ggui-ai/protocol';
import type { LLMCaller, ToolSchema } from './llm-caller.js';

/**
 * One candidate blueprint for the LLM judge to consider.
 *
 * Keep this struct narrow — the prompt sees only what's necessary
 * to decide match-vs-no-match. componentCode is intentionally
 * absent (huge, distracting, doesn't change the decision).
 */
export interface RerankCandidate {
  /** Stable blueprint id — echoed back as `matchId` on a hit. */
  readonly id: string;
  /** The intent prose that originally produced this blueprint. */
  readonly cachedIntent: string;
  /**
   * One-line summary of the blueprint's contract surface. Format
   * matches `summarizeContract()` below — `slots=...; actions=...;
   * streams=...; props=...` so the judge sees the structural shape
   * without the JSON noise.
   */
  readonly cachedContractSummary: string;
  /**
   * Optional retrieval signal. Higher cosine biases the prior, but
   * the judge's decision is the source of truth. Pass-through so
   * the prompt can include "candidate retrieved at cosine X" if the
   * judge would benefit (default: omit).
   */
  readonly cosine?: number;
}

/** Decision returned by the LLM judge. */
export interface RerankDecision {
  /**
   * The matched candidate's id, or `null` if no candidate matches.
   * `null` means "all candidates rejected — generate fresh."
   */
  readonly matchId: string | null;
  /**
   * Confidence on `[0, 1]`. Caller compares against a threshold (e.g.
   * 0.6) before treating the decision as a hit. Returned even when
   * matchId is null so callers can log "judge declined with
   * confidence X."
   */
  readonly confidence: number;
  /**
   * Free-text reason from the judge. Surface in trace logs so
   * operators can debug "why didn't this hit." Truncate at the
   * persistence boundary if cardinality is a concern.
   */
  readonly reason: string;
  /** Wall-clock latency of the LLM call. */
  readonly latencyMs: number;
  /**
   * Token cost of the call — for the cache-trace sink and cost
   * accounting. Implementations that can't surface token counts may
   * report `{input: 0, output: 0}` and the cost-per-call gate will
   * have to be measured externally.
   */
  readonly tokenCost: { readonly input: number; readonly output: number };
}

/** Query the user's request the judge is matching against. */
export interface RerankQuery {
  readonly intent: string;
  readonly contractSummary: string;
}

const RERANK_SYSTEM_PROMPT = `You match user UI requests against previously-generated UI blueprints. Each blueprint was produced for a past request and stored. Decide whether any candidate produces the SAME USEFUL UI for the current request.

MATCH means the candidate would correctly satisfy the user's current request — same UI shape (component types, layout pattern), same wire surface (slot names, action names), same intended user task, and same load-bearing parameters (dates, months, ranges, enum values).

NO-MATCH means the candidate would NOT satisfy the user's current request — different task (haiku composer vs tweet draft, login vs signup), different UI shape (form vs list vs dashboard), or load-bearing parameters differ (calendar-Jan vs calendar-Mar — same contract, different value).

Visual style differences alone (minimal vs ornate, dense vs spacious) DO NOT block a match — the user can refine those after they get a working UI.

Output exactly ONE tool call with your decision. confidence is a number in [0, 1]. matchId is a string from the candidate ids, or null when no candidate matches. reason is a short sentence the operator can use to debug.`;

const RERANK_TOOL: ToolSchema = {
  name: 'submit_rerank_decision',
  description:
    'Submit your match-vs-no-match decision over the candidates.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      matchId: {
        type: ['string', 'null'],
        description:
          "ID of the matching candidate, or null when no candidate matches. MUST be one of the candidate ids supplied in the user message, or null.",
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description:
          'Confidence in the decision on [0, 1]. Caller will compare against a threshold before treating it as a hit.',
      },
      reason: {
        type: 'string',
        description:
          'Brief explanation — one sentence — that the operator can use to debug match decisions.',
      },
    },
    required: ['matchId', 'confidence', 'reason'],
  },
};

function buildUserMessage(
  query: RerankQuery,
  candidates: readonly RerankCandidate[],
): string {
  const lines: string[] = [];
  lines.push('CURRENT REQUEST');
  lines.push(`  intent: ${query.intent}`);
  lines.push(`  contract: ${query.contractSummary}`);
  lines.push('');
  lines.push(`CANDIDATES (${candidates.length})`);
  for (const c of candidates) {
    lines.push('---');
    lines.push(`  id: ${c.id}`);
    lines.push(`  intent: ${truncate(c.cachedIntent, 280)}`);
    lines.push(`  contract: ${c.cachedContractSummary}`);
    if (typeof c.cosine === 'number') {
      lines.push(`  cosine: ${c.cosine.toFixed(3)}`);
    }
  }
  lines.push('');
  lines.push(
    'Decide: does any candidate match the current request? Submit via the tool.',
  );
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// Re-export `summarizeContract` from protocol for backwards-compatible
// access through `@ggui-ai/negotiator/llm-rerank` consumers (the
// canonical home is `@ggui-ai/protocol` — both the registry storage
// and the rerank prompt depend on it). Kept as a re-export so the
// existing test imports here keep working.
export { summarizeContract };

interface RerankToolInput {
  matchId: string | null;
  confidence: number;
  reason: string;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseToolInput(
  raw: unknown,
  candidateIds: ReadonlySet<string>,
): { matchId: string | null; confidence: number; reason: string } {
  if (raw === null || typeof raw !== 'object') {
    return { matchId: null, confidence: 0, reason: 'parse-failed: non-object tool input' };
  }
  const obj = raw as Record<string, unknown>;
  const reason = typeof obj['reason'] === 'string' ? obj['reason'] : '';
  const confidence = clampConfidence(obj['confidence']);
  const rawMatchId = obj['matchId'];
  if (rawMatchId === null || rawMatchId === undefined) {
    return { matchId: null, confidence, reason };
  }
  if (typeof rawMatchId !== 'string') {
    return {
      matchId: null,
      confidence: 0,
      reason: `parse-failed: matchId was ${typeof rawMatchId}, not string|null`,
    };
  }
  if (!candidateIds.has(rawMatchId)) {
    return {
      matchId: null,
      confidence: 0,
      reason: `judge returned matchId='${rawMatchId}' but that id is not in the candidate set — treating as no-match`,
    };
  }
  return { matchId: rawMatchId, confidence, reason };
}

/**
 * Run the rerank judge against a query + candidate list.
 *
 * Empty candidate list short-circuits without an LLM call — the
 * caller's RAG step decided there's nothing close enough; we don't
 * burn tokens to confirm it.
 *
 * Operational errors (LLM throws, parse fails) collapse to a `null`
 * match with confidence=0 and a diagnostic reason. The caller treats
 * confidence-below-threshold as no-match anyway, so the failure mode
 * lands on the cold-gen path automatically.
 */
export async function rerankCandidates(
  deps: { readonly llm: LLMCaller },
  query: RerankQuery,
  candidates: readonly RerankCandidate[],
): Promise<RerankDecision> {
  const startedAt = Date.now();
  if (candidates.length === 0) {
    return {
      matchId: null,
      confidence: 0,
      reason: 'no candidates — short-circuited without LLM call',
      latencyMs: Date.now() - startedAt,
      tokenCost: { input: 0, output: 0 },
    };
  }

  const userMessage = buildUserMessage(query, candidates);
  const candidateIds = new Set(candidates.map((c) => c.id));

  if (typeof deps.llm.callStructured !== 'function') {
    return {
      matchId: null,
      confidence: 0,
      reason:
        'llm-rerank: provider does not support callStructured (forced tool-use). Bind a structured-capable LLMCaller (Anthropic adapter via mcp-server) for rerank.',
      latencyMs: Date.now() - startedAt,
      tokenCost: { input: 0, output: 0 },
    };
  }

  let toolInput: unknown;
  try {
    toolInput = await deps.llm.callStructured<RerankToolInput>(
      RERANK_SYSTEM_PROMPT,
      userMessage,
      RERANK_TOOL,
      512,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      matchId: null,
      confidence: 0,
      reason: `llm-rerank: callStructured threw — ${message}`,
      latencyMs: Date.now() - startedAt,
      tokenCost: { input: 0, output: 0 },
    };
  }

  const parsed = parseToolInput(toolInput, candidateIds);
  return {
    matchId: parsed.matchId,
    confidence: parsed.confidence,
    reason: parsed.reason,
    latencyMs: Date.now() - startedAt,
    // Token cost surfacing requires LLMCaller-level instrumentation
    // we don't have today. Default to zero; the cost gate is measured
    // out-of-band from billing data during the probe.
    tokenCost: { input: 0, output: 0 },
  };
}

// Re-exports for the eval harness — keep public surface explicit.
export { RERANK_SYSTEM_PROMPT, RERANK_TOOL };
