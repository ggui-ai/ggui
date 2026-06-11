// core/src/benchmarks/multi-sdk/runner.ts
//
// Benchmark CLI runner — operator-facing console.log is the
// legitimate output mechanism here (telemetry to stdout per row).
/* eslint-disable no-console */

import type { DataContract, JsonObject } from "@ggui-ai/protocol";
import {
  MODEL_REGISTRY,
  gadgetExportName,
  listContractGadgets,
  HOOK_NAME_RE,
  type ModelId,
} from "@ggui-ai/protocol";
import type { AnyAdapterConfig } from "@ggui-ai/ui-gen/adapters/base";
import { GeneratorAdapter, createGeneratorTools } from "@ggui-ai/ui-gen/adapters";
import { dispatchGeneration } from "@ggui-ai/ui-gen/adapters/generation-dispatch";
import type { AdapterResult } from "@ggui-ai/ui-gen/adapters/types";
import { DEFAULT_QUALITY_CONFIG } from "@ggui-ai/ui-gen/evaluation";
import type { EvalResult } from "@ggui-ai/ui-gen/evaluation";
import { injectContracts, injectRenderingContext } from "@ggui-ai/ui-gen/harness/prompts";
import { inferPropsSpecFromSampleData } from "@ggui-ai/ui-gen/check";
import { BENCHMARK_COMMITS } from "./commits.js";
import { generateReport } from "./reporter.js";
import type {
  BenchmarkCommit,
  BenchmarkCommitVariance,
  BenchmarkConfig,
  BenchmarkReport,
  BenchmarkRunnerConfig,
  BenchmarkRunResult,
  BenchmarkVariant,
  PostGenerationResult,
} from "./types.js";
import {
  ADVANCED_GENERATOR_SLUG,
  DEFAULT_GENERATOR_SLUG,
} from "./types.js";
import type { BenchmarkStorage } from "./storage/types.js";
import { getDefaultVariants } from "./variants.js";

/**
 * Orchestrates parallel benchmark runs across multiple SDK adapters.
 *
 * Usage:
 * ```ts
 * const runner = new BenchmarkRunner({ concurrency: 3 });
 * runner.registerAdapter(new ClaudeRawAdapter({ apiKey: '...' }));
 * runner.registerAdapter(new OpenAiRawAdapter({ apiKey: '...' }));
 * const report = await runner.run();
 * ```
 */
export class BenchmarkRunner {
  private adapters = new Map<string, GeneratorAdapter>();
  private adapterConfigs = new Map<string, AnyAdapterConfig>();
  private storage?: BenchmarkStorage;
  private config: Required<
    Pick<
      BenchmarkConfig,
      | "concurrency"
      | "passThreshold"
      | "skipEvaluation"
      | "timeoutMs"
      | "maxAttempts"
      | "maxEvalRounds"
      | "qualityMode"
    >
  > &
    BenchmarkConfig;

  /**
   * Generator slugs the runner knows how to dispatch. Unknown slugs
   * short-circuit to an error result so the comparison matrix still
   * records a cell — silently routing to the default would hide the
   * misconfiguration.
   */
  private readonly recognizedGenerators = new Set<string>([
    DEFAULT_GENERATOR_SLUG,
    ADVANCED_GENERATOR_SLUG,
  ]);

  /**
   * Whether Playwright is wired into the runner. Required by
   * `ui-gen-advanced-opus-4-7`; when `false`, advanced variants
   * short-circuit with a SKIP error result. Default `false` —
   * operators opt in by passing `playwright` to the constructor.
   */
  private readonly playwrightAvailable: boolean;

  constructor(config: BenchmarkConfig | BenchmarkRunnerConfig = {}) {
    // Detect new-style config by checking for 'storage' field
    if ('storage' in config && config.storage) {
      this.storage = config.storage;
    }

    this.config = {
      ...config,
      concurrency: config.concurrency ?? 36,
      passThreshold: config.passThreshold ?? 70,
      skipEvaluation: config.skipEvaluation ?? false,
      timeoutMs: config.timeoutMs ?? 600_000,
      maxAttempts: config.maxAttempts ?? 15,
      maxEvalRounds: config.maxEvalRounds ?? 3,
      qualityMode: config.qualityMode ?? 'fast',
    };

    // Presence of `playwright` config (or any object with a
    // `chromium` field) flags the advanced generator as available.
    // We do NOT instantiate it eagerly — the dispatch path stays
    // through dispatchGeneration; presence just gates the
    // advanced-variant SKIP behavior.
    const cfg = config as { playwright?: { chromium?: unknown } };
    this.playwrightAvailable =
      cfg.playwright !== undefined &&
      cfg.playwright !== null &&
      typeof cfg.playwright === 'object' &&
      cfg.playwright.chromium !== undefined;
  }

  /**
   * Register an SDK adapter for benchmarking.
   */
  registerAdapter(adapter: GeneratorAdapter, adapterConfig?: AnyAdapterConfig): void {
    const key = `${adapter.provider}-${adapter.mode}`;
    this.adapters.set(key, adapter);
    if (adapterConfig) this.adapterConfigs.set(key, adapterConfig);
    if (!this.adapters.has(adapter.provider)) {
      this.adapters.set(adapter.provider, adapter);
      if (adapterConfig) this.adapterConfigs.set(adapter.provider, adapterConfig);
    }
  }

  /**
   * Run the full benchmark suite.
   * Optionally accepts variants and commits to override config/defaults.
   */
  async run(params?: {
    variants?: BenchmarkVariant[];
    commits?: BenchmarkCommit[];
  }): Promise<BenchmarkReport> {
    const startTime = Date.now();
    const variants = params?.variants ?? this.config.variants ?? getDefaultVariants();
    const commits = params?.commits ?? this.config.commits ?? BENCHMARK_COMMITS;

    // Build task queue: variant × commit
    const tasks = variants.flatMap((variant) => commits.map((commit) => ({ variant, commit })));

    // Filter to available adapters
    const runnableTasks = tasks.filter((t) => {
      const adapter = this.resolveAdapter(t.variant);
      return adapter?.isAvailable();
    });

    const skippedCount = tasks.length - runnableTasks.length;
    if (skippedCount > 0) {
      console.log(
        `[benchmark] Skipping ${skippedCount}/${tasks.length} tasks (adapter not available)`
      );
    }

    // 2026-04-27: probe pre-warm now happens inside dispatchGeneration
    // (parallel with the LLM cold call). Bench previously tried to
    // pre-warm directly here but the imports resolved against the bench
    // package's own node_modules where happy-dom isn't installed —
    // dispatchGeneration's pre-warm runs from inside ui-gen where the
    // resolution succeeds.

    // Execute with concurrency limit, reporting progress after each completion
    let completedCount = 0;
    const total = runnableTasks.length;
    const results = await runWithConcurrency(
      runnableTasks.map((task) => async () => {
        const result = await this.runSingle(task.variant, task.commit);
        completedCount++;
        this.config.onProgress?.({ completed: completedCount, total });
        return result;
      }),
      this.config.concurrency
    );

    const totalDurationMs = Date.now() - startTime;

    // ── Aggregate breakdown summary ──
    // Per-provider totals across all commits. Prints after every [benchmark] line,
    // gives a one-shot view of where turns/time went. Machine-parseable.
    const provSums = new Map<string, {
      n: number; impl: number; patch: number; evalFix: number;
      pass: number; patchInvalid: number; selfCheckFail: number; diffFail: number;
      evalRounds: number; llmMs: number; toolMs: number; evalMs: number; totalMs: number;
    }>();
    for (const r of results) {
      if (!r) continue;
      if (!r.generation) continue;
      const b = (r.generation as { breakdown?: import('@ggui-ai/ui-gen/harness/result-types').GenerationResult['breakdown'] }).breakdown;
      if (!b) continue;
      const key = r.variant.sdkName;
      const s = provSums.get(key) ?? {
        n: 0, impl: 0, patch: 0, evalFix: 0,
        pass: 0, patchInvalid: 0, selfCheckFail: 0, diffFail: 0,
        evalRounds: 0, llmMs: 0, toolMs: 0, evalMs: 0, totalMs: 0,
      };
      s.n++;
      s.impl += b.phases.impl; s.patch += b.phases.patch; s.evalFix += b.phases.evalFix;
      s.pass += b.outcomes.pass; s.patchInvalid += b.outcomes.patchInvalid;
      s.selfCheckFail += b.outcomes.selfCheckFail; s.diffFail += b.outcomes.diffFail;
      s.evalRounds += b.evalRounds;
      s.llmMs += b.llmMs; s.toolMs += b.toolMs; s.evalMs += b.evalMs;
      s.totalMs += r.generation.generationTimeMs;
      provSums.set(key, s);
    }
    if (provSums.size > 0) {
      console.log(`\n[benchmark] === Aggregate breakdown (per provider, n commits) ===`);
      for (const [prov, s] of provSums) {
        const avg = (v: number) => (v / s.n).toFixed(0);
        console.log(
          `[benchmark] ${prov} n=${s.n} | ` +
            `avgMs=${avg(s.totalMs)} avgLlmMs=${avg(s.llmMs)} avgToolMs=${avg(s.toolMs)} avgEvalMs=${avg(s.evalMs)} | ` +
            `turns: impl=${s.impl} patch=${s.patch} evalFix=${s.evalFix} | ` +
            `outcomes: pass=${s.pass} patchInvalid=${s.patchInvalid} selfCheckFail=${s.selfCheckFail} diffFail=${s.diffFail} | ` +
            `evalRounds=${s.evalRounds}`
        );
      }
    }

    return generateReport(results, totalDurationMs);
  }

  /**
   * Run a single variant × commit benchmark.
   */
  private async runSingle(
    variant: BenchmarkVariant,
    commit: BenchmarkCommit
  ): Promise<BenchmarkRunResult> {
    // Resolve generator slug ahead of time so every return path
    // (adapter-missing, generator-missing, success, catch) can record
    // it. Default to the OSS seed; unknown slugs fall through to an
    // explicit error result below.
    const generatorSlug = resolveGeneratorSlug(variant);

    const adapter = this.resolveAdapter(variant);
    if (!adapter) {
      return {
        variant,
        commit,
        generation: null,
        evaluation: null,
        estimatedCostUsd: 0,
        error: `No adapter registered for ${variant.sdkName}${variant.mode ? `/${variant.mode}` : ""}`,
        timestamp: new Date().toISOString(),
        generator: generatorSlug,
      };
    }

    // ── Generator dispatch resolution ──────────────────────────
    // The runner can route a variant through one of several
    // registered generators. The default seed
    // (`ui-gen-default-haiku-4-5`) goes through the existing
    // `dispatchGeneration` path; the advanced generator
    // (`ui-gen-advanced-opus-4-7`) requires Playwright. When the
    // bench env doesn't have Playwright wired, the advanced variant
    // short-circuits to an error result so the matrix still has a
    // row for it.
    //
    // The runner does NOT instantiate `createAdvancedUiGenerator`
    // itself. Callers wanting the advanced loop should compose
    // `createAdvancedUiGenerator` from `@ggui-ai/ui-gen/advanced` at
    // the application level and feed the bench corpus through that
    // composition; the bench framework's generator dimension is
    // book-keeping, not a runtime swap.
    if (generatorSlug === ADVANCED_GENERATOR_SLUG) {
      const playwrightAvailable = this.playwrightAvailable;
      if (!playwrightAvailable) {
        const msg =
          `Generator ${ADVANCED_GENERATOR_SLUG} requires Playwright. ` +
          `Pass { playwright: { chromium } } to the runner config to enable.`;
        console.log(`[benchmark] ${variant.id} × ${commit.id}: SKIP — ${msg}`);
        return {
          variant,
          commit,
          generation: null,
          evaluation: null,
          estimatedCostUsd: 0,
          error: msg,
          timestamp: new Date().toISOString(),
          generator: generatorSlug,
        };
      }
      // Playwright present: production composition would wrap
      // dispatchGeneration in the advanced iterative loop here. v1
      // routes the run through the same dispatchGeneration path so
      // the bench still produces a comparable cell. Operators
      // running the real advanced loop should compose at app level
      // and feed the results back via the storage backend.
    } else if (
      generatorSlug !== DEFAULT_GENERATOR_SLUG &&
      !this.recognizedGenerators.has(generatorSlug)
    ) {
      const msg =
        `Unknown generator slug ${JSON.stringify(generatorSlug)} on variant ${variant.id}. ` +
        `Recognized: ${[DEFAULT_GENERATOR_SLUG, ADVANCED_GENERATOR_SLUG].join(', ')}.`;
      console.log(`[benchmark] ${variant.id} × ${commit.id}: SKIP — ${msg}`);
      return {
        variant,
        commit,
        generation: null,
        evaluation: null,
        estimatedCostUsd: 0,
        error: msg,
        timestamp: new Date().toISOString(),
        generator: generatorSlug,
      };
    }

    try {
      console.log(`[benchmark] Running ${variant.id} × ${commit.id}...`);

      // Resolve model
      const modelId = variant.hybrid?.draftModel ?? variant.modelId;
      if (!modelId) {
        throw new Error(`No model ID for variant ${variant.id}`);
      }
      const nativeModelId = adapter.resolveModelId(modelId);

      const userPrompt = commit.prompt;

      // Build data contracts — prefer explicit contract from commit, fall back to inferring from props
      const contract: DataContract | undefined =
        commit.contract ??
        (commit.props ? { props: inferPropsSpecFromSampleData(commit.props) } : undefined);

      // ── Harness dispatch path ───────────────────────────
      // The harness owns its own system prompt (buildSystemPrompt in
      // harness/runtime.ts); we only need to assemble tools + the user
      // prompt context block here.

      // Build tools WITH contracts so self_check and compile_component can validate
      // Pass commit.props as sampleProps for render smoke test (realistic data, not synthesized)
      const allTools = createGeneratorTools({
        contract,
        sampleProps: commit.props as JsonObject | undefined,
      });

      // Pre-fetch context (primitives + design system) into the prompt
      // so all models have baseline context even if planner doesn't call tools.
      const prefetchedContext: string[] = [];
      for (const toolName of ["get_primitives", "get_design_system"]) {
        const tool = allTools.find((t) => t.name === toolName);
        if (tool) {
          const result = await tool.handler({});
          const text = result.content[0]?.text;
          if (text) prefetchedContext.push(text);
        }
      }

      const tools = allTools;
      const contextBlock =
        prefetchedContext.length > 0
          ? "\n\n---\n## Reference Context\nPrimitives and design system docs are pre-loaded below for reference.\n\n" +
            prefetchedContext.join("\n\n")
          : "";

      // ── Personalization variance block ────────────────────
      // When a commit carries a `variance` hint, project it into a
      // textual block appended to the user prompt. This is the only
      // channel through which the LLM sees the persona / aesthetic /
      // context signal — see the `BenchmarkCommit.variance`
      // docstring.
      const varianceBlock = formatVarianceBlock(commit.variance);

      // Run generation via the harness dispatch (provider-agnostic).
      // Renders the rendering-context preamble inline before the contracts
      // block; both are appended to the original prompt so the LLM sees
      // intent → context → contracts → primitives docs → variance hint.
      const harnessUserPrompt =
        // Thread the registered catalog so contract-context
        // user-prompt lines (`via useLeafletMap from <package>`)
        // resolve to the registered package, not the STDLIB default.
        // Pairs with the dispatch-level appGadgets thread above so
        // both prompt surfaces agree.
        injectContracts(
          injectRenderingContext(userPrompt, variant.rendering),
          contract,
          commit.appGadgets,
        ) +
        contextBlock +
        varianceBlock;
      const generation: AdapterResult | import('@ggui-ai/ui-gen/harness/result-types').GenerationResult =
        await withTimeout(
          dispatchGeneration({
            provider: variant.sdkName,
            userPrompt: harnessUserPrompt,
            model: nativeModelId,
            tools,
            maxTurns: BENCH_MAX_TURNS,
            models: variant.modelRoles,
            contract,
            fixtureProps: commit.props as JsonObject | undefined,
            originalPrompt: commit.prompt,
            evaluation: {
              enabled: true,
              passThreshold: this.config.passThreshold,
              provider: variant.sdkName,
            },
            maxAttempts: this.config.maxAttempts,
            maxEvalRounds: this.config.maxEvalRounds,
            qualityConfig: { ...DEFAULT_QUALITY_CONFIG, quality: this.config.qualityMode ?? 'fast' },
            // Thread the bench commit's registered wrapper catalog
            // so plugin-aware commits (Leaflet, Mapbox, …) see the
            // same `clientCapabilities — registered catalog` table
            // the production render handler would feed the code-gen
            // LLM. Absent → dispatch + skeleton fall through to
            // STDLIB seed (non-plugin commits stay byte-identical at
            // the prompt level).
            ...(commit.appGadgets !== undefined
              ? { appGadgets: commit.appGadgets }
              : {}),
            // Thread the per-package `.d.ts` for the registered
            // gadgets so the coding agent's typecheck resolves a
            // generated `import { LeafletMap } from '<package>'`
            // against the real wrapper types instead of `any`.
            ...(commit.gadgetTypes !== undefined
              ? { gadgetTypes: commit.gadgetTypes }
              : {}),
            // 2026-04-27: probe runs INSIDE the harness now (final-check
            // semantics — only fires on turns where deterministic checks
            // pass, then feeds back to the coding agent if it finds
            // wiring bugs). enableRuntimeRender defaults to true; bench
            // gets probe-as-gate behavior natively. The pre-warm at
            // dispatch entry overlaps the probe deps with the LLM cold
            // call so first-turn probe is fast.
          }),
          this.config.timeoutMs
        );

      // Calculate cost
      const estimatedCostUsd = calculateCost(modelId, generation.tokens);

      // Post-generation analysis (lightweight, no AWS needed)
      const postGeneration = runPostGeneration(generation, commit);

      // Capture three-tier evaluation from harness result
      const tierEvaluation: EvalResult | undefined =
        "evalResult" in generation ? (generation as { evalResult?: EvalResult }).evalResult : undefined;

      // ── Runtime-probe outcome extraction ──────────────────────────
      // 2026-04-27: probe runs INSIDE the harness during eval rounds
      // (post-self-check). Extract its outcome from tierEvaluation
      // issues — entries with subcategory starting `runtime:` are
      // probe-emitted.
      //
      // Three states:
      //   - SKIP: tierEvaluation absent (eval rounds didn't run because
      //     self-check failed and gen exited / maxEvalRounds=0)
      //   - PASS: eval ran, no probe issues with result=fail
      //   - FAIL: eval ran, ≥1 probe issue with result=fail
      let runtimeProbeResult: { passed: boolean; failures: number; warnings: number; skipped: boolean };
      if (!tierEvaluation) {
        runtimeProbeResult = { passed: false, failures: 0, warnings: 0, skipped: true };
        console.log(
          `  [runtime-probe] ${variant.id} × ${commit.id}: SKIP — eval rounds did not run`,
        );
      } else {
        const probeIssues = tierEvaluation.issues.filter((i) =>
          typeof i.subcategory === 'string' && i.subcategory.startsWith('runtime:'),
        );
        const probeFailCount = probeIssues.filter((i) => i.result === 'fail').length;
        const probeWarnCount = probeIssues.filter((i) => i.result === 'warn').length;
        runtimeProbeResult = {
          passed: probeFailCount === 0,
          failures: probeFailCount,
          warnings: probeWarnCount,
          skipped: false,
        };
        console.log(
          `  [runtime-probe] ${variant.id} × ${commit.id}: ` +
            `${runtimeProbeResult.passed ? 'PASS' : 'FAIL'} ` +
            `(fail=${probeFailCount} warn=${probeWarnCount})`,
        );
        // Log each probe issue's diagnostic so we can investigate the
        // patterns. These are real wiring bugs at the runtime level —
        // action-wiring missing, useStream subscribed but never read in
        // JSX, clientTool not registered, etc. Goal: average 0 probe
        // failures via harness engineering.
        for (const issue of probeIssues) {
          const tag = issue.result === 'fail' ? 'FAIL' : 'WARN';
          const sub = issue.subcategory ? `:${issue.subcategory}` : '';
          console.log(
            `    [runtime-probe ${tag}] ${issue.category}${sub}: ${issue.description}`,
          );
        }
      }

      // Aesthetic evaluation (Haiku, ~1-2s, ~$0.001 per call)
      let aestheticEval = null;
      if (!this.config.skipEvaluation && generation.sourceCode) {
        const { evaluateAesthetics } = await import("./post-eval.js");
        aestheticEval = await evaluateAesthetics(generation.sourceCode, commit.prompt, undefined, commit.contract);
      }

      const evalSuffix = aestheticEval
        ? ` | score: ${aestheticEval.score}/100${aestheticEval.passed ? "" : " ⚠"}`
        : "";
      console.log(
        `[benchmark] ${variant.id} × ${commit.id}: ` +
          `${generation.generationTimeMs}ms, ${generation.turnsUsed} calls${generation.iterations ? ` (${generation.iterations} iter)` : ""}, $${estimatedCostUsd.toFixed(4)}` +
          ` | ${postGeneration.compiledCodeBytes}B compiled` +
          `${postGeneration.hasStreamSpec ? " +stream" : ""}` +
          `${postGeneration.hasGeneratorMeta ? " +meta" : ""}` +
          `${postGeneration.dataFreeCheck?.isDataFree === false ? " ⚠dataFree" : ""}` +
          `${
            postGeneration.gadgetUsage &&
            postGeneration.gadgetUsage.missing.length > 0
              ? ` ⚠missingHooks(${postGeneration.gadgetUsage.missing.join(",")})`
              : ""
          }` +
          evalSuffix
      );
      const breakdown = (generation as { breakdown?: import('@ggui-ai/ui-gen/harness/result-types').GenerationResult['breakdown'] }).breakdown;
      if (breakdown) {
        console.log(
          `  [breakdown] ${variant.id} × ${commit.id} | ` +
            `impl=${breakdown.phases.impl} patch=${breakdown.phases.patch} evalFix=${breakdown.phases.evalFix} | ` +
            `pass=${breakdown.outcomes.pass} patchInvalid=${breakdown.outcomes.patchInvalid} ` +
            `selfCheckFail=${breakdown.outcomes.selfCheckFail} diffFail=${breakdown.outcomes.diffFail} | ` +
            `evalRounds=${breakdown.evalRounds} | ` +
            `llmMs=${breakdown.llmMs} toolMs=${breakdown.toolMs} evalMs=${breakdown.evalMs}`
        );
      }
      if (tierEvaluation) {
        const tierFails = tierEvaluation.issues.filter(i => i.result === 'fail');
        const tierWarns = tierEvaluation.issues.filter(i => i.result === 'warn');
        console.log(`  [eval] fail=${tierFails.length} warn=${tierWarns.length} pass=${tierEvaluation.pass.length}`);
        for (const issue of tierFails) {
          console.log(`    [FAIL] ${issue.category}: ${issue.description}`);
        }
        for (const issue of tierWarns) {
          console.log(`    [WARN] ${issue.category}: ${issue.description}`);
        }
      }

      return {
        variant,
        commit,
        generation,
        evaluation: aestheticEval,
        tierEvaluation,
        estimatedCostUsd: generation.rawCostUsd ?? estimatedCostUsd,
        timestamp: new Date().toISOString(),
        postGeneration,
        generator: generatorSlug,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[benchmark] ${variant.id} × ${commit.id} FAILED: ${message}`);

      return {
        variant,
        commit,
        generation: null,
        evaluation: null,
        estimatedCostUsd: 0,
        error: message,
        timestamp: new Date().toISOString(),
        generator: generatorSlug,
      };
    }
  }

  /**
   * Resolve the adapter for a given variant.
   * Tries mode-specific key first, falls back to provider-only key.
   */
  private resolveAdapter(variant: BenchmarkVariant): GeneratorAdapter | undefined {
    if (variant.mode) {
      const key = `${variant.sdkName}-${variant.mode}`;
      const adapter = this.adapters.get(key);
      if (adapter) return adapter;
    }
    // Fallback: provider-only key (backward compat)
    return this.adapters.get(variant.sdkName);
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Turn cap passed to the generation harness. NOT a user-tunable yet —
 * if you change this, grep for the constant to make sure downstream
 * dashboards are aware.
 */
export const BENCH_MAX_TURNS = 45;

/**
 * Resolve the generator slug for a variant. The mapping is:
 *
 *   - `variant.generator` when present and non-empty
 *   - otherwise {@link DEFAULT_GENERATOR_SLUG}
 *
 * Whitespace-only / empty strings collapse to the default so a
 * misconfigured fixture doesn't silently bypass the default
 * generator.
 */
export function resolveGeneratorSlug(variant: BenchmarkVariant): string {
  if (typeof variant.generator !== 'string') return DEFAULT_GENERATOR_SLUG;
  const trimmed = variant.generator.trim();
  if (trimmed.length === 0) return DEFAULT_GENERATOR_SLUG;
  return trimmed;
}

/**
 * Format a commit's variance hint as a prompt-block. Returns an
 * empty string when no variance is set so prompts stay unchanged
 * for commits without a variance hint. The block format is
 * intentionally readable — the LLM treats it like an additional
 * style brief, the operator reading the prompt-log treats it as a
 * test-condition record.
 *
 * This is the only channel through which variance influences
 * generation.
 */
export function formatVarianceBlock(
  variance: BenchmarkCommitVariance | undefined,
): string {
  if (!variance) return '';
  const lines: string[] = [];
  if (variance.persona) lines.push(`- Persona: ${variance.persona}`);
  if (variance.aesthetic) lines.push(`- Aesthetic: ${variance.aesthetic}`);
  if (variance.context !== undefined) {
    lines.push(`- Context: ${JSON.stringify(variance.context)}`);
  }
  if (variance.seedPrompt) lines.push(`- Style note: ${variance.seedPrompt}`);
  if (lines.length === 0) return '';
  return (
    '\n\n---\n## Variance Hint\n' +
    'Personalization signal — reflect these traits in the generated UI.\n\n' +
    lines.join('\n') +
    '\n'
  );
}

/**
 * Calculate estimated cost from token usage and model ID.
 */
export function calculateCost(modelId: string, tokens: { input: number; output: number }): number {
  const config = MODEL_REGISTRY[modelId as ModelId];
  if (!config) return 0;

  const inputCost = (tokens.input / 1_000_000) * config.costs.inputPer1M;
  const outputCost = (tokens.output / 1_000_000) * config.costs.outputPer1M;
  return inputCost + outputCost;
}

/**
 * Wrap a promise with a timeout.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Run async tasks with a concurrency limit.
 * Returns results in order, using Promise.allSettled semantics.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const currentIndex = index++;
      results[currentIndex] = await tasks[currentIndex]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * Run lightweight post-generation analysis on an AdapterResult.
 * No AWS services needed — pure code inspection.
 */
function runPostGeneration(
  generation: AdapterResult,
  commit: BenchmarkCommit
): PostGenerationResult {
  const result: PostGenerationResult = {
    hasStreamSpec: !!generation.stream,
    hasGeneratorMeta: !!generation.generatorMeta,
    compiledCodeBytes: generation.compiledCode.length,
    sourceCodeBytes: generation.sourceCode?.length,
  };

  // Extract metadata from generator output (if present)
  if (generation.generatorMeta) {
    result.metadata = generation.generatorMeta;
  }

  // Data-free validation: check source code for hardcoded prompt-specific data
  if (generation.sourceCode) {
    result.dataFreeCheck = checkDataFree(generation.sourceCode, commit);
  }

  // Plugin-slice wrapper-usage validation: for every export the
  // contract DECLARED under `clientCapabilities.gadgets` AND
  // the registered `appGadgets` catalog actually contains, verify
  // the generated source uses it. The cheapest possible signal that
  // the LLM acted on the registered-catalog prompt block — anything
  // beyond "didn't call the hook" needs runtime render verification.
  if (generation.sourceCode && commit.appGadgets && commit.appGadgets.length > 0) {
    result.gadgetUsage = checkGadgetUsage(
      generation.sourceCode,
      commit,
    );
  }

  return result;
}

/**
 * Per-export deterministic usage check for plugin-aware bench commits.
 * For every export `listContractGadgets(commit.contract)` surfaces that
 * also appears in `commit.appGadgets`, look for its usage in the
 * generated source — a call expression (`useX(`) for a HOOK export, a
 * JSX element (`<X …`) for a COMPONENT export. The export name's
 * grammar (`HOOK_NAME_RE`) discriminates kind. Anything stricter
 * (correct args, correct prop wiring) is left to the LLM evaluator /
 * runtime-render probe.
 *
 * Exported for unit testing — the wider `runPostGeneration` stays
 * private to the runner module.
 */
export function checkGadgetUsage(
  sourceCode: string,
  commit: BenchmarkCommit,
): { declared: readonly string[]; used: readonly string[]; missing: readonly string[] } {
  // The contract's package-keyed `clientCapabilities.gadgets`,
  // flattened to one `GadgetUse` (`{ package, name, … }`) per export.
  const declaredUses = listContractGadgets(commit.contract);
  // Every export name across every registered gadget package — a
  // descriptor is now a package with an `exports[]` array.
  const registered = new Set(
    (commit.appGadgets ?? []).flatMap((pkg) =>
      pkg.exports.map((exp) => gadgetExportName(exp)),
    ),
  );
  const declared: string[] = [];
  const used: string[] = [];
  const missing: string[] = [];
  for (const use of declaredUses) {
    const name = use.name;
    if (!registered.has(name)) continue;
    declared.push(name);
    // The export NAME's grammar discriminates kind: a `use`-prefixed
    // name (`HOOK_NAME_RE`) is a hook — CALLED (`useX(`); otherwise a
    // component — RENDERED as JSX (`<X` followed by whitespace, `/`,
    // or `>`). Escape the name in case a future export carries
    // regex-meaningful characters.
    const usagePattern = HOOK_NAME_RE.test(name)
      ? new RegExp(`\\b${escapeRegex(name)}\\s*\\(`)
      : new RegExp(`<${escapeRegex(name)}[\\s/>]`);
    if (usagePattern.test(sourceCode)) used.push(name);
    else missing.push(name);
  }
  return { declared, used, missing };
}

/**
 * Lightweight data-free check — looks for hardcoded prompt-specific values.
 * Not as thorough as the full validateDataFree() but runs without deps.
 */
function checkDataFree(
  sourceCode: string,
  commit: BenchmarkCommit
): { isDataFree: boolean; violations: string[] } {
  const violations: string[] = [];

  // Extract string literals from props to check against source
  if (commit.props) {
    const propsValues = extractStringValues(commit.props);
    for (const value of propsValues) {
      // Skip short/generic strings that would false-positive
      if (value.length < 4) continue;
      // Skip common words
      if (["true", "false", "null", "undefined", "none"].includes(value.toLowerCase())) continue;
      // Check if the exact value is hardcoded (not in a default prop)
      if (sourceCode.includes(`"${value}"`) || sourceCode.includes(`'${value}'`)) {
        // Allow it if it appears in a default prop pattern: = "value" or ?? "value"
        const defaultPattern = new RegExp(`(?:=\\s*|\\?\\?\\s*)['"]${escapeRegex(value)}['"]`);
        if (!defaultPattern.test(sourceCode)) {
          violations.push(`Hardcoded string "${value}" found — should be a prop default`);
        }
      }
    }
  }

  return { isDataFree: violations.length === 0, violations };
}

function extractStringValues(obj: unknown): string[] {
  const values: string[] = [];
  if (typeof obj === "string") {
    values.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) values.push(...extractStringValues(item));
  } else if (obj && typeof obj === "object") {
    for (const val of Object.values(obj)) values.push(...extractStringValues(val));
  }
  return values;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
