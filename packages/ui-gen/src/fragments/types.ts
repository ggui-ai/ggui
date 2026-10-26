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
  "render" | "state" | "writes" | "writeTrigger" | "realtime" | "fetch" | "layout" | "tooling" | "choice"
>;

/**
 * A component prop the shared reference leaves out and one axis value's fragment teaches instead (ggui#2010):
 * generated from the design source's `@revealedBy <axis>=<value>` tag (`REVEALED_PROPS`), whole docblock included.
 */
export interface RevealedProp {
  readonly axis: AxisKey;
  readonly value: string;
  /** The prop as declared, `?` included (`maxRows?`). */
  readonly prop: string;
  readonly type: string;
  /** Every component that takes it, aliases included. */
  readonly components: readonly string[];
  /** The prop's whole JSDoc text, joined onto one line. */
  readonly description: string;
}

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
