/**
 * `ensureConformingContract` — the negotiator's create-path guarantee.
 *
 * Given the agent's PROPOSED draft, return a contract that is
 * GUARANTEED to pass the deterministic gate (`lintContract` with zero
 * errors), so the handshake backstop (`validateContract`) never throws
 * on it. This is the "Propose vs Commit" forgiving-handshake core
 * shared by every negotiator implementation (OSS llm-backed + cloud
 * bedrock) so the behavior cannot drift between deployments:
 *
 *   - draft already conforms → return it verbatim          (origin: 'agent')
 *   - draft has errors       → repair-in-place via the bounded LLM loop,
 *                              seeded with the draft + the deterministic
 *                              findings, looping until the gate is green
 *                              (origin: 'synth')
 *   - repair impossible      → minimal conforming contract (`{}`) + loud
 *     (LLM down / provider      error findings; STILL origin 'synth';
 *      can't synth / budget     NEVER throws.
 *      exhausted)
 *
 * Determinism lives in the GATE (`lintContract`), never in the repair.
 * The repair LLM is non-deterministic, but the loop only exits when the
 * deterministic gate is green — the same shape ui-gen uses to tolerate
 * non-deterministic code generation behind a deterministic self_check.
 *
 * Cache/blueprint matching is NOT this function's job — the caller
 * (negotiator `decide()`) runs its deployment-specific cache match
 * FIRST and only falls through to here on a miss. That preserves the
 * "cache-first, repair-second" ordering the negotiator contract
 * mandates.
 */
import {
  lintContract,
  dataContractSchema,
  type DataContract,
  type GadgetDescriptor,
  type SuggestionFinding,
} from '@ggui-ai/protocol';
import type { LLMCaller } from './llm-caller.js';
import { synthesizeContract } from './synthesize-contract.js';
import { normalizeDraft } from './normalize-draft.js';

export interface EnsureConformingResult {
  /** A contract guaranteed to pass `lintContract` with zero errors. */
  readonly contract: DataContract;
  /**
   * - `'agent'` — the draft was already conforming; returned verbatim.
   * - `'synth'` — the draft had errors; this is the repaired result
   *   (or the minimal-conforming fallback when repair was impossible).
   */
  readonly origin: 'agent' | 'synth';
  /**
   * How the conforming contract was produced — finer-grained than
   * `origin`, for telemetry (the efficiency tiers):
   *   - `verbatim`      — draft was clean; returned as-is (origin agent).
   *   - `normalized`    — deterministic fix only, NO LLM (origin synth).
   *   - `llm-repair`    — the bounded LLM repair loop ran (origin synth).
   *   - `fallback-empty`— unrepairable; minimal `{}` contract (origin synth).
   */
  readonly method: 'verbatim' | 'normalized' | 'llm-repair' | 'fallback-empty';
  /**
   * Findings surfaced to the agent. On `origin: 'agent'`, any hygiene
   * warnings on the (valid) draft. On `origin: 'synth'`, the ERROR
   * findings that rejected the agent's draft — so the agent-side model
   * learns what it got wrong, even though we repaired it.
   */
  readonly findings: readonly SuggestionFinding[];
  /** Operator- + LLM-readable explanation. */
  readonly reasoning: string;
}

/** Trivially-valid last-resort contract — all four specs omitted. */
const EMPTY_CONTRACT: DataContract = {};

export async function ensureConformingContract(
  deps: { readonly llm: LLMCaller },
  args: {
    /** Untrusted: the agent's draft may not be a valid DataContract. */
    readonly draft: unknown;
    readonly intent: string;
    readonly appGadgets?: readonly GadgetDescriptor[];
  },
): Promise<EnsureConformingResult> {
  const lint = lintContract(args.draft);
  const warnFindings: SuggestionFinding[] = lint.warnings.map(
    (w): SuggestionFinding => ({
      code: w.code,
      severity: 'warn',
      path: w.path,
      message: w.message,
    }),
  );

  // Fast path — draft already conforms. Deterministic, no LLM call.
  // `lint.errors.length === 0` implies the shape phase passed, so the
  // strict parse cannot throw — it just re-derives the typed DataContract
  // from the untrusted input (validator returns the typed shape; no cast).
  if (lint.errors.length === 0) {
    return {
      contract: dataContractSchema.parse(args.draft),
      origin: 'agent',
      method: 'verbatim',
      findings: warnFindings,
      reasoning:
        'agent draft passed validateContract; accepted verbatim (origin: agent)',
    };
  }

  const errorFindings: SuggestionFinding[] = lint.errors.map(
    (e): SuggestionFinding => ({
      code: e.code,
      severity: 'error',
      path: e.path,
      message: e.message,
    }),
  );

  // L3 — deterministic normalization tier. Most agent malformations are
  // mechanical (stray illegal wrapper keys, non-canonical schema types).
  // Fix them WITHOUT an LLM: strip + canonicalize, re-lint, and if the
  // draft now conforms, return it verbatim-but-cleaned. Faithful (no
  // reshape risk — the agent's specs are preserved exactly) and free (no
  // LLM call). Semantic deficiencies fall through to the repair loop.
  const normalized = normalizeDraft(args.draft);
  const normLint = lintContract(normalized);
  if (normLint.errors.length === 0) {
    return {
      contract: dataContractSchema.parse(normalized),
      origin: 'synth',
      method: 'normalized',
      findings: errorFindings,
      reasoning:
        'normalized the agent draft deterministically (stripped invalid keys / canonicalized schema types, no LLM) to pass validateContract',
    };
  }

  // Repair loop on the NORMALIZED draft (mechanical errors already
  // fixed) with only the REMAINING (semantic) findings — so the LLM
  // patches what reasoning is genuinely needed for, from a clean start.
  const synth = await synthesizeContract(deps, args.intent, {
    ...(args.appGadgets ? { appGadgets: args.appGadgets } : {}),
    draft: normalized,
    draftFindings: normLint.errors.map((e) => ({
      code: e.code,
      path: e.path,
      message: e.message,
    })),
  });

  if (
    synth.contract !== null &&
    lintContract(synth.contract).errors.length === 0
  ) {
    return {
      contract: synth.contract,
      origin: 'synth',
      method: 'llm-repair',
      findings: errorFindings,
      reasoning: `repaired the agent draft to pass validateContract — ${synth.reason}`,
    };
  }

  // Repair impossible (LLM down, provider can't synthesize, or the
  // repair budget exhausted). We still MUST return a conforming
  // contract — the handshake never hard-fails. Minimal conforming
  // contract + loud findings so the agent can re-issue a corrected
  // contract via ggui_render override if it needs the declared specs.
  return {
    contract: EMPTY_CONTRACT,
    origin: 'synth',
    method: 'fallback-empty',
    findings: errorFindings,
    reasoning: `could not repair the agent draft within budget (${synth.reason}); returning a minimal conforming contract — re-issue a corrected contract via ggui_render override if you need the declared specs`,
  };
}
