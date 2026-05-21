// core/src/harness/apply-line-ranges.test.ts
//
// Tests for the pure patch engine, promoted to @ggui-ai/ui-gen/patch.
// Test stays in core/ because vitest is already wired here and the
// assertion set is the same against the imported implementation — no
// test-side semantics changed in the lift.

import { describe, expect, it } from "vitest";
import { applyLineRanges, defaultApplyPatch } from "../patch.js";

const SRC = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");

describe("applyLineRanges — happy paths", () => {
  it("replaces a single line", () => {
    const result = applyLineRanges(SRC, [{ startLine: 2, endLine: 2, code: ["NEW"] }]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.sourceAfter).toBe(
      ["line 1", "NEW", "line 3", "line 4", "line 5"].join("\n"),
    );
  });

  it("replaces a range with more lines than it had (growth)", () => {
    const result = applyLineRanges(SRC, [
      { startLine: 3, endLine: 4, code: ["a", "b", "c"] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.sourceAfter).toBe(
      ["line 1", "line 2", "a", "b", "c", "line 5"].join("\n"),
    );
  });

  it("deletes a range when code is empty string", () => {
    const result = applyLineRanges(SRC, [{ startLine: 2, endLine: 3, code: [""] }]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.sourceAfter).toBe(
      ["line 1", "", "line 4", "line 5"].join("\n"),
    );
  });

  it("applies multiple non-overlapping changes in reverse (preserves line numbers)", () => {
    const result = applyLineRanges(SRC, [
      { startLine: 1, endLine: 1, code: ["FIRST"] },
      { startLine: 4, endLine: 5, code: ["LAST"] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.sourceAfter).toBe(
      ["FIRST", "line 2", "line 3", "LAST"].join("\n"),
    );
  });

  it("sorts unsorted input changes", () => {
    const result = applyLineRanges(SRC, [
      { startLine: 4, endLine: 5, code: ["LAST"] },
      { startLine: 1, endLine: 1, code: ["FIRST"] },
    ]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.sourceAfter).toBe(
      ["FIRST", "line 2", "line 3", "LAST"].join("\n"),
    );
  });
});

describe("applyLineRanges — errors", () => {
  it("fails on empty changes array", () => {
    const result = applyLineRanges(SRC, []);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error).toMatch(/No changes/i);
  });

  it("fails on overlapping ranges", () => {
    const result = applyLineRanges(SRC, [
      { startLine: 1, endLine: 3, code: ["a"] },
      { startLine: 2, endLine: 4, code: ["b"] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error).toMatch(/overlap/i);
  });

  it("fails on empty code array", () => {
    const result = applyLineRanges(SRC, [{ startLine: 1, endLine: 1, code: [] }]);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error).toMatch(/empty code/i);
  });

  it("fails on out-of-bounds line range", () => {
    const result = applyLineRanges(SRC, [{ startLine: 100, endLine: 101, code: ["x"] }]);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error).toMatch(/Invalid line range/i);
  });

  it("fails on inverted range (endLine < startLine)", () => {
    const result = applyLineRanges(SRC, [{ startLine: 5, endLine: 3, code: ["x"] }]);
    expect(result.ok).toBe(false);
  });
});

describe("defaultApplyPatch — PatchFn wrapper", () => {
  it("wraps applyLineRanges as an async PatchFn", async () => {
    const result = await defaultApplyPatch({
      sourceBefore: SRC,
      changes: [{ startLine: 1, endLine: 1, code: ["NEW"] }],
    });
    expect(result.ok).toBe(true);
    expect(result.sourceAfter).toContain("NEW");
  });

  it("returns error field on failure", async () => {
    const result = await defaultApplyPatch({
      sourceBefore: SRC,
      changes: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
