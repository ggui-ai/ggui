// Tests for experiment #45 — axis-keyed primitives doc slice.

import { describe, it, expect } from "vitest";
import {
  computePrimitiveAllowlist,
  slicePrimitiveDocumentation,
} from "./primitive-slice";
import type { Classification } from "../classifier/index.js";
// Static import — was dynamic inside each `it()`, which tipped over
// vitest's 5s default timeout under parallel turbo load
// (PRIMITIVES_DOCUMENTATION is a ~130KB string assembled at module
// evaluation). Static import is cached at worker level, paid once.
import { PRIMITIVES_DOCUMENTATION } from "../validation/index.js";

function fakeClassification(overrides: Partial<Classification["vector"]> = {}): Classification {
  return {
    vector: {
      render: "static",
      state: "none",
      writes: "none",
      writeTrigger: "click",
      realtime: "none",
      fetch: "none",
      layout: "single",
      tooling: "none",
      ...overrides,
    },
    provenance: {
      render: "default",
      state: "default",
      writes: "default",
      writeTrigger: "default",
      realtime: "default",
      fetch: "default",
      layout: "default",
      tooling: "default",
    },
    riskTier: "low",
  };
}

describe("computePrimitiveAllowlist", () => {
  it("always includes core primitives regardless of axes", () => {
    const allowlist = computePrimitiveAllowlist(fakeClassification());
    // Core primitives must always be present
    for (const core of ["Container", "Stack", "Row", "Box", "Card", "Text", "Heading", "Button", "Icon"]) {
      expect(allowlist).toContain(core);
    }
  });

  it("writes=submit adds form primitives", () => {
    const allowlist = computePrimitiveAllowlist(
      fakeClassification({ writes: "submit", state: "payload" }),
    );
    for (const p of ["Input", "TextArea", "Select", "Checkbox", "RadioGroup", "Slider", "FormField"]) {
      expect(allowlist).toContain(p);
    }
  });

  it("render=grid adds CardGrid + Image", () => {
    const allowlist = computePrimitiveAllowlist(
      fakeClassification({ render: "grid" }),
    );
    expect(allowlist).toContain("CardGrid");
    expect(allowlist).toContain("Image");
  });

  it("realtime=merge adds Spinner + Badge + Alert", () => {
    const allowlist = computePrimitiveAllowlist(
      fakeClassification({ realtime: "merge" }),
    );
    expect(allowlist).toContain("Spinner");
    expect(allowlist).toContain("Badge");
    expect(allowlist).toContain("Alert");
  });

  it("minimal classification (all defaults) produces the smallest allowlist", () => {
    const minimal = computePrimitiveAllowlist(fakeClassification());
    // Should be exactly the core set (sorted)
    expect(minimal.length).toBeGreaterThanOrEqual(10);
    expect(minimal.length).toBeLessThan(15);
  });

  it("maximal classification includes most primitives but not all", () => {
    // risk:high kanban-board-style: merge state, per-item writes, realtime
    const allowlist = computePrimitiveAllowlist(
      fakeClassification({
        render: "list",
        state: "merge",
        writes: "per-item",
        writeTrigger: "drag",
        realtime: "merge",
        fetch: "none",
        layout: "master-detail",
        tooling: "wired",
      }),
    );
    // Still shouldn't include every primitive; Tooltip, Accordion,
    // CommentThread, etc. aren't triggered by these axes.
    expect(allowlist).not.toContain("Tooltip");
    expect(allowlist).not.toContain("Accordion");
    // But should have a lot of the interactive + display primitives
    expect(allowlist.length).toBeGreaterThan(15);
  });

  it("returns a deterministic sorted array (same input → same output)", () => {
    const c = fakeClassification({ render: "list", writes: "commit" });
    const a1 = computePrimitiveAllowlist(c);
    const a2 = computePrimitiveAllowlist(c);
    expect(a1).toEqual(a2);
    // Sorted
    expect([...a1].sort()).toEqual([...a1]);
  });
});

describe("slicePrimitiveDocumentation", () => {
  const sampleDoc = `# Preamble

Some intro text.

## Primitives

Import: \`import { Component } from '@ggui-ai/design/primitives'\`

### Container

Container description.

### Stack

Stack description.

### Button

Button description.

### Input

Input description.
`;

  it("keeps preamble + intro verbatim", () => {
    const sliced = slicePrimitiveDocumentation(sampleDoc, ["Container"]);
    expect(sliced).toContain("# Preamble");
    expect(sliced).toContain("## Primitives");
    expect(sliced).toContain("Some intro text");
    expect(sliced).toContain("### Container");
  });

  it("drops primitives not in allowlist", () => {
    const sliced = slicePrimitiveDocumentation(sampleDoc, ["Container", "Button"]);
    expect(sliced).toContain("### Container");
    expect(sliced).toContain("### Button");
    expect(sliced).not.toContain("### Stack");
    expect(sliced).not.toContain("### Input");
  });

  it("empty allowlist drops all sections, keeps preamble", () => {
    const sliced = slicePrimitiveDocumentation(sampleDoc, []);
    expect(sliced).toContain("# Preamble");
    expect(sliced).not.toContain("### Container");
  });

  it("falls back to full doc when no `### ` sections found (defensive)", () => {
    const weird = "Just a preamble, no sections here.";
    const sliced = slicePrimitiveDocumentation(weird, ["Container"]);
    expect(sliced).toBe(weird);
  });

  it("slice of typical risk:medium fixture is meaningfully smaller than full", () => {
    const allowlist = computePrimitiveAllowlist(
      fakeClassification({ writes: "submit", state: "payload", layout: "multi-step" }),
    );
    const sliced = slicePrimitiveDocumentation(PRIMITIVES_DOCUMENTATION, allowlist);
    const full = PRIMITIVES_DOCUMENTATION.length;
    const cut = sliced.length;
    // Gate 1 threshold: slice ≤ 60% of full. Register as a structural
    // mechanism test so CI catches regressions in the allowlist logic.
    expect(cut).toBeLessThan(full * 0.6);
    // But not so aggressive that we drop everything (sanity)
    expect(cut).toBeGreaterThan(full * 0.1);
  });

  it("ALWAYS preserves cross-cutting GUIDANCE sections (onChange/Import/Elevation/etc)", () => {
    // Regression guard: the original slicer treated `### onChange Behavior`,
    // `### Import Constraints`, etc. as primitive sections and dropped them
    // when their first word wasn't in the allowlist. Those sections contain
    // rules the LLM needs REGARDLESS of axis (e.g. the "do NOT add new
    // imports" rule lives in `### Import Constraints`). They must survive
    // every slice, even the most aggressive low-risk one.
    const minimalAllowlist = computePrimitiveAllowlist(fakeClassification());
    const sliced = slicePrimitiveDocumentation(
      PRIMITIVES_DOCUMENTATION,
      minimalAllowlist,
    );
    // Critical guidance sections must all be present in the sliced output.
    expect(sliced).toContain("onChange Behavior");
    expect(sliced).toContain("Import Constraints");
    expect(sliced).toContain("Elevation System");
  });

  it("Badge docs are always present (pitfalls reference its prop API unconditionally)", () => {
    // Triad alignment: runtime.ts's "Common Pitfalls" unconditionally
    // documents Badge's `variant` prop API. If the slice drops Badge's
    // docs on a low-risk fixture, the LLM has pitfall guidance but no
    // prop signature — an invitation to get the API wrong. Badge is in
    // CORE_PRIMITIVES; this test pins the invariant.
    const minimalAllowlist = computePrimitiveAllowlist(fakeClassification());
    expect(minimalAllowlist).toContain("Badge");
    const sliced = slicePrimitiveDocumentation(
      PRIMITIVES_DOCUMENTATION,
      minimalAllowlist,
    );
    expect(sliced).toContain("### Badge");
  });
});
