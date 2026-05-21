// Unit tests for the hashline helper.

import { describe, it, expect } from "vitest";
import {
  computeLineHash,
  formatWithHashlines,
  parseHashlineRef,
  validateHashlineRefs,
  formatHashlineStaleMessage,
} from "./hashline";

describe("computeLineHash", () => {
  it("returns 2 hex chars", () => {
    const h = computeLineHash("const x = 1;");
    expect(h).toMatch(/^[0-9a-f]{2}$/);
  });

  it("is deterministic for same content", () => {
    expect(computeLineHash("hello")).toBe(computeLineHash("hello"));
  });

  it("is whitespace-sensitive", () => {
    expect(computeLineHash("x = 1")).not.toBe(computeLineHash("x =  1"));
  });

  it("handles empty line", () => {
    const h = computeLineHash("");
    expect(h).toMatch(/^[0-9a-f]{2}$/);
  });
});

describe("formatWithHashlines", () => {
  it("formats each line with N:hh│ prefix", () => {
    const input = "a\nbb\nccc";
    const out = formatWithHashlines(input).split("\n");
    expect(out).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(out[i]).toMatch(new RegExp(`^${i + 1}:[0-9a-f]{2}│`));
    }
  });

  it("preserves original content after separator", () => {
    const out = formatWithHashlines("hello world");
    expect(out).toContain("│hello world");
  });

  it("line 1 has index 1 (not 0)", () => {
    const out = formatWithHashlines("only line");
    expect(out).toMatch(/^1:[0-9a-f]{2}│only line$/);
  });
});

describe("parseHashlineRef", () => {
  it("parses valid refs", () => {
    expect(parseHashlineRef("47:a3")).toEqual({ line: 47, expectedHash: "a3" });
    expect(parseHashlineRef("1:ff")).toEqual({ line: 1, expectedHash: "ff" });
    expect(parseHashlineRef("999:00")).toEqual({ line: 999, expectedHash: "00" });
  });

  it("lowercases the hash", () => {
    expect(parseHashlineRef("5:AB")).toEqual({ line: 5, expectedHash: "ab" });
  });

  it("rejects bad formats", () => {
    expect(parseHashlineRef("47")).toBeNull(); // no hash
    expect(parseHashlineRef("47:")).toBeNull(); // empty hash
    expect(parseHashlineRef("47:a")).toBeNull(); // only 1 char
    expect(parseHashlineRef("47:abc")).toBeNull(); // 3 chars
    expect(parseHashlineRef("47:zz")).toBeNull(); // not hex
    expect(parseHashlineRef("-1:aa")).toBeNull(); // negative
    expect(parseHashlineRef(47)).toBeNull(); // number not string
    expect(parseHashlineRef(null)).toBeNull();
    expect(parseHashlineRef(undefined)).toBeNull();
  });
});

describe("validateHashlineRefs", () => {
  const source = ["aaa", "bbb", "ccc", "ddd"].join("\n");
  // Compute expected hashes for each line (precomputed for stable tests)
  const h = (s: string) => computeLineHash(s);

  it("passes when all hashes match", () => {
    const issues = validateHashlineRefs(source, [
      { startLine: 1, endLine: 2, expectedStartHash: h("aaa"), expectedEndHash: h("bbb") },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags mismatched startLine hash", () => {
    const issues = validateHashlineRefs(source, [
      { startLine: 1, endLine: 2, expectedStartHash: "zz", expectedEndHash: h("bbb") },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("startLine");
    expect(issues[0]!.line).toBe(1);
    expect(issues[0]!.actualContent).toBe("aaa");
  });

  it("flags mismatched endLine hash", () => {
    const issues = validateHashlineRefs(source, [
      { startLine: 1, endLine: 2, expectedStartHash: h("aaa"), expectedEndHash: "zz" },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("endLine");
    expect(issues[0]!.line).toBe(2);
  });

  it("is case-insensitive on expected hash", () => {
    const upper = h("aaa").toUpperCase();
    const issues = validateHashlineRefs(source, [
      { startLine: 1, endLine: 1, expectedStartHash: upper, expectedEndHash: h("aaa") },
    ]);
    expect(issues).toEqual([]);
  });

  it("skips validation when expectedHash is undefined (backward-compat)", () => {
    const issues = validateHashlineRefs(source, [
      { startLine: 1, endLine: 2 },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags out-of-bounds lines", () => {
    const issues = validateHashlineRefs(source, [
      { startLine: 100, endLine: 101, expectedStartHash: "aa", expectedEndHash: "bb" },
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0]!.actualContent).toContain("out of bounds");
  });

  it("catches multiple mismatches across multiple changes", () => {
    const issues = validateHashlineRefs(source, [
      { startLine: 1, endLine: 1, expectedStartHash: "wrong", expectedEndHash: "wrong" }, // wrong length, still flagged
      { startLine: 3, endLine: 3, expectedStartHash: h("ccc"), expectedEndHash: h("ccc") }, // OK
      { startLine: 4, endLine: 4, expectedStartHash: "zz", expectedEndHash: h("ddd") }, // one wrong
    ]);
    // First change: startLine hash mismatch AND endLine hash mismatch → 2 issues on change 0
    // Third change: startLine hash mismatch → 1 issue
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.every((i) => i.changeIndex === 0 || i.changeIndex === 2)).toBe(true);
  });
});

describe("formatHashlineStaleMessage", () => {
  it("includes each issue's details", () => {
    const source = ["line A", "line B"].join("\n");
    const issues = validateHashlineRefs(source, [
      { startLine: 1, endLine: 2, expectedStartHash: "zz", expectedEndHash: computeLineHash("line B") },
    ]);
    const msg = formatHashlineStaleMessage(issues);
    expect(msg).toContain("HASHLINE_STALE");
    expect(msg).toContain("line A"); // actual content shown
    expect(msg).toContain("1:zz"); // the bad ref
  });
});
