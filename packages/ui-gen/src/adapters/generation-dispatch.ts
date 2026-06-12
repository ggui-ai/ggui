// Dispatches generation through the closure-based harness pipeline.
// Used by the benchmark runner and the production Lambda generator.
// Single implementation — provider-agnostic; the harness handles all
// providers uniformly.
//
// Pipeline:
//   resolveSessionAgents  — fallback chain coding → eval → visualEval
//   classifyAxes          — read the multi-axis vector from contract + prompt
//   createHarness         — assemble HOW/WHAT/CHECK/Process legs
//   initSession           — workspace, agent (warm-cached), pre-warm,
//                           lazy eval modules, costTracker
//   createTelemetry       — fresh per-generation counters/totals record
//   createGenerateTaskRunner — closure capturing session + telemetry;
//                              drives the multi-turn coding + eval loop
//                              using runCodingTurn + runEvalRound
//   runHarness            — workflow lifecycle wrapper; the closure
//                           does the inner loop, runHarness adds
//                           compile-null safety + iteration telemetry
//   assembleGenerationResult — telemetry → GenerationResult shape

import { classifyAxes } from "../classifier/index.js";
import { createHarness } from "../harness/index.js";
import { runHarness } from "../harness/index.js";
import { resolveHarnessPolicy } from "../harness/policy.js";
// Fully-populated system-prompt builder. The `createHarness`
// constructor uses a skeleton builder with empty content blocks by
// default; this callsite injects the full builder so production
// prompts carry pitfalls + design-system docs + primitives + wire
// content.
import { buildSystemPrompt as buildSystemPromptWithFunnel } from "../harness/runtime.js";
// Axis-check registry filter. The `createHarness` constructor accepts a
// pre-filtered axisChecks list; this callsite runs the `matches()`
// predicate against the full registry and passes the filtered result.
import { REGISTRY as AXIS_CHECK_REGISTRY } from "../evaluation/axis-checks/registry.js";
import { matches as axisCheckMatches } from "../evaluation/types-public.js";
// Runtime-render default. The `createHarness` constructor accepts an
// optional runtimeRender; this callsite injects
// `DEFAULT_RUNTIME_RENDER_CHECK` so production keeps the happy-dom-
// backed contract-wiring verification step.
import { DEFAULT_RUNTIME_RENDER_CHECK } from "../harness/check/runtime-render/adapter.js";
import { warmupRuntimeRenderProbe } from "../harness/check/runtime-render/index.js";
import { assembleGenerationResult } from "../harness/coding/assemble-result.js";
import {
  createGenerateTaskRunner,
  createTelemetry,
} from "../harness/coding/generate-task-runner.js";
import { initSession, resolveSessionAgents } from "../harness/coding/init-session.js";
import type {
  DataContract,
  ModelRoles,
  GenerationResult,
  RenderingContext,
} from "../harness/result-types.js";
import type { AdapterResult, ProviderName, ToolDefinition } from "./types.js";
import type { QualityConfig } from "../evaluation/types-public.js";
import {
  type GadgetDescriptor,
  type JsonObject,
} from "@ggui-ai/protocol";

export interface GenerationDispatchParams {
  provider: ProviderName;
  model: string;
  userPrompt: string;
  tools: ToolDefinition[];
  models?: ModelRoles;
  originalPrompt?: string;
  /** Evaluation config — controls the evaluate-then-regenerate loop. */
  evaluation?: import("../evaluation/types.js").EvaluationConfig;
  rendering?: RenderingContext;
  contract?: DataContract;
  /** Shell type for layout-adaptive boilerplate */
  shellType?: "chat" | "fullscreen" | "spatial";
  /** Target screen size for responsive layout */
  screen?: "mobile" | "tablet" | "desktop" | "universal";
  /**
   * Maximum coding attempts per generation pass (default: 8). This is
   * the harness turn cap — there is no separate `maxTurns` knob.
   */
  maxAttempts?: number;
  /** Maximum evaluation rounds (default: 10) */
  maxEvalRounds?: number;
  /**
   * Visual evaluation config (screenshot + multimodal LLM scoring).
   * The judge model is NOT configured here — visual eval runs on the
   * session's evaluation agent (`models.evaluation`, falling back to
   * the coding agent). See `resolveSessionAgents` in
   * `harness/coding/init-session.ts`.
   */
  visualEvaluation?: {
    enabled: boolean;
    passThreshold?: number;
    sampleProps?: JsonObject;
    viewport?: { width: number; height: number };
  };
  /** Quality config controlling eval tiers and improvement behavior */
  qualityConfig?: QualityConfig;
  /**
   * Optional fixture props (e.g., from a benchmark commit's `props` field).
   * Forwarded to runCheck → runtimeRender for schema-first mockup synthesis.
   * Production callers can omit this; benchmark runners should pass commit.props.
   */
  fixtureProps?: JsonObject;
  /**
   * Whether to wire `DEFAULT_RUNTIME_RENDER_CHECK` into the harness's
   * check leg. When `true` (default), the probe runs every coding turn
   * and feeds wiring-check failures back to the coding agent — useful
   * for quality gating but ~3-5s per call adds wall-clock per turn.
   *
   * When `false`, the harness omits runtime-render from the in-loop
   * check pipeline. Cloud production runs with this off (per the
   * migration plan — probe was never in the production hot path).
   * Bench callers can run the probe externally as a final post-gen
   * check to get pass/fail visibility without slowing the loop.
   *
   * Default: `true`.
   */
  enableRuntimeRender?: boolean;
  /**
   * Operator-registered gadget catalog forwarded to the
   * code-gen system prompt's `clientCapabilities — registered
   * catalog` section (see `buildSystemPrompt`/`SystemPromptInputs`
   * in `@ggui-ai/ui-gen/boilerplate`). Threaded by the render handler
   * from the bound `AppMetadataStore` so the code-gen LLM sees the
   * same gadget set as the synth + decision LLMs.
   *
   * When omitted, the system prompt defaults to `STDLIB_GADGETS`.
   * Production callers (render, ops-generate) pass the resolved catalog;
   * benchmark / direct callers may omit it.
   */
  appGadgets?: readonly GadgetDescriptor[];
  /**
   * A `package -> .d.ts content` map for third-party gadget wrappers.
   * The render handler parallel-fetches each non-stdlib
   * gadget's `.d.ts` (via `GadgetDescriptor.typesUrl` + SRI verify)
   * and threads the result here (`UiGenerateInput.gadgetTypes`). It
   * flows two ways:
   *   1. into `createHarness({ gadgetTypes })` → `WhatLeg` → the
   *      coding-agent's typecheck overlay, so third-party hooks get
   *      strict option/return narrowing in the TS sandbox;
   *   2. into the code-gen `systemPromptBuilder`, so the prompt
   *      renders a `Type:` line per third-party gadget — the LLM sees
   *      the real call shape of a wrapper it cannot otherwise know.
   *
   * Stdlib gadgets (`@ggui-ai/gadgets`) need no entry — their `.d.ts`
   * is in the sandbox VFS and they carry an `example`. Omit for
   * STDLIB-only / bench / direct callers.
   */
  gadgetTypes?: Readonly<Record<string, string>>;
}

/**
 * Map ProviderName ('claude' | 'openai' | 'google') to AgentConfig provider ('anthropic' | 'openai' | 'google').
 * The LLM router uses 'anthropic' while the rest of the codebase uses 'claude'.
 */
function mapProviderForLLMRouter(provider: ProviderName): "anthropic" | "openai" | "google" | "openrouter" {
  return provider === "claude" ? "anthropic" : provider;
}

/**
 * Dispatch to the closure-based harness pipeline. Single-implementation,
 * provider-agnostic.
 */
export async function dispatchGeneration(
  params: GenerationDispatchParams,
): Promise<AdapterResult | GenerationResult> {
  // NOTE: userPrompt arrives already enriched with rendering context + contract
  // (including examples) from the caller (runner.ts / generator.ts).
  // The contract are injected via injectContracts() which calls propsSpecToTypeScript()
  // to render PropEntry.example values as // Example: {...} comments in the TS interface.
  // Do NOT re-inject here.

  // Pre-warm runtime-render probe deps in parallel with the LLM cold
  // call. The probe lazily loads happy-dom +
  // @testing-library + @ggui-ai/wire on first use (~700-1500ms cold);
  // pre-warming so it overlaps with the first LLM round-trip means the
  // first runCheck call hits warm modules (~50ms). Fire-and-forget — if
  // the probe runs before pre-warm completes, runCheck just pays the
  // cold cost on first invocation.
  if ((params.enableRuntimeRender ?? true) === true) {
    void warmupRuntimeRenderProbe().catch(() => {
      // Pre-warm is best-effort; per-cell probe surfaces real failures
      // through the standard check pipeline if a dep is missing.
    });
  }

  const routerProvider = mapProviderForLLMRouter(params.provider);
  const resolvedModel = params.models?.coding ?? params.models?.default ?? params.model;
  const codingAgent = { provider: routerProvider, model: resolvedModel };
  const evaluationAgent = params.models?.evaluation
    ? { provider: routerProvider, model: params.models.evaluation }
    : undefined;
  // ModelRoles doesn't currently expose a visualEval slot — falls through
  // to the documented evaluation → coding chain inside resolveSessionAgents.

  // ── Contract enrichment ──────────────────────────────────────────────
  // The contract is used as-is: `clientCapabilities.gadgets`
  // is package-keyed and carries identity only — `(package, export
  // name)` — so there is no enrichment overlay. The resolved descriptor
  // list arrives as a separate `appGadgets` array — this dispatcher's
  // downstream consumers consult it directly when they need transport
  // metadata.
  const effectiveContract = params.contract;

  // ── Build SingleComponentParams (the closure + assembleGenerationResult
  //    both consume this shape).
  const sessionParams = {
    userPrompt: params.originalPrompt ?? params.userPrompt,
    contract: effectiveContract,
    shellType: params.shellType,
    screen: params.screen,
    evaluation: params.evaluation
      ? {
          enabled: params.evaluation.enabled,
          passThreshold: params.evaluation.passThreshold,
          maxRounds: params.evaluation.maxRounds ?? params.maxEvalRounds,
        }
      : undefined,
    visualEvaluation: params.visualEvaluation,
    qualityConfig: params.qualityConfig,
    fixtureProps: params.fixtureProps,
  };

  // ── Classify + build harness.
  const classification = classifyAxes({
    contract: (effectiveContract ?? {}) as Parameters<typeof classifyAxes>[0]["contract"],
    prompt: sessionParams.userPrompt,
  });
  const harness = createHarness({
    classification,
    contract: (effectiveContract ?? {}) as Parameters<typeof createHarness>[0]["contract"],
    prompt: sessionParams.userPrompt,
    shellType: sessionParams.shellType,
    screen: sessionParams.screen,
    // Forward the registered catalog into createHarness so
    // `generateBoilerplate` emits correct `import { useLeafletMap }
    // from '<package>'` lines for thin contract refs. The closure
    // capture below (systemPromptBuilder) wires the SAME catalog
    // into the HOW leg.
    ...(params.appGadgets !== undefined
      ? { appGadgets: params.appGadgets }
      : {}),
    // Forward the third-party wrapper `.d.ts` map so
    // `WhatLeg.gadgetTypes` reaches the coding-agent's typecheck
    // overlay (autoCommit → runTier0Checks → typecheck). The
    // systemPromptBuilder closure below also captures `gadgetTypes`
    // from `params` directly for the prompt `Type:` lines.
    ...(params.gadgetTypes !== undefined
      ? { gadgetTypes: params.gadgetTypes }
      : {}),
    // Policy is pre-resolved at the dispatch boundary so `createHarness`
    // stays free of experiment plumbing. `resolveHarnessPolicy` applies
    // the `GGUI_POLICY_PROFILE` experimental-profile layer and hands the
    // result to the constructor.
    policy: resolveHarnessPolicy(classification),
    // Fully-populated system-prompt builder. This `buildSystemPrompt`
    // wrapper pre-fills pitfalls + design-system docs + primitives +
    // wire content.
    //
    // `appGadgets` is captured from `params` at dispatch time and
    // threaded into the wrapper so the code-gen prompt's
    // `clientCapabilities — registered catalog` section renders the
    // operator-registered gadget set (Leaflet, Mapbox, …) instead of
    // falling back to STDLIB. When omitted, the wrapper defaults to
    // STDLIB-only.
    // `params.gadgetTypes` is captured into the closure so the code-gen
    // prompt's gadget catalog renders a `Type:` line per third-party
    // gadget (the LLM sees a wrapper's real call shape it otherwise
    // can't know).
    systemPromptBuilder: ({ userRequest, shellType, screen, axisDelta }) =>
      buildSystemPromptWithFunnel(
        userRequest,
        shellType,
        screen,
        axisDelta,
        params.appGadgets,
        params.gadgetTypes,
      ),
    // Pre-filtered axis-check registry. The `matches()` predicate
    // selects the checks relevant to this generation's axis vector.
    axisChecks: AXIS_CHECK_REGISTRY.filter((check) =>
      axisCheckMatches(classification.vector, check),
    ),
    // The default runtime-render check. Heavy deps (happy-dom + wire +
    // design) stay on the dispatch side of the boundary; the skeleton
    // createHarness defaults this to undefined.
    //
    // Gated behind `enableRuntimeRender` (default true) so
    // benchmark/dev callers can opt out of in-loop probe execution and
    // run the probe externally as a final post-generation check.
    runtimeRender: (params.enableRuntimeRender ?? true)
      ? DEFAULT_RUNTIME_RENDER_CHECK
      : undefined,
  });
  console.log(
    `[harness] id=${harness.id} name=${harness.name} workflow=${harness.process.workflow.name} overrides=${harness.meta.overrides.join(",") || "none"}`,
  );
  console.log(
    `[simple] axis-vector: ${JSON.stringify(classification.vector)} risk=${classification.riskTier}`,
  );

  // ── Guard: staged workflow is not wired on the dispatch path. ──
  // The STAGED workflow defines `architect` + `coder` task nodes, but
  // this dispatch path only registers a `generate` TaskRunner (the
  // closure-based coding loop). Unrecognised tasks silently fall
  // through to runWorkflow's noopDefaultRunner which returns the task
  // name as a literal string — that fails compile with a 5-byte
  // "source" and burns a full generation before the failure surfaces.
  //
  // Tests that exercise STAGED (harness.integrated.test.ts, run-workflow.test.ts,
  // create-harness.test.ts) wire architect+coder runners themselves, so
  // this guard only fires on the production dispatch path — the only path
  // that lacks those runners today.
  //
  // Callers that want staged behaviour should set `process.mode === "staged"`
  // with `process.workflow.name === "single_pass"` — the in-task A1 phase
  // machine (scaffold → fill) lives inside the `generate` runner and will
  // fire without needing the workflow topology.
  if (harness.process.workflow.name === "staged") {
    throw new Error(
      `[dispatch] STAGED workflow routed but architect/coder TaskRunners are not wired on the dispatch path. ` +
        `This is a misconfiguration (probably pickProcessMode returning WORKFLOWS.staged). ` +
        `For staged-like behaviour, set process.mode="staged" + workflow.name="single_pass" instead — the A1 ` +
        `scaffold→fill phase machine lives inside the generate runner and fires without the workflow topology. ` +
        `See ralph #3 report (2026-04-14) for the full rationale.`,
    );
  }

  // ── Resolve agents + spin up the session.
  const agents = resolveSessionAgents({
    codingAgent,
    evaluationAgent,
  });

  // ── Runtime policy resolution ──
  // Experimental profiles opt in via the GGUI_POLICY_PROFILE env var.
  // The production Lambda / CLI never sets it; benchmark scripts can set
  // it explicitly to exercise provider-aware overrides. When unset,
  // resolveRunPolicyForProfile falls through to the identity
  // resolveRunPolicy — byte-identical to the default behavior.
  const { resolveRunPolicyForProfile } = await import("../harness/policy.js");
  const resolvedPolicy = resolveRunPolicyForProfile(
    process.env.GGUI_POLICY_PROFILE,
    harness,
    { provider: routerProvider, modelId: resolvedModel },
  );

  // ── Axis-keyed primitives doc slice ──
  // When the resolved policy flips to axis-keyed, rebuild the first-turn
  // system prompt with a sliced PRIMITIVES_DOCUMENTATION derived from the
  // classification. The slice typically cuts the system prompt by ~80 KB
  // (~20K tokens). Surface awareness is preserved — the name-only primitive
  // catalog already lives in the system prompt above the sliced block.
  // Always logs `[simple] primitive-doc-bytes` telemetry so both modes
  // are auditable post-hoc.
  let systemPromptOverride: string | undefined;
  {
    const { PRIMITIVES_DOCUMENTATION } = await import("../validation/index.js");
    const fullBytes = Buffer.byteLength(PRIMITIVES_DOCUMENTATION, "utf8");
    const mode = resolvedPolicy.context.primitiveDocSlice ?? "full";
    if (mode === "axis-keyed") {
      const { computePrimitiveAllowlist, slicePrimitiveDocumentation } =
        await import("../harness/primitive-slice.js");
      let allowlist = computePrimitiveAllowlist(classification);
      // Apply policy-driven excludes — some policy profiles drop
      // near-synonym layout primitives (e.g. Row/Box/Spacer).
      const excludes = resolvedPolicy.context.primitiveDocExcludes ?? [];
      if (excludes.length > 0) {
        const excludeSet = new Set(excludes);
        allowlist = allowlist.filter((p) => !excludeSet.has(p));
      }
      const sliced = slicePrimitiveDocumentation(
        PRIMITIVES_DOCUMENTATION,
        allowlist,
      );
      const slicedBytes = Buffer.byteLength(sliced, "utf8");
      const excludeTag = excludes.length ? ` excludes=${excludes.join(",")}` : "";
      console.log(
        `[simple] primitive-doc-bytes=${slicedBytes} mode=axis-keyed baseline=${fullBytes} drop=${((1 - slicedBytes / fullBytes) * 100).toFixed(1)}% allowlist=${allowlist.length}/${allowlist.join(",")}${excludeTag}`,
      );
      systemPromptOverride = harness.how.systemPrompt.replace(
        PRIMITIVES_DOCUMENTATION,
        sliced,
      );
    } else {
      console.log(
        `[simple] primitive-doc-bytes=${fullBytes} mode=full baseline=${fullBytes} drop=0.0%`,
      );
    }

    // ── Tool-driven primitive docs ──
    // Layers on top of axis-keyed slicing — if slicing already trimmed
    // the doc, the index replaces whatever's left. When both are
    // active, the index wins (it is a more aggressive cut). The two are
    // mutually exclusive in practice via profile selection; this
    // ordering just defines the tiebreak.
    const indexMode = resolvedPolicy.context.primitiveIndex ?? "off";
    if (indexMode !== "off") {
      const { buildPrimitiveIndex } = await import("../harness/primitive-index.js");
      const index = buildPrimitiveIndex(PRIMITIVES_DOCUMENTATION, indexMode);
      const indexBytes = Buffer.byteLength(index, "utf8");
      console.log(
        `[simple] primitive-index-bytes=${indexBytes} mode=${indexMode} baseline=${fullBytes} drop=${((1 - indexBytes / fullBytes) * 100).toFixed(1)}%`,
      );
      systemPromptOverride = (systemPromptOverride ?? harness.how.systemPrompt).replace(
        PRIMITIVES_DOCUMENTATION,
        index,
      );
    }

    // ── TypeScript-interface processed doc ──
    // Replace the markdown-table doc with the TS-interface format
    // version (~55% smaller, same info). Mutually exclusive with index
    // modes.
    const docFormat = resolvedPolicy.context.primitiveDocFormat ?? "markdown";
    if (docFormat === "ts" && indexMode === "off") {
      const { PRIMITIVES_DOCUMENTATION_TS } = await import("../tools/get-primitives-ts.js");
      const tsBytes = Buffer.byteLength(PRIMITIVES_DOCUMENTATION_TS, "utf8");
      console.log(
        `[simple] primitive-doc-ts-bytes=${tsBytes} baseline=${fullBytes} drop=${((1 - tsBytes / fullBytes) * 100).toFixed(1)}%`,
      );
      systemPromptOverride = (systemPromptOverride ?? harness.how.systemPrompt).replace(
        PRIMITIVES_DOCUMENTATION,
        PRIMITIVES_DOCUMENTATION_TS,
      );
    }

    // ── plan→impl pipeline augmentation ──
    // Append a 2-phase flow description when planFirstTurn is active so
    // the LLM understands why turn 1 only advertises write_plan.
    if (resolvedPolicy.context.planFirstTurn) {
      const phaseGuidance = `\n\n## Generation Phases\n\nThis generation runs in TWO phases:\n\n**Turn 1 — PLAN.** The harness only advertises the \`write_plan\` tool. Commit to:\n  • \`components\`: which primitives/components you will use (from the reference above).\n  • \`structure\`: a brief JSX outline showing nesting.\n  • \`wiring\`: state/actions/streams you will use.\nDo NOT attempt to write code — \`apply_changes\` is not available on turn 1.\n\n**Turn 2+ — EXECUTE.** Now write code via \`apply_changes\`. If your patches accumulate into a tangled broken state, \`rewrite\` is available as an escape. There is no fetch tool — the component reference above is complete.\n\nYour plan is a commitment, not a design doc. Keep it tight. Do not over-plan; just enough to pick components and sketch structure before writing.`;
      systemPromptOverride = (systemPromptOverride ?? harness.how.systemPrompt) + phaseGuidance;
      console.log(`[simple] plan-first-turn=on`);
    }
  }

  const session = await initSession({
    harness,
    params: sessionParams,
    agents,
    resolvedPolicy,
    systemPromptOverride,
  });

  // ── Build the closure-based generate runner.
  const telemetry = createTelemetry();
  const generate = createGenerateTaskRunner({
    session,
    params: sessionParams,
    classification,
    telemetry,
    maxTurns: params.maxAttempts ?? 8,
  });

  // ── Drive via runHarness — wrapper owns lifecycle + iteration telemetry.
  // The closure runs the inner coding+eval loop itself; runHarness's check
  // is skipped (skipCheck: true) to avoid double-firing LLM + visual eval
  // that the closure already ran internally. compile reads the closure's
  // pairedSource→compiledCode pairing so runHarness's compile-null safety
  // fires when the closure failed to produce a working compile.
  const runResult = await runHarness({
    harness,
    prompt: sessionParams.userPrompt,
    contract: (params.contract ?? { intent: "" }) as DataContract,
    taskRunners: { generate },
    compile: async () => telemetry.compiledCode || null,
    passes: () => true,
    skipCheck: true,
    maxIterations: 1,
  });

  // ── Propagate runHarness terminal failures.
  // Without this short-circuit, no-source / compile-failed silently fall
  // through to assembleGenerationResult and produce a "successful" result
  // with empty compiledCode — caller can't distinguish from a real success.
  if (!runResult.ok) {
    console.error(
      `[dispatch] runHarness terminated: ${runResult.reason} ` +
        `(source=${runResult.finalSource ? runResult.finalSource.length + "B" : "null"}, ` +
        `compiled=${runResult.finalCompiled ? runResult.finalCompiled.length + "B" : "null"})`,
    );
  }

  // ── Assemble + return the legacy GenerationResult shape.
  // Source comes from runResult.finalSource (which is the closure's
  // pairedSource via the workflow output) — guaranteed to pair with
  // telemetry.compiledCode when runResult.ok is true.
  const finalSource = runResult.finalSource ?? "";
  return assembleGenerationResult({ session, telemetry, source: finalSource });
}
