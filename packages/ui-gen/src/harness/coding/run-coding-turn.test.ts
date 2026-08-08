// Regression test for the state-machine tool advertisement (2026-04-14).
//
// Exactly ONE authoring tool advertised per turn — the harness picks based
// on workspace state, not the LLM:
//   - forceEscape (dupe-fingerprint hit): `APPLY_CHANGES_TOOL_SCOPED`
//   - consecutiveBrokenApplies >= 3: `REWRITE_TOOL` (escape from tangle)
//   - otherwise: `APPLY_CHANGES_TOOL` + `GET_ICONS_TOOL` (read-only helper)
//
// Turn 1 is no longer special-cased to advertise `write` — the boilerplate
// is scaffold-committed before coding starts, so the LLM fills it in via
// apply_changes like any other turn.

import { describe, expect, it } from "vitest";
import { selectTurnTools } from "./run-coding-turn";

describe("selectTurnTools", () => {
  it("turn 1: apply_changes + get_available_icons (no write/rewrite)", () => {
    const names = selectTurnTools(1).map((t) => t.name);
    expect(names).toContain("apply_changes");
    expect(names).toContain("get_available_icons");
    expect(names).not.toContain("write");
    expect(names).not.toContain("rewrite");
  });

  it("turn 2+: apply_changes + get_available_icons (no rewrite by default)", () => {
    const names = selectTurnTools(5).map((t) => t.name);
    expect(names).toContain("apply_changes");
    expect(names).toContain("get_available_icons");
    expect(names).not.toContain("rewrite");
  });

  it("consecutiveBrokenApplies=3 triggers rewrite escape", () => {
    const tools = selectTurnTools(5, false, 3);
    expect(tools.map((t) => t.name)).toEqual(["rewrite"]);
  });

  it("consecutiveBrokenApplies=5 still rewrite (stays in escape until reset)", () => {
    const tools = selectTurnTools(5, false, 5);
    expect(tools.map((t) => t.name)).toEqual(["rewrite"]);
  });

  it("forceEscape overrides everything to scoped-patch only", () => {
    const tools = selectTurnTools(5, true, 10);
    expect(tools.map((t) => t.name)).toEqual(["apply_changes"]);
  });

  it("consecutiveBrokenApplies=2 is below threshold — normal tools", () => {
    const names = selectTurnTools(5, false, 2).map((t) => t.name);
    expect(names).toContain("apply_changes");
    expect(names).not.toContain("rewrite");
  });
});
