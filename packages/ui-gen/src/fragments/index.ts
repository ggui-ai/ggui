// packages/ui-gen/src/fragments/index.ts
//
// Public barrel for the `@ggui-ai/ui-gen/fragments` subpath.
//
// Stable public surface (what external consumers should build against):
//   - `FRAGMENT_REGISTRY`  — the axis-keyed registry
//   - `lookupFragment`     — the one-call lookup helper
//   - fragment types       — HarnessFragment, ComposedHarness, CacheTier, AxisKey
//
// Per-axis fragment records (renderFragments, stateFragments, etc.) are
// intentionally NOT re-exported here — consumers who genuinely need one
// can read `FRAGMENT_REGISTRY.render` / `.state` / etc. Keeping the public
// surface to a single entry point preserves our freedom to reshape the
// per-axis files without breaking semver.

import type { AxisKey, HarnessFragment, RevealedProp } from "./types.js";
import { renderFragments } from "./render.js";
import { stateFragments } from "./state.js";
import { writeFragments, writeTriggerFragments } from "./writes.js";
import { realtimeFragments } from "./realtime.js";
import { fetchFragments } from "./fetch.js";
import { layoutFragments } from "./layout.js";
import { toolingFragments } from "./tooling.js";
import { choiceFragments } from "./choice.js";
import { REVEALED_PROPS } from "./revealed-props.js";

export type { HarnessFragment, ComposedHarness, CacheTier, AxisKey, RevealedProp } from "./types.js";
export { REVEALED_PROPS } from "./revealed-props.js";

/** One revealed prop as its fragment teaches it: the declaration, who takes it, and its whole docblock verbatim. */
export function revealedPropLine(p: RevealedProp): string {
  return `- \`${p.prop}: ${p.type}\` on ${p.components.map((c) => `\`<${c}>\``).join(", ")} — ${p.description}`;
}

/**
 * Each axis value's fragment, with the props revealed for that value appended (ggui#2010). A revealed prop is absent
 * from the component reference, so this is its one home; a value with revealed props but no authored fragment gets
 * the props alone.
 */
function withRevealedProps(
  registry: Record<AxisKey, Record<string, HarnessFragment>>,
): Record<AxisKey, Record<string, HarnessFragment>> {
  const out = Object.fromEntries(
    Object.entries(registry).map(([axis, values]) => [axis, { ...values }]),
  ) as Record<AxisKey, Record<string, HarnessFragment>>;
  for (const p of REVEALED_PROPS) {
    const base = out[p.axis][p.value] ?? { axis: p.axis, value: p.value, cacheTier: "axisDelta" as const };
    const head = base.promptText ? `${base.promptText}\n` : "";
    const lead = head.includes("\n- `") ? "" : "Props for it, not in the component reference:\n";
    out[p.axis][p.value] = { ...base, promptText: `${head}${lead}${revealedPropLine(p)}` };
  }
  return out;
}

export const FRAGMENT_REGISTRY: Record<AxisKey, Record<string, HarnessFragment>> = withRevealedProps({
  render: renderFragments,
  state: stateFragments,
  writes: writeFragments,
  writeTrigger: writeTriggerFragments,
  realtime: realtimeFragments,
  fetch: fetchFragments,
  layout: layoutFragments,
  tooling: toolingFragments,
  choice: choiceFragments,
});

export function lookupFragment(axis: AxisKey, value: string): HarnessFragment | undefined {
  return FRAGMENT_REGISTRY[axis]?.[value];
}

/**
 * ggui#2010 — whether a harness's prompt taught the offered-items choice fragment (and with it the chip example), read
 * off the fragments that reached the prompt (`how.fragments`). The no-truncate fix names the example only then.
 */
export function offeredChoiceTaught(fragments: readonly HarnessFragment[]): boolean {
  return fragments.some((f) => f.axis === "choice" && f.value === "offered-items");
}
