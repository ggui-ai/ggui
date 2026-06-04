/**
 * Advanced UI generator factory (`ui-gen-advanced-opus-4-7`).
 *
 * See `./index.ts` for the design narrative. This file owns the
 * iterative two-stage loop and the {@link UiGenerator} adapter that
 * registers under the slug `ui-gen-advanced-opus-4-7`.
 *
 * Loop structure (max 3 iterations, threshold 0.8, always-persist):
 *
 *   for round in 1..max:
 *     result = innerGenerator.generate(input + accumulatedFeedback)
 *     if !result.ok:                      # producer failure
 *       return result                     # don't try to validate code we don't have
 *     fastIssues = runRenderCheck(result.sourceCode, contract)
 *     if fastIssues.failed:
 *       feedback += buildFastComplaints(fastIssues)
 *       continue
 *     slowFailures = validateContractBehavior(result.compiledCode, contract)
 *     if slowFailures:
 *       feedback += buildSlowComplaints(slowFailures)
 *       continue
 *     return result                        # both stages clean
 *   # max rounds exhausted — return last result + validatorScore<1
 *
 * The slow stage is skipped when the fast stage fails (no point
 * spinning up Chromium for code we already know is broken) AND when
 * the contract has no `actionSpec` entries (no behaviour to verify).
 *
 * Generator identity is baked in — slug `ui-gen-advanced-opus-4-7`,
 * tier `advanced`, model `opus-4-7`. Operators can NOT override slug
 * via this factory; build a different factory if you want a different
 * tier/model pairing.
 */
import type {
  GenerationMetadata,
  GeneratorTier,
  UiGenerateInput,
  UiGenerateResult,
  UiGenerator,
} from '@ggui-ai/mcp-server-core';
import type { DataContract, JsonObject } from '@ggui-ai/protocol';
import type {
  BehaviorFailure,
  PlaywrightModule,
} from '@ggui-ai/ui-visual-tester';
import {
  validateContractBehavior,
  PlaywrightNotAvailableError,
} from '@ggui-ai/ui-visual-tester';
import { createUiGenerator } from '../create-ui-generator.js';
import type { CreateUiGeneratorOptions } from '../create-ui-generator.js';
import {
  runRenderCheck,
  type RenderCheckIssue,
} from '../harness/check/runtime-render/index.js';
import {
  buildFastStageComplaints,
  buildSlowStageComplaints,
  buildIterationFeedback,
  type StageDiagnostic,
} from './feedback.js';

/** Generator identity — slug, tier, and model. */
export const ADVANCED_GENERATOR_SLUG = 'ui-gen-advanced-opus-4-7' as const;
export const ADVANCED_GENERATOR_TIER: GeneratorTier = 'advanced';
export const ADVANCED_GENERATOR_MODEL = 'opus-4-7' as const;

/**
 * Re-exported under a friendlier name for callers wiring deploys.
 *
 * `import { createAdvancedUiGenerator, type AdvancedGeneratorPlaywright } from '@ggui-ai/ui-gen/advanced';`
 */
export type AdvancedGeneratorPlaywright = PlaywrightModule;

/**
 * Per-stage diagnostic surface for callers that want to inspect what
 * happened on each iteration (bench framework, console, operator
 * dashboards). The validator scores are 0..1: 1.0 = clean pass.
 */
export interface ValidationStageResult {
  readonly stage: 'fast' | 'slow';
  readonly ok: boolean;
  readonly score: number;
  /** Per-issue diagnostics, format depends on stage. */
  readonly diagnostics: readonly StageDiagnostic[];
  readonly durationMs: number;
}

export interface ValidationIteration {
  readonly round: number;
  readonly fast: ValidationStageResult;
  /** Slow stage runs only if fast passed AND contract has actionSpec. */
  readonly slow?: ValidationStageResult;
  /** Aggregated validator score for this round (0..1). */
  readonly score: number;
}

/**
 * Optional structured diagnostic returned per iteration. Surfaced
 * via `metadata.attempts` on the generator result and as part of
 * the validator-score metadata persisted to the blueprint store.
 */
export type ValidationDiagnostic = ValidationIteration;

export interface CreateAdvancedUiGeneratorOptions
  extends Pick<
    CreateUiGeneratorOptions,
    'maxTurns' | 'maxAttempts' | 'maxEvalRounds' | 'qualityConfig'
  > {
  /**
   * Playwright module. Required at GENERATE time — the factory itself
   * does not throw if absent, but every generate() call will. This is
   * deliberate: a deploy config that drops the field surfaces the gap
   * via a clean PlaywrightNotAvailableError on the first render, rather
   * than at server boot when no caller can react.
   */
  readonly playwright: AdvancedGeneratorPlaywright | undefined;

  /**
   * Maximum iterations of the gen → validate → regen loop. Hard cap
   * at 5; values above are clamped. Default 3 per MVB plan §D3.
   */
  readonly maxIterations?: number;

  /**
   * Pass threshold for the iteration loop. When the aggregated score
   * meets or exceeds this, the loop returns. 0..1 (default 0.8 per
   * MVB plan §D3). Used by the loop, not the blueprint store —
   * blueprint store decides whether to mark a sub-threshold variant
   * as matchable.
   */
  readonly passThreshold?: number;

  /**
   * Inner generator. Defaults to a fresh `createUiGenerator({tier:
   * 'advanced', model: 'opus-4-7'})` so the BYOK route resolves to an
   * Opus model on Anthropic. Tests can inject a stub.
   *
   * The inner generator's identity (slug/tier/model) is irrelevant —
   * this advanced wrapper exposes its own fixed identity.
   */
  readonly innerGenerator?: UiGenerator;

  /**
   * Mockup props passed to the fast-stage `runRenderCheck`. Optional;
   * when absent the check uses an empty `{}` (most generated
   * components are robust to empty props). Bench callers can pass
   * the same `commit.props` they'd use for the visual probe.
   */
  readonly fastStageMockupProps?: JsonObject;

  /**
   * Slow-stage timeout per action (ms). Default 5000.
   */
  readonly slowStageTimeoutMs?: number;
}

const DEFAULT_MAX_ITERATIONS = 3;
const HARD_MAX_ITERATIONS = 5;
const DEFAULT_PASS_THRESHOLD = 0.8;
const DEFAULT_SLOW_TIMEOUT_MS = 5000;

/**
 * Create the advanced generator. Returns a {@link UiGenerator}
 * registrable under the slug `ui-gen-advanced-opus-4-7`.
 *
 * @example
 * import { chromium } from 'playwright-core';
 * import { createInMemoryGeneratorRegistry } from '@ggui-ai/mcp-server-core/in-memory';
 * import { createAdvancedUiGenerator } from '@ggui-ai/ui-gen/advanced';
 *
 * const registry = createInMemoryGeneratorRegistry();
 * registry.register(createAdvancedUiGenerator({ playwright: { chromium } }));
 */
export function createAdvancedUiGenerator(
  options: CreateAdvancedUiGeneratorOptions,
): UiGenerator {
  const maxIterations = clampIterations(
    options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  );
  const passThreshold = options.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const slowStageTimeoutMs =
    options.slowStageTimeoutMs ?? DEFAULT_SLOW_TIMEOUT_MS;
  const mockupProps: JsonObject = options.fastStageMockupProps ?? {};

  // Default inner: a separate createUiGenerator instance configured for
  // advanced tier. Tests inject `innerGenerator` directly.
  const innerGenerator: UiGenerator =
    options.innerGenerator ??
    createUiGenerator({
      tier: 'advanced',
      model: 'opus-4-7',
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.maxAttempts !== undefined
        ? { maxAttempts: options.maxAttempts }
        : {}),
      ...(options.maxEvalRounds !== undefined
        ? { maxEvalRounds: options.maxEvalRounds }
        : {}),
      ...(options.qualityConfig !== undefined
        ? { qualityConfig: options.qualityConfig }
        : {}),
    });

  return {
    slug: ADVANCED_GENERATOR_SLUG,
    tier: ADVANCED_GENERATOR_TIER,
    model: ADVANCED_GENERATOR_MODEL,
    generate: async (input: UiGenerateInput): Promise<UiGenerateResult> => {
      const playwright = options.playwright;
      if (
        playwright === undefined ||
        playwright === null ||
        typeof (playwright as { chromium?: unknown }).chromium !== 'object'
      ) {
        throw new PlaywrightNotAvailableError();
      }

      const iterations: ValidationIteration[] = [];
      let accumulatedFeedback = '';
      let lastResult: UiGenerateResult | null = null;
      let lastScore = 0;

      for (let round = 1; round <= maxIterations; round++) {
        const iterInput = augmentInputWithFeedback(input, accumulatedFeedback);
        const result = await innerGenerator.generate(iterInput);
        lastResult = result;

        if (!result.ok) {
          // Producer failure — don't try to validate code we don't have.
          // Caller decides whether to retry; we surface the failure as-is.
          return result;
        }

        const iter = await runValidationStages({
          result,
          contract: input.contract,
          mockupProps,
          playwright,
          slowStageTimeoutMs,
          round,
        });
        iterations.push(iter);
        lastScore = iter.score;

        if (iter.score >= passThreshold) {
          return attachValidatorMetadata(result, iterations, iter.score);
        }

        // Aggregate complaints for the next round.
        const newDiagnostics: StageDiagnostic[] = [
          ...iter.fast.diagnostics,
          ...(iter.slow?.diagnostics ?? []),
        ];
        accumulatedFeedback += buildIterationFeedback(newDiagnostics, round);
      }

      // Max iterations exhausted. Return the last result (always-persist
      // per MVB plan §D3 — the blueprint store decides whether to mark
      // sub-threshold variants matchable).
      if (lastResult === null) {
        // Unreachable: maxIterations >= 1 guaranteed by clampIterations.
        throw new Error(
          'createAdvancedUiGenerator: max iterations exhausted without producing a result',
        );
      }
      return attachValidatorMetadata(lastResult, iterations, lastScore);
    },
  };
}

function clampIterations(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > HARD_MAX_ITERATIONS) return HARD_MAX_ITERATIONS;
  return Math.floor(n);
}

/**
 * Append the accumulated validator feedback to the user prompt. The
 * inner generator receives the augmented `request.prompt`; everything
 * else (rendering hint, contract, BYOK key) is forwarded verbatim.
 */
function augmentInputWithFeedback(
  input: UiGenerateInput,
  feedback: string,
): UiGenerateInput {
  if (feedback.length === 0) return input;
  return {
    ...input,
    request: {
      ...input.request,
      prompt: input.request.prompt + feedback,
    },
  };
}

interface RunValidationStagesInput {
  readonly result: Extract<UiGenerateResult, { ok: true }>;
  readonly contract?: DataContract;
  readonly mockupProps: JsonObject;
  readonly playwright: PlaywrightModule;
  readonly slowStageTimeoutMs: number;
  readonly round: number;
}

async function runValidationStages(
  input: RunValidationStagesInput,
): Promise<ValidationIteration> {
  const fast = await runFastStage(input);
  if (!fast.ok) {
    return { round: input.round, fast, score: fast.score };
  }

  // Skip slow stage when the contract has no actionSpec entries — no
  // behaviour to verify, slow stage would just return ok with empty
  // failures (and spinning up Chromium would be wasteful).
  const actionNames = input.contract?.actionSpec
    ? Object.keys(input.contract.actionSpec)
    : [];
  if (actionNames.length === 0) {
    return { round: input.round, fast, score: fast.score };
  }

  const slow = await runSlowStage(input);
  const score = aggregateScore(fast, slow);
  return { round: input.round, fast, slow, score };
}

async function runFastStage(
  input: RunValidationStagesInput,
): Promise<ValidationStageResult> {
  const start = Date.now();
  const sourceCode = input.result.response.sourceCode;
  if (typeof sourceCode !== 'string' || sourceCode.length === 0) {
    // Without source we can't run the fast stage probe — it operates
    // on TSX, not compiled JS. Treat as unverified but non-failing
    // (the slow stage still gates).
    return {
      stage: 'fast',
      ok: true,
      score: 0.5,
      diagnostics: [],
      durationMs: Date.now() - start,
    };
  }
  const checkInput = {
    sourceCode,
    mockupProps: input.mockupProps,
    ...(input.contract ? { contract: input.contract } : {}),
  };
  const result = await runRenderCheck(checkInput);
  const diagnostics: StageDiagnostic[] = buildFastStageComplaints(
    result.issues as readonly RenderCheckIssue[],
  );
  return {
    stage: 'fast',
    ok: result.ok,
    score: scoreFromRenderCheck(result.issues),
    diagnostics,
    durationMs: Date.now() - start,
  };
}

async function runSlowStage(
  input: RunValidationStagesInput,
): Promise<ValidationStageResult> {
  const start = Date.now();
  const contract = input.contract;
  if (contract === undefined) {
    return {
      stage: 'slow',
      ok: true,
      score: 1.0,
      diagnostics: [],
      durationMs: Date.now() - start,
    };
  }
  const slowResult = await validateContractBehavior({
    componentCode: input.result.response.componentCode,
    contract,
    timeoutMs: input.slowStageTimeoutMs,
    playwright: input.playwright,
  });
  const diagnostics: StageDiagnostic[] = buildSlowStageComplaints(
    slowResult.failures as readonly BehaviorFailure[],
  );
  return {
    stage: 'slow',
    ok: slowResult.ok,
    score: scoreFromSlowStage(contract, slowResult.failures),
    diagnostics,
    durationMs: Date.now() - start,
  };
}

/**
 * Map runtime-render issues to a 0..1 score.
 *
 *   ok + 0 issues          → 1.0
 *   ok + warns only        → 0.85
 *   single failed issue    → 0.4
 *   multiple failed issues → 0.2 .. 0.4
 *
 * The numbers are coarse — the threshold gate is 0.8, so the score's
 * job is just to land above or below it. Per-issue gradations matter
 * less than getting the pass/fail boundary right.
 */
function scoreFromRenderCheck(issues: readonly RenderCheckIssue[]): number {
  const failed = issues.filter((i) => i.outcome === 'failed').length;
  const unverified = issues.filter((i) => i.outcome === 'unverified').length;
  if (failed === 0 && unverified === 0) return 1.0;
  if (failed === 0) return 0.85;
  if (failed === 1) return 0.4;
  if (failed === 2) return 0.3;
  return 0.2;
}

/**
 * Map slow-stage failures to a 0..1 score.
 *
 *   no failures                       → 1.0
 *   failures < half of actions        → 0.5
 *   half-or-more actions failed       → 0.2
 *
 * Like the fast-stage score, this is coarse — what matters is whether
 * we cross the pass threshold or not.
 */
function scoreFromSlowStage(
  contract: DataContract,
  failures: readonly BehaviorFailure[],
): number {
  if (failures.length === 0) return 1.0;
  const actionCount = contract.actionSpec
    ? Object.keys(contract.actionSpec).length
    : 0;
  if (actionCount === 0) return 1.0;
  const failureRatio = failures.length / actionCount;
  return failureRatio >= 0.5 ? 0.2 : 0.5;
}

function aggregateScore(
  fast: ValidationStageResult,
  slow?: ValidationStageResult,
): number {
  if (slow === undefined) return fast.score;
  // Weighted toward slow — fast gates entry but slow's behavioural
  // signal is the load-bearing quality check.
  return 0.4 * fast.score + 0.6 * slow.score;
}

function attachValidatorMetadata(
  result: UiGenerateResult,
  iterations: readonly ValidationIteration[],
  finalScore: number,
): UiGenerateResult {
  if (!result.ok) return result;
  // Surface the validator score + iteration count via metadata.attempts.
  // Future MVB phases will persist `validatorScore` to the blueprint
  // store via a separate side channel; for now we keep the
  // UiGenerator interface unchanged and tunnel through `attempts`.
  const newAttempts = iterations.length;
  const metadata: GenerationMetadata = {
    ...result.metadata,
    attempts: newAttempts,
  };
  // Stash diagnostics on the metadata via a structural pass-through.
  // Consumers that want detail can downcast to inspect `iterations`;
  // `GenerationMetadata` itself is not widened to carry these fields.
  const widened = metadata as GenerationMetadata & {
    validatorScore?: number;
    validatorIterations?: readonly ValidationIteration[];
  };
  widened.validatorScore = finalScore;
  widened.validatorIterations = iterations;
  return { ...result, metadata: widened };
}
