// ggui#1652 — the action walk's account reaches the feedback the loop sends
// back: how far it got, why it stopped, and whether any screen rendered a
// control naming the action. It replaces the first button in the page,
// which the probe used to name as "the element" whatever it had pressed.

import { describe, it, expect } from "vitest";
import { toEvalIssue } from "./adapter.js";
import type { RenderCheckIssue } from "./render-check.js";

const unverified = (walk: NonNullable<RenderCheckIssue["diagnostics"]>["walk"]): RenderCheckIssue => ({
  check: "action-wiring",
  outcome: "unverified",
  subject: "submit",
  reason: "Source confirms click wiring exists for action 'submit', but synthetic click did not dispatch it.",
  diagnostics: { walk },
});

describe("toEvalIssue — the action walk's account (ggui#1652)", () => {
  it("says how far the walk got and that no screen rendered the action's control", () => {
    const issue = toEvalIssue(
      unverified({ presses: 9, screens: 4, stoppedBy: "explored", namedControlSeen: false, lastPressed: ["<button>Next</button>", "<button>Back</button>"] })
    );
    expect(issue?.result).toBe("warn");
    expect(issue?.description).toContain(
      "walk: 9 press(es) across 4 screen(s), every reachable control pressed; no screen rendered a control naming the action; last pressed: <button>Next</button>, <button>Back</button>"
    );
    expect(issue?.description).not.toContain("(element:");
  });

  it("tells a named control that did not dispatch from one that never rendered, and names a budget stop", () => {
    const issue = toEvalIssue(unverified({ presses: 2, screens: 2, stoppedBy: "deadline", namedControlSeen: true, lastPressed: [] }));
    expect(issue?.description).toContain(
      "walk: 2 press(es) across 2 screen(s), stopped at the time budget; a control naming the action rendered, but pressing it did not dispatch the action"
    );
    expect(issue?.description).not.toContain("last pressed");
  });
});
