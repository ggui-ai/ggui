// oss/misc/benchmark/src/contract-synthesis/runner.ts
//
// Drives the REAL negotiator contract-synthesis path over the corpus and
// records convergence metrics. Two production-faithful entry points:
//
//   via='ensure' (DEFAULT, production-faithful):
//     `ensureConformingContract` — the exact function decide-handshake
//     calls. Runs the deterministic pipeline first: lint→verbatim,
//     normalizeDraft→normalized (BOTH zero-LLM), and only on a semantic
//     miss the bounded LLM repair loop (seeded with the normalized draft
//     + draftFindings). The headline KPI here is the `method` tier — a
//     draft fixed by `verbatim`/`normalized` is instant and free, which
//     is the truest "keep it short" outcome.
//
//   via='synth' (prompt-tuning lens):
//     `synthesizeContract` directly with the raw draft + no draftFindings.
//     Exposes the raw `attempts` count (1..5) — useful when iterating on
//     SYNTHESIZE_SYSTEM_PROMPT itself, but it OVER-states production cost
//     because it skips normalize + finding-seeding.
//
// The conformance gate is pure deterministic code, so "converged" is
// objective: we independently re-lint the produced contract here rather
// than trusting either function's own exit.

import { lintContract, type DataContract } from '@ggui-ai/protocol';
import {
  synthesizeContract,
  ensureConformingContract,
  type LLMCaller,
  type SynthesizeContractResult,
  type EnsureConformingResult,
} from '@ggui-ai/negotiator';
import type { ContractSynthCase } from './corpus.js';

export type SynthVia = 'ensure' | 'synth';

/** Outcome of one (model × case) run. */
export interface ContractSynthRunResult {
  readonly caseId: string;
  readonly archetype: string;
  readonly mode: 'cold' | 'repair';
  readonly via: SynthVia;
  readonly model: string;
  /** Provider key ('claude' | 'openai' | 'google'). */
  readonly provider: string;
  /** Did the produced contract independently pass lintContract (0 errors)? */
  readonly converged: boolean;
  /**
   * Whether an LLM was invoked at all. On the ensure path,
   * verbatim/normalized resolve with ZERO LLM calls — the ideal. On the
   * synth path, any attempt ≥ 1 means the LLM ran.
   */
  readonly llmUsed: boolean;
  /**
   * ensure-path method tier: 'verbatim' | 'normalized' (both zero-LLM) |
   * 'llm-repair' | 'fallback-empty'. Undefined on the synth path.
   */
  readonly method?: EnsureConformingResult['method'];
  /**
   * synth-path LLM attempt count (0 early-skip, 1 one-shot, up to 5).
   * Undefined on the ensure path (ensureConformingContract doesn't
   * surface it).
   */
  readonly attempts?: number;
  readonly oneShot: boolean;
  readonly capHit: boolean;
  /** Wall-clock latency (ms). From the result on synth; timed here on ensure. */
  readonly latencyMs: number;
  /** Independent lint error count on the final contract (0 when converged). */
  readonly residualErrors: number;
  /** Whether the case met its advisory target. */
  readonly metTarget: boolean;
  /** The function's own reason/reasoning string (for triage). */
  readonly reason: string;
  /** Set when the run threw (network, etc.) rather than declined cleanly. */
  readonly error?: string;
}

const ATTEMPT_CAP = 5; // mirrors MAX_SYNTH_ATTEMPTS in synthesize-contract.ts

/** synth-path run: raw `synthesizeContract`, exposes `attempts`. */
async function runViaSynth(
  llm: LLMCaller,
  model: string,
  provider: string,
  testCase: ContractSynthCase,
): Promise<ContractSynthRunResult> {
  const base = {
    caseId: testCase.id,
    archetype: testCase.archetype,
    mode: testCase.mode,
    via: 'synth' as const,
    model,
    provider,
  };
  let result: SynthesizeContractResult;
  try {
    result = await synthesizeContract(
      { llm },
      testCase.intent,
      testCase.draft !== undefined ? { draft: testCase.draft } : undefined,
    );
  } catch (err) {
    return {
      ...base,
      converged: false,
      llmUsed: true,
      attempts: 0,
      oneShot: false,
      capHit: false,
      latencyMs: 0,
      residualErrors: -1,
      metTarget: false,
      reason: 'threw',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const contract: DataContract | null = result.contract;
  const residualErrors =
    contract === null ? -1 : lintContract(contract).errors.length;
  const converged = contract !== null && residualErrors === 0;
  return {
    ...base,
    converged,
    llmUsed: result.attempts >= 1,
    attempts: result.attempts,
    oneShot: converged && result.attempts === 1,
    capHit: result.attempts >= ATTEMPT_CAP && !converged,
    latencyMs: result.latencyMs,
    residualErrors,
    metTarget: converged && result.attempts <= testCase.targetMaxAttempts,
    reason: result.reason,
  };
}

/**
 * ensure-path run: production-faithful `ensureConformingContract`.
 *
 * Cold cases (no draft) map to an EMPTY agent draft `{}` — which is what
 * the handshake passes when the agent proposes no specs. `{}` lints clean,
 * so it resolves `verbatim` with zero LLM (the production reality: an
 * agent that declares nothing gets an empty conforming contract). The
 * intent is still threaded so the repair loop can use it when a malformed
 * draft needs semantic repair.
 */
async function runViaEnsure(
  llm: LLMCaller,
  model: string,
  provider: string,
  testCase: ContractSynthCase,
): Promise<ContractSynthRunResult> {
  const base = {
    caseId: testCase.id,
    archetype: testCase.archetype,
    mode: testCase.mode,
    via: 'ensure' as const,
    model,
    provider,
  };
  const draft = testCase.draft !== undefined ? testCase.draft : {};
  const started = Date.now();
  let result: EnsureConformingResult;
  try {
    result = await ensureConformingContract(
      { llm },
      { draft, intent: testCase.intent },
    );
  } catch (err) {
    return {
      ...base,
      converged: false,
      llmUsed: true,
      oneShot: false,
      capHit: false,
      latencyMs: Date.now() - started,
      residualErrors: -1,
      metTarget: false,
      reason: 'threw',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const latencyMs = Date.now() - started;
  const residualErrors = lintContract(result.contract).errors.length;
  // `fallback-empty` returns a trivially-valid `{}` — it passes lint but
  // represents "gave up", so it is NOT counted as converged.
  const realConverge = residualErrors === 0 && result.method !== 'fallback-empty';
  const zeroLlm = result.method === 'verbatim' || result.method === 'normalized';
  return {
    ...base,
    converged: realConverge,
    llmUsed: !zeroLlm,
    method: result.method,
    oneShot: zeroLlm, // zero-LLM resolution is the ensure-path "fast" win
    capHit: result.method === 'fallback-empty',
    latencyMs,
    residualErrors,
    metTarget: realConverge,
    reason: result.reasoning,
  };
}

/** Run one case against one model's LLMCaller via the chosen path. */
export async function runContractSynthCase(
  llm: LLMCaller,
  model: string,
  provider: string,
  testCase: ContractSynthCase,
  via: SynthVia,
): Promise<ContractSynthRunResult> {
  return via === 'synth'
    ? runViaSynth(llm, model, provider, testCase)
    : runViaEnsure(llm, model, provider, testCase);
}

/**
 * Run every case for one model with bounded concurrency. Per-case failures
 * are captured (never reject the whole batch).
 */
export async function runModel(
  llm: LLMCaller,
  model: string,
  provider: string,
  cases: readonly ContractSynthCase[],
  via: SynthVia,
  concurrency = 4,
): Promise<ContractSynthRunResult[]> {
  const results: ContractSynthRunResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= cases.length) return;
      const testCase = cases[index];
      if (testCase === undefined) return;
      results.push(await runContractSynthCase(llm, model, provider, testCase, via));
    }
  }
  const workerCount = Math.min(concurrency, cases.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
