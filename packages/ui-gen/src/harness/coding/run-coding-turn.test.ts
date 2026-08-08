// Regression test for the state-machine tool advertisement (2026-04-14;
// rewrite-choice amendment 2026-08-08, Experiment 52).
//
// Tool advertisement per turn — the harness picks based on workspace
// state, not the LLM:
//   - forceEscape (dupe-fingerprint hit): `APPLY_CHANGES_TOOL_SCOPED` only
//   - consecutiveBrokenApplies >= 3: `REWRITE_TOOL` + apply variant —
//     non-exclusive since Exp 52 (the exclusive swap produced phantom
//     turns; the escape works because rewrite becomes AVAILABLE, not
//     because apply becomes forbidden)
//   - eval-fix turn carrying >= 3 findings: rewrite offered ALONGSIDE
//     apply (Exp 52: multi-range eval-fix patches break at 49%; rewrite
//     is geometry-free — but at 1-2 findings the patch path is better,
//     so rewrite stays a choice, never a default)
//   - otherwise: `APPLY_CHANGES_TOOL` + `GET_ICONS_TOOL` (read-only helper)
//
// Turn 1 is no longer special-cased to advertise `write` — the boilerplate
// is scaffold-committed before coding starts, so the LLM fills it in via
// apply_changes like any other turn.

import { describe, expect, it } from "vitest";
import { evalFixClosingInstruction, selectTurnTools } from "./run-coding-turn";

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

  it("consecutiveBrokenApplies=3 escape offers rewrite ALONGSIDE apply (non-exclusive, Exp 52)", () => {
    const tools = selectTurnTools(5, false, 3);
    expect(tools.map((t) => t.name)).toEqual(["rewrite", "apply_changes"]);
  });

  it("consecutiveBrokenApplies=5 stays in the non-exclusive escape until reset", () => {
    const tools = selectTurnTools(5, false, 5);
    expect(tools.map((t) => t.name)).toEqual(["rewrite", "apply_changes"]);
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

  it("eval-fix turn with 3 findings offers rewrite alongside apply (Exp 52)", () => {
    const names = selectTurnTools(5, false, 0, "off", "off", false, false, false, "array", 3).map(
      (t) => t.name,
    );
    expect(names).toContain("apply_changes");
    expect(names).toContain("get_available_icons");
    expect(names).toContain("rewrite");
  });

  it("eval-fix turn with 2 findings keeps the patch-only surface (low-k path untouched)", () => {
    const names = selectTurnTools(5, false, 0, "off", "off", false, false, false, "array", 2).map(
      (t) => t.name,
    );
    expect(names).toContain("apply_changes");
    expect(names).not.toContain("rewrite");
  });

  it("forceEscape wins over a high finding count (scoped-patch only)", () => {
    const tools = selectTurnTools(5, true, 0, "off", "off", false, false, false, "array", 3);
    expect(tools.map((t) => t.name)).toEqual(["apply_changes"]);
  });

  it("hashline escape pairs rewrite with the hashline apply variant", () => {
    const tools = selectTurnTools(5, false, 3, "v2");
    expect(tools.map((t) => t.name)).toEqual(["rewrite", "apply_changes"]);
  });
});

// Exp 52a H1' — the closing instruction is the binding constraint on tool
// choice (10/10 apply-picks with rewrite offered but the instruction
// naming apply_changes). When rewrite is offered, the instruction must be
// tool-NEUTRAL; when it isn't, the original single-patch instruction
// stands (an instruction naming an unoffered tool is the H3 bug class).
describe("evalFixClosingInstruction", () => {
  it("default: the original single-apply instruction, naming no other tool", () => {
    const s = evalFixClosingInstruction(false, false);
    expect(s).toContain("apply_changes");
    expect(s).not.toContain("rewrite");
  });

  it("rewrite offered: tool-neutral choice naming BOTH tools", () => {
    const s = evalFixClosingInstruction(true, false);
    expect(s).toContain("apply_changes");
    expect(s).toContain("rewrite");
  });

  it("GGUI_BATCH_FIX opt-in wins unchanged (exp61 preservation)", () => {
    const s = evalFixClosingInstruction(true, true);
    expect(s).toContain("Fix EVERY error");
    expect(s).not.toContain("rewrite");
  });
});
