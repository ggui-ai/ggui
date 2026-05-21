// packages/ui-gen/src/create-harness.ts
//
// Deterministic Harness factory — the skeleton constructor. Given a
// classification + contract + prompt (+ optional caller-injected
// defaults for policy / system-prompt builder / axis-checks /
// runtime-render / overrides), assemble all four legs and return an
// immutable Harness object ready to drive generation.
//
// This is a SKELETON: it has four injection seams (policy,
// systemPromptBuilder, axisChecks, runtimeRender). The hosted runtime
// supplies the production content for those seams from
// `adapters/generation-dispatch.ts` at the dispatch boundary; callers
// that omit them get minimal defaults.

import type { CacheTier } from "./fragments/index.js";
import { compose } from "./compose.js";
import { buildSystemPrompt, generateBoilerplate } from "./boilerplate.js";
import { APPLY_CHANGES_TOOL, APPLY_CHANGES_TOOL_SCOPED } from "./tools.js";
import { defaultApplyPatch } from "./patch.js";
import { computeHarnessId, computeHarnessName, hashClassification } from "./hash.js";
import { pickWorkflow } from "./workflows.js";
import { DEFAULT_HARNESS_POLICY, isDefaultHarnessPolicy } from "./policy.js";
import type {
  CreateHarnessInput,
  Harness,
  HarnessConstructionContext,
  HarnessOverrides,
  HarnessRevision,
  HowLeg,
  WhatLeg,
  CheckLeg,
  ProcessLeg,
  HarnessMeta,
  PatchFn,
  SystemPromptBuilder,
} from "./harness/types-public.js";

// Version tags — bump when semantics change.
const HARNESS_VERSION = "harness@1";
const HOW_VERSION = "how@1";
const WHAT_VERSION = "what@1";
const CHECK_VERSION = "check@1";
const PROCESS_VERSION = "process@1";

// Default patch function — pure line-range application (mirrors apply_changes).
// Variants can override via HarnessOverrides.what.
const defaultPatchFn: PatchFn = defaultApplyPatch;

function applyLegOverride<L>(
  base: L,
  ovr: Partial<L> | ((base: L, ctx: HarnessConstructionContext) => L) | undefined,
  ctx: HarnessConstructionContext,
): L {
  if (!ovr) return base;
  if (typeof ovr === "function") return (ovr as (b: L, c: HarnessConstructionContext) => L)(base, ctx);
  return { ...base, ...ovr };
}

function countCacheTiers(fragments: readonly { cacheTier: CacheTier }[]): Record<CacheTier, number> {
  const counts: Record<CacheTier, number> = { stable: 0, axisDelta: 0, volatile: 0 };
  for (const f of fragments) counts[f.cacheTier]++;
  return counts;
}

/**
 * Build a Harness from classification + inputs. Idempotent: same inputs
 * produce a Harness with the same id.
 */
export function createHarness(input: CreateHarnessInput): Harness {
  const { classification, contract, prompt, shellType, screen, overrides } = input;
  const ctx: HarnessConstructionContext = { classification, contract, prompt };

  // ── Compose fragments from classification ────────────────────────────────
  const composed = compose(classification);

  // ── HOW leg ──────────────────────────────────────────────────────────────
  // System-prompt builder seam. The default is the skeleton builder
  // with empty content blocks; callers inject a fully-populated builder
  // to add pitfalls + design-system docs + primitives + wire content.
  const systemPromptBuilder: SystemPromptBuilder =
    input.systemPromptBuilder ?? buildSystemPrompt;
  const systemPrompt = systemPromptBuilder({
    userRequest: prompt,
    shellType,
    screen,
    axisDelta: composed.promptText,
  });
  const howFragments = composed.fragments.filter(
    (f) => f.promptText && f.promptText.trim().length > 0,
  );
  const baseHow: HowLeg = {
    systemPrompt,
    implPrompt: "",
    fragments: howFragments,
    version: HOW_VERSION,
  };
  const how = applyLegOverride(baseHow, overrides?.how, ctx);

  // ── WHAT leg ─────────────────────────────────────────────────────────────
  // `appGadgets` reaches the boilerplate generator so thin contract
  // refs (`{hook: 'useLeafletMap'}` without a per-binding `package`)
  // resolve their import specifier from the operator-registered
  // descriptor's `package` field. Without this thread, the LLM's
  // starter file shows
  // `import { useLeafletMap } from '@ggui-ai/gadgets'` —
  // which doesn't export operator-registered wrapper hooks — and the
  // LLM removes the hook with a "not available" comment.
  const boilerplate = generateBoilerplate(
    prompt,
    contract as Parameters<typeof generateBoilerplate>[1],
    shellType,
    screen,
    composed.boilerplateSections,
    input.appGadgets,
  );
  const whatFragments = composed.fragments.filter(
    (f) => f.boilerplateMarker && f.boilerplateMarker.trim().length > 0,
  );
  const baseWhat: WhatLeg = {
    boilerplate,
    fragments: whatFragments,
    codingTools: [APPLY_CHANGES_TOOL],
    scopedTools: [APPLY_CHANGES_TOOL_SCOPED],
    applyPatch: defaultPatchFn,
    // Registered gadget catalog — drives the system prompt's gadget
    // table + the boilerplate's direct-import emission. Omitted when no
    // gadgets registered.
    ...(input.appGadgets !== undefined ? { appGadgets: input.appGadgets } : {}),
    // Third-party wrapper `.d.ts` map — autoCommit's typecheck overlays
    // the real wrapper declarations so a generated direct gadget import
    // gets strict hook types.
    ...(input.gadgetTypes !== undefined
      ? { gadgetTypes: input.gadgetTypes }
      : {}),
    version: WHAT_VERSION,
  };
  const what = applyLegOverride(baseWhat, overrides?.what, ctx);

  // ── CHECK leg ────────────────────────────────────────────────────────────
  // Axis-check registry seam. The caller supplies pre-filtered
  // axisChecks; the skeleton default is [].
  // Runtime-render seam. The skeleton default is undefined.
  const axisChecks = input.axisChecks ?? [];
  const baseCheck: CheckLeg = {
    axisChecks,
    tierChecks: [],
    runtimeRender: input.runtimeRender,
    llmEvaluator: undefined,
    version: CHECK_VERSION,
  };
  const check = applyLegOverride(baseCheck, overrides?.check, ctx);

  // ── Policy ───────────────────────────────────────────────────────────────
  // Policy injection seam. The caller pre-resolves; the skeleton
  // default is DEFAULT_HARNESS_POLICY.
  const policy = input.policy ?? DEFAULT_HARNESS_POLICY;

  // ── Process leg ──────────────────────────────────────────────────────────
  const workflow = pickWorkflow(classification);
  const baseProcess: ProcessLeg = {
    mode: policy.processMode ?? "single_pass",
    workflow,
    planner: undefined,
    retry: { maxIterations: 30 },
    version: PROCESS_VERSION,
  };
  const processLeg = applyLegOverride(baseProcess, overrides?.process, ctx);

  // ── Meta + id ────────────────────────────────────────────────────────────
  const classificationHash = hashClassification(classification);
  const fragmentIds = composed.fragments.map((f) => `${f.axis}=${f.value}`);
  const cacheTierBreakdown = countCacheTiers(composed.fragments);
  const overrideLabels: string[] = [];
  if (overrides?.how) overrideLabels.push("how");
  if (overrides?.what) overrideLabels.push("what");
  if (overrides?.check) overrideLabels.push("check");
  if (overrides?.process) overrideLabels.push("process");
  if (overrides?.label) overrideLabels.push(`label:${overrides.label}`);
  // Only non-default policies contribute to the harness id — preserves
  // byte-identical id across default-policy runs.
  if (!isDefaultHarnessPolicy(policy)) overrideLabels.push("policy");

  const id = computeHarnessId({
    classificationHash,
    howVersion: how.version,
    whatVersion: what.version,
    checkVersion: check.version,
    processVersion: processLeg.version,
    workflowId: workflow.id,
    fragmentIds,
    overrides: overrideLabels,
  });

  const name = computeHarnessName({
    classification,
    workflowName: workflow.name,
    version: HARNESS_VERSION,
  });

  const meta: HarnessMeta = {
    classificationHash,
    fragmentIds,
    cacheTierBreakdown,
    overrides: overrideLabels,
    createdAt: new Date().toISOString(),
    harnessVersion: HARNESS_VERSION,
  };

  const harness: Harness = {
    id,
    name,
    classification,
    how,
    what,
    check,
    process: processLeg,
    policy,
    meta,
    derive(revision: HarnessRevision): Harness {
      return deriveHarness(this, revision, input);
    },
  };

  return harness;
}

/**
 * Produce a derived Harness for a subsequent iteration. Called when the
 * planner reclassifies or a runtime signal demands a topology swap.
 */
function deriveHarness(
  base: Harness,
  revision: HarnessRevision,
  originalInput: CreateHarnessInput,
): Harness {
  let mergedOverrides: HarnessOverrides = {
    ...originalInput.overrides,
    ...(revision.overrides ?? {}),
  };

  // If the revision names a new workflow explicitly, override the process leg.
  if (revision.workflow) {
    const currentProcessOverride = mergedOverrides.process;
    const processBuilder = (baseProcess: ProcessLeg, ctx: HarnessConstructionContext): ProcessLeg => {
      const withOverride =
        typeof currentProcessOverride === "function"
          ? currentProcessOverride(baseProcess, ctx)
          : { ...baseProcess, ...(currentProcessOverride ?? {}) };
      return { ...withOverride, workflow: revision.workflow! };
    };
    mergedOverrides = { ...mergedOverrides, process: processBuilder };
  }

  // Runtime fallback: promote scopedTools → codingTools.
  if (revision.useFallbackTools) {
    const currentWhatOverride = mergedOverrides.what;
    const whatBuilder = (baseWhat: WhatLeg, ctx: HarnessConstructionContext): WhatLeg => {
      const withOverride =
        typeof currentWhatOverride === "function"
          ? currentWhatOverride(baseWhat, ctx)
          : { ...baseWhat, ...(currentWhatOverride ?? {}) };
      if (withOverride.scopedTools && withOverride.scopedTools.length > 0) {
        return { ...withOverride, codingTools: withOverride.scopedTools };
      }
      return withOverride;
    };
    mergedOverrides = { ...mergedOverrides, what: whatBuilder };
  }

  return createHarness({
    ...originalInput,
    classification: revision.classification ?? base.classification,
    overrides: mergedOverrides,
  });
}
