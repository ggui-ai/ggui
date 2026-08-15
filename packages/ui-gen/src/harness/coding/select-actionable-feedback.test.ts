// Pins for the provenance-aware feedback selection (Exp 54 P1
// addendum, ggui#408). The starved shape these guard: an eval round
// where the LLM leg emits ≥3 fails used to cut every deterministic
// tier-0 finding from the feedback (merge order put them last), while
// the stuck detector still fingerprinted them — a permanently
// undeliverable, unresolvable finding.

import { describe, expect, it } from "vitest";
import type { EvalIssue } from "../../evaluation/types-public.js";
import { selectActionableFeedback } from "./run-eval-round.js";

function issue(over: Partial<EvalIssue>): EvalIssue {
  return {
    tier: 2,
    result: "fail",
    category: "accessibility",
    description: "d",
    fix: "f",
    ...over,
  } as EvalIssue;
}

describe("selectActionableFeedback", () => {
  it("reserves a slot for the tier-0 deterministic fail even when the LLM leg fills the cap (the Exp-54 starved shape)", () => {
    const llmFails = [
      issue({ tier: 2, category: "visual", description: "token nit 1" }),
      issue({ tier: 2, category: "layout", description: "token nit 2" }),
      issue({ tier: 1, category: "functionality", description: "llm fail 3" }),
      issue({ tier: 2, category: "loading", description: "llm fail 4" }),
    ];
    const deterministic = issue({
      tier: 0,
      category: "mode",
      subcategory: "state.ui_affordance.state_aria_present",
      description: "structural a11y gap",
    });
    // Merge order puts the deterministic finding LAST — the pre-fix
    // sort+slice deterministically cut it.
    const selected = selectActionableFeedback([...llmFails, deterministic]);
    expect(selected).toHaveLength(3);
    expect(selected[0]).toBe(deterministic);
  });

  it("reserves exactly ONE slot — crash-class LLM fails keep the other two", () => {
    const det1 = issue({ tier: 0, category: "mode", subcategory: "det-1" });
    const det2 = issue({ tier: 0, category: "mode", subcategory: "det-2" });
    const crash = issue({ tier: 1, category: "crash", description: "runtime crash" });
    const other = issue({ tier: 1, category: "functionality" });
    const selected = selectActionableFeedback([crash, other, det1, det2]);
    expect(selected).toHaveLength(3);
    expect(selected[0]).toBe(det1);
    expect(selected).toContain(crash);
    expect(selected).toContain(other);
    expect(selected).not.toContain(det2);
  });

  it("keeps fails-before-warns ordering when no deterministic fail exists", () => {
    const warn = issue({ result: "warn" });
    const fail = issue({ tier: 1, category: "functionality" });
    const selected = selectActionableFeedback([warn, fail]);
    expect(selected[0]).toBe(fail);
    expect(selected[1]).toBe(warn);
  });

  it("a tier-0 WARN gets no reservation (only fails are machine-blocking)", () => {
    const detWarn = issue({ tier: 0, category: "mode", result: "warn" });
    const f1 = issue({ tier: 1 });
    const f2 = issue({ tier: 2 });
    const f3 = issue({ tier: 2, category: "visual" });
    const selected = selectActionableFeedback([f1, f2, f3, detWarn]);
    expect(selected).toHaveLength(3);
    expect(selected).not.toContain(detWarn);
  });
});
