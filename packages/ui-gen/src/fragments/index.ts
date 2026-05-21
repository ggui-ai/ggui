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

import type { AxisKey, HarnessFragment } from "./types.js";
import { renderFragments } from "./render.js";
import { stateFragments } from "./state.js";
import { writeFragments, writeTriggerFragments } from "./writes.js";
import { realtimeFragments } from "./realtime.js";
import { fetchFragments } from "./fetch.js";
import { layoutFragments } from "./layout.js";
import { toolingFragments } from "./tooling.js";

export type { HarnessFragment, ComposedHarness, CacheTier, AxisKey } from "./types.js";

export const FRAGMENT_REGISTRY: Record<AxisKey, Record<string, HarnessFragment>> = {
  render: renderFragments,
  state: stateFragments,
  writes: writeFragments,
  writeTrigger: writeTriggerFragments,
  realtime: realtimeFragments,
  fetch: fetchFragments,
  layout: layoutFragments,
  tooling: toolingFragments,
};

export function lookupFragment(axis: AxisKey, value: string): HarnessFragment | undefined {
  return FRAGMENT_REGISTRY[axis]?.[value];
}
