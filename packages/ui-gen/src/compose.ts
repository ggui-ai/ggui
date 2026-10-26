// packages/ui-gen/src/compose.ts
//
// Materializes a Classification into prompt sections + boilerplate markers.
// Sits between the stable prefix (design system docs, pitfalls) and the
// volatile feedback (eval issues) in the system prompt's cache tiering.
//
// Consumes the `./classifier` and `./fragments` subpaths — it's the
// bridge between an axis vector and the prompt/boilerplate the LLM
// actually sees.

import type { Classification } from "./classifier/axes.js";
import {
  lookupFragment,
  type AxisKey,
  type ComposedHarness,
  type HarnessFragment,
} from "./fragments/index.js";

// The section order of Shape Guidance. `compose()` pushes one fragment per axis in this order and joins their
// prompt texts in it; `createHarness` hands that join to the system prompt as `axisDelta` (the axisDelta cache tier),
// rendered under `## Shape Guidance` — so this is the order the model reads: the most behaviourally consequential
// axes first, `choice` last because it names props for a group the earlier axes have already shaped. Pinned, with a
// reason per position, by `compose.axis-order.2010.test.ts`; a reorder re-records that list.
const AXIS_ORDER: AxisKey[] = [
  "render",
  "layout",
  "state",
  "writes",
  "writeTrigger",
  "realtime",
  "fetch",
  "tooling",
  "choice",
];

export function compose(classification: Classification): ComposedHarness {
  const v = classification.vector;
  const matched: HarnessFragment[] = [];

  for (const axis of AXIS_ORDER) {
    const value = v[axis] as string | undefined;
    if (!value) continue;
    const frag = lookupFragment(axis, value);
    if (frag) matched.push(frag);
  }

  const promptParts = matched
    .filter((f) => f.promptText && f.promptText.trim().length > 0)
    .map((f) => f.promptText!.trim());

  const boilerplateParts = matched
    .filter((f) => f.boilerplateMarker && f.boilerplateMarker.trim().length > 0)
    .map((f) => f.boilerplateMarker!);

  return {
    promptText: promptParts.join("\n\n"),
    boilerplateSections: boilerplateParts.join(""),
    fragments: matched,
  };
}

export type { ComposedHarness };
