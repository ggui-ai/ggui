// packages/ui-gen/src/compose.axis-order.2010.test.ts
//
// ggui#2010 — the axis order IS the section order of Shape Guidance. `compose()` pushes one fragment per axis in
// `AXIS_ORDER` and joins their prompt texts in that order; `createHarness` hands the join to the system prompt as
// `axisDelta`, rendered under `## Shape Guidance`. Nothing else in this package holds the order, so this pin does: a
// reorder re-records the list below, with the reason for the new position.

import { describe, expect, it } from "vitest";
import type { Classification } from "./classifier/index.js";
import { compose } from "./compose.js";
import { FRAGMENT_REGISTRY, type AxisKey } from "./fragments/index.js";

/** Every axis, in the order the model reads its section, and why it sits there. */
const AXIS_ORDER_OF_RECORD: readonly AxisKey[] = [
  "render", // what the card IS — the shape every later section assumes
  "layout", // how that shape is arranged on the screen
  "state", // what the card holds between turns
  "writes", // what the visitor can change
  "writeTrigger", // the gesture that commits a write
  "realtime", // how new data arrives while the card is open
  "fetch", // how more data is asked for
  "tooling", // wired vs client-side helpers
  "choice", // props for a group the earlier axes already shaped — last, so it reads as detail, not shape
];

const provenance: Classification["provenance"] = {
  render: "default",
  state: "default",
  writes: "default",
  writeTrigger: "default",
  realtime: "default",
  fetch: "default",
  layout: "default",
  tooling: "default",
  choice: "default",
};

/** One value per axis that carries prompt text, so every section is present and its position readable. */
const FULL: Classification = {
  vector: {
    render: "list",
    layout: "multi-step",
    state: "merge",
    writes: "commit",
    writeTrigger: "drag",
    realtime: "append",
    fetch: "search",
    tooling: "wired",
    choice: "offered-items",
  },
  provenance,
  riskTier: "low",
};

describe("ggui#2010 — the axis order is the Shape Guidance section order", () => {
  it("the registry has exactly the axes of record — an axis the order does not name would never compose", () => {
    expect(Object.keys(FRAGMENT_REGISTRY).sort()).toEqual([...AXIS_ORDER_OF_RECORD].sort());
  });

  it("every value in the full vector carries prompt text, so the pin reads sections, not only fragments", () => {
    for (const axis of AXIS_ORDER_OF_RECORD) {
      const value = FULL.vector[axis];
      expect(FRAGMENT_REGISTRY[axis][value]?.promptText?.trim(), `${axis}=${value}`).toBeTruthy();
    }
  });

  it("composes one fragment per axis, in the order of record", () => {
    expect(compose(FULL).fragments.map((f) => f.axis)).toEqual(AXIS_ORDER_OF_RECORD);
  });

  it("joins the prompt sections in that same order", () => {
    const composed = compose(FULL);
    let last = -1;
    for (const f of composed.fragments) {
      const at = composed.promptText.indexOf(f.promptText!.trim());
      expect(at, `${f.axis}=${f.value} section present`).toBeGreaterThan(last);
      last = at;
    }
  });

  it("a text-less value keeps its axis's slot: choice=none is the last fragment and adds no section", () => {
    const composed = compose({ ...FULL, vector: { ...FULL.vector, choice: "none" } });
    expect(composed.fragments.map((f) => f.axis)).toEqual(AXIS_ORDER_OF_RECORD);
    expect(composed.promptText).not.toContain("## Choice");
  });
});
