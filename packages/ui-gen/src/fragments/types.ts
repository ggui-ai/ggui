// packages/ui-gen/src/fragments/types.ts
//
// Harness fragment types. A fragment is a reusable prompt/boilerplate
// chunk keyed by (axis, value). compose() materializes a Classification
// into ordered prompt sections that slot into the axisDelta cache tier
// of the system prompt.

import type { AxisVector } from "../classifier/axes.js";

export type CacheTier = "stable" | "axisDelta" | "volatile";

export type AxisKey = keyof Pick<
  AxisVector,
  "render" | "state" | "writes" | "writeTrigger" | "realtime" | "fetch" | "layout" | "tooling"
>;

export interface HarnessFragment {
  /** Which axis this fragment belongs to. */
  axis: AxisKey;
  /** Which axis value this fragment handles (e.g., "merge" for state). */
  value: string;
  /** Cache tier — stable prefix first, axisDelta middle, volatile last. */
  cacheTier: CacheTier;
  /** System-prompt guidance for this axis value. Empty = no prompt change. */
  promptText?: string;
  /** Boilerplate comment block inserted between wire hooks and return. */
  boilerplateMarker?: string;
  /** Explicit ordering within (cacheTier, axis). Lower first. */
  order?: number;
}

export interface ComposedHarness {
  /** Concatenated promptText from matched fragments, cache-ordered. */
  promptText: string;
  /** Concatenated boilerplateMarker blocks from matched fragments. */
  boilerplateSections: string;
  /** Matched fragments, for debugging/telemetry. */
  fragments: HarnessFragment[];
}
