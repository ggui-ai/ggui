// Default single-component harness: prompt injection wrapper + agent params.
//
// `buildSystemPrompt` here is a positional wrapper over the skeleton
// builder in `@ggui-ai/ui-gen/boilerplate`. It pre-fills every
// injectable content block from the package's own content modules so
// callers get a production-grade system prompt without supplying the
// blocks themselves:
//   - `renderPitfallsBlock()` — common-pitfalls guidance.
//   - `DEFAULT_DESIGN_SYSTEM_DOCS` / `PRIMITIVES_DOCUMENTATION` /
//     `WIRE_DOCUMENTATION` — design-system, primitive, and wire docs.
//   - criteria block defaults from the CRITERIA registry.
//
// `generateBoilerplate` + the primitive constants + renderBoilerplate +
// jsonSchemaTypeToTs are also re-exported here from
// `@ggui-ai/ui-gen/boilerplate`.
//
// Pipeline: Boilerplate → unified coding + eval loop.
//   Turn 1: implement → self-check
//   Turns 2+: patch self-check issues → self-check
//   On first compile: deliver initial result → run eval
//   If eval issues: feed back → patch → self-check → re-eval
//
// Architectural guidance (primitives, CSS vars, planning hints) is given
// directly to the coding agent in the system prompt — there is no
// separate planner stage.

import type { QualityConfig } from "../evaluation/types-public.js";
import { DEFAULT_DESIGN_SYSTEM_DOCS } from "../design-system-docs.js";
import { PRIMITIVES_DOCUMENTATION } from "../validation/index.js";
import { WIRE_DOCUMENTATION } from "../tools/get-wire.js";
import { renderPitfallsBlock } from "./pitfalls.js";
import type { GadgetDescriptor, DataContract, JsonObject } from "@ggui-ai/protocol";
import { buildSystemPrompt as buildSystemPromptSkeleton } from "../boilerplate.js";

// Re-export the boilerplate generator so existing internal importers
// (create-harness.ts, benchmarks/preview-boilerplate.ts) keep working.
export { generateBoilerplate } from "../boilerplate.js";

// =============================================================================
// Config & Params
// =============================================================================

type Provider = "anthropic" | "openai" | "google" | "openrouter";

/** Agent config — provider + model pair. */
export interface AgentSpec {
  provider: Provider;
  model: string;
}

export interface SingleComponentParams {
  userPrompt: string;
  contract?: DataContract;
  /** Shell type for layout-adaptive boilerplate */
  shellType?: "chat" | "fullscreen" | "spatial";
  /** Target screen size for responsive layout */
  screen?: "mobile" | "tablet" | "desktop" | "universal";
  evaluation?: {
    enabled: boolean;
    passThreshold: number;
    maxRounds?: number;
    maxBudgetPerEval?: number;
    maxBudgetPerFix?: number;
  };
  visualEvaluation?: {
    enabled: boolean;
    passThreshold?: number;
    sampleProps?: JsonObject;
    viewport?: { width: number; height: number };
  };
  onProgress?: (event: unknown) => void;
  onInitialResult?: (result: {
    componentCode: string;
    sourceCode?: string;
  }) => void | Promise<void>;
  qualityConfig?: QualityConfig;
  /**
   * Optional fixture props (e.g., a benchmark commit's `props` field).
   * Forwarded to runCheck → runtimeRender for schema-first mockup synthesis.
   * Production callers omit this; benchmark runners pass commit.props.
   */
  fixtureProps?: JsonObject;
}

// =============================================================================
// System Prompt (back-compat wrapper)
// =============================================================================

/**
 * Build the coding-agent system prompt using the full content stack:
 * env-gated pitfalls from `pitfalls.ts`, design-token reference from
 * `sdk/design-system-docs.ts`, primitives + wire auto-gen docs.
 *
 * Positional signature preserved for existing callers (create-harness.ts).
 * The underlying skeleton + criteria defaults live in
 * `@ggui-ai/ui-gen/boilerplate`. External OSS implementers calling
 * `buildSystemPrompt` from ui-gen directly get a clean default-empty prompt
 * with only the criteria block filled in.
 *
 * The optional `appGadgets` arg carries the operator-registered gadget
 * catalog. When provided, the prompt renders the registered catalog
 * (Leaflet, Mapbox, …) in the `clientCapabilities — registered catalog`
 * table; when omitted, it defaults to `STDLIB_GADGETS`. Production
 * callers (push, ops-generate) thread the resolved catalog from the
 * bound `AppMetadataStore`; benchmark / direct callers may omit it.
 */
export function buildSystemPrompt(
  userRequest: string,
  shellType?: string,
  screen?: string,
  axisDelta?: string,
  appGadgets?: readonly GadgetDescriptor[],
  /**
   * A `package -> .d.ts content` map for third-party gadget wrappers.
   * Forwarded to the skeleton builder so the gadget catalog renders a
   * `Type:` line per third-party gadget (its signature is extracted
   * from the `.d.ts`). When omitted, no `Type:` line is rendered —
   * stdlib gadgets do not need one.
   */
  gadgetTypes?: Readonly<Record<string, string>>,
): string {
  return buildSystemPromptSkeleton({
    userRequest,
    shellType,
    screen,
    axisDelta,
    pitfallsBlock: renderPitfallsBlock(),
    designSystemDocs: DEFAULT_DESIGN_SYSTEM_DOCS,
    primitivesDoc: PRIMITIVES_DOCUMENTATION,
    wireDoc: WIRE_DOCUMENTATION,
    appGadgets,
    gadgetTypes,
    // criteriaBlock left undefined — ui-gen fills default from open CRITERIA.
  });
}
