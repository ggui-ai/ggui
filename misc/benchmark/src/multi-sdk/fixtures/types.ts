// core/src/benchmarks/multi-sdk/fixtures/types.ts
//
// Shared fixture type for multi-axis benchmarks. Each .fixture.ts exports
// a BenchmarkFixture. The classifier snapshot test imports them all and
// asserts classify(fixture.contract, fixture.prompt) ≈ fixture.expected.

import type {
  AxisVector,
  AxisProvenance,
  RiskTier,
} from "@ggui-ai/ui-gen/classifier";

export interface BenchmarkFixture {
  /** Stable id (matches the commit id in commits.ts when retrofitted). */
  id: string;

  /** Human display name. */
  name: string;

  /** One-sentence description for bench output. */
  description: string;

  /** Complexity hint for benchmarking; drives eval max rounds. */
  complexity: "simple" | "medium" | "complex";

  /** Minimum passing score for bench green gate. */
  expectedMinScore: number;

  /** Shell type (for boilerplate generation). */
  shellType: "chat" | "fullscreen" | "spatial";

  /** Target viewport. */
  screen: "mobile" | "tablet" | "desktop" | "universal";

  /**
   * Natural-language prompt fed to the generator LLM.
   * Verbatim — do not transform or truncate before generation.
   */
  prompt: string;

  /**
   * Data contract (matches @ggui-ai/protocol DataContract shape).
   * Pure data/capability — NO presentation fields (no render, layout, gesture hints).
   */
  contract: unknown;

  /**
   * Sample props for render-time preview in the benchmarks app.
   * Must satisfy the contract's props schema.
   */
  props: Record<string, unknown>;

  /**
   * Optional blueprint hint — when present, informs the presentation-axis
   * inference (render, layout, writeTrigger). Real blueprints live in
   * cloud/amplify/data/screen-blueprints/; this field is used only if
   * we're testing blueprint-aware inference.
   */
  blueprint?: {
    mechanic?: "static" | "drag" | "swipe" | "live" | "form";
    layoutHint?: string;
  };

  /**
   * Classifier expectations — snapshot test asserts against these.
   */
  expected: {
    vector: AxisVector;
    riskTier: RiskTier;
    provenance: AxisProvenance;
  };

  /**
   * Evaluation goals the generated code must demonstrate.
   * Prose for bench review + axis-check authoring reference.
   */
  evalGoals: string[];

  /**
   * Why this fixture is not reducible to an existing one — short note
   * about the axis values it uniquely covers.
   */
  whyNotReducible: string;
}
