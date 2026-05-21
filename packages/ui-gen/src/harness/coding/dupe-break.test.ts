// Fingerprint stability + mechanism regression for Experiment #41
// duplicate-patch break (core/src/harness/coding/dupe-break.ts).

import { describe, it, expect } from "vitest";
import {
  computePatchFingerprint,
  createDupeBreakState,
  errorClassBucket,
  type PatchChange,
} from "./dupe-break";

describe("errorClassBucket", () => {
  it("lowercases + collapses whitespace + truncates to 60 chars", () => {
    const raw = "Unexpected closing  \"Stack\"  tag   does not match opening \"Row\" tag extra extra stuff";
    const b = errorClassBucket(raw);
    expect(b.length).toBeLessThanOrEqual(60);
    expect(b).toMatch(/^unexpected closing/);
    // whitespace normalized to single spaces
    expect(b).not.toMatch(/\s{2,}/);
  });

  it("empty / undefined produces a deterministic fallback", () => {
    expect(errorClassBucket("")).toBe("unknown");
  });
});

describe("computePatchFingerprint", () => {
  const sameRanges: PatchChange[] = [
    { startLine: 47, endLine: 47, code: ["  const x = 1"] },
    { startLine: 71, endLine: 75, code: ["  return (", "    <Box />", "  )"] },
  ];

  it("byte-identical patches + same error → identical fingerprint", () => {
    const a = computePatchFingerprint(sameRanges, 'Unexpected "}" at line 71');
    const b = computePatchFingerprint(sameRanges, 'Unexpected "}" at line 71');
    expect(a).toBe(b);
  });

  it("reordered changes produce the same fingerprint (normalization)", () => {
    const reordered: PatchChange[] = [...sameRanges].reverse();
    const a = computePatchFingerprint(sameRanges, "err");
    const b = computePatchFingerprint(reordered, "err");
    expect(a).toBe(b);
  });

  it("trivial whitespace drift in code is normalized away", () => {
    const withExtraSpaces: PatchChange[] = [
      { startLine: 47, endLine: 47, code: ["  const x = 1   "] }, // trailing ws
      { startLine: 71, endLine: 75, code: ["  return (", "    <Box />", "  )"] },
    ];
    const a = computePatchFingerprint(sameRanges, "err");
    const b = computePatchFingerprint(withExtraSpaces, "err");
    expect(a).toBe(b);
  });

  it("different ranges produce different fingerprints", () => {
    const differentRanges: PatchChange[] = [
      { startLine: 47, endLine: 47, code: ["  const x = 1"] },
      { startLine: 80, endLine: 80, code: ["  return (", "    <Box />", "  )"] },
    ];
    const a = computePatchFingerprint(sameRanges, "err");
    const b = computePatchFingerprint(differentRanges, "err");
    expect(a).not.toBe(b);
  });

  it("same patch, DIFFERENT error class → different fingerprint (Codex tweak #2)", () => {
    const a = computePatchFingerprint(sameRanges, 'Unexpected "}"');
    const b = computePatchFingerprint(sameRanges, "Unterminated regular expression");
    expect(a).not.toBe(b);
  });

  it("produces a 64-char hex SHA-256 digest", () => {
    const fp = computePatchFingerprint(sameRanges, "err");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts code-as-string (Google Gemini deviation from schema)", () => {
    // Bench observation 2026-04-14: Google sometimes emits `code` as a
    // single string instead of `string[]` despite the apply_changes
    // schema. Fingerprint must not crash and should produce the same
    // hash as the equivalent single-element array.
    const asArray: PatchChange[] = [
      { startLine: 47, endLine: 47, code: ["  const x = 1"] },
    ];
    const asString: PatchChange[] = [
      { startLine: 47, endLine: 47, code: "  const x = 1" },
    ];
    const a = computePatchFingerprint(asArray, "err");
    const b = computePatchFingerprint(asString, "err");
    expect(a).toBe(b);
  });
});

describe("createDupeBreakState", () => {
  it("initializes to clean state (no fingerprint, no force, no cooldown)", () => {
    const s = createDupeBreakState();
    expect(s.lastFailedPatchFingerprint).toBeNull();
    expect(s.forceEscapeNextTurn).toBe(false);
    expect(s.pendingDiagnosticTurn).toBe(false);
    expect(s.cooldown).toBe(0);
    expect(s.firedCount).toBe(0);
    expect(s.scopedEscapeUsedCount).toBe(0);
    expect(s.awaitingDiagnosticOutcome).toBe(false);
    expect(s.diagnosticFiredCount).toBe(0);
    expect(s.diagnosticReturnedCount).toBe(0);
    expect(s.diagnosticBrokeLoopCount).toBe(0);
    expect(s.recentFailedPatches).toEqual([]);
  });

  it("returns a fresh object each call (no shared mutation)", () => {
    const a = createDupeBreakState();
    const b = createDupeBreakState();
    a.firedCount = 5;
    a.forceEscapeNextTurn = true;
    a.scopedEscapeUsedCount = 2;
    a.pendingDiagnosticTurn = true;
    a.diagnosticFiredCount = 3;
    a.recentFailedPatches.push({ rangesShort: "1-1", codeHead: "x", errClass: "y", fingerprint: "z" });
    expect(b.firedCount).toBe(0);
    expect(b.forceEscapeNextTurn).toBe(false);
    expect(b.scopedEscapeUsedCount).toBe(0);
    expect(b.pendingDiagnosticTurn).toBe(false);
    expect(b.diagnosticFiredCount).toBe(0);
    expect(b.recentFailedPatches).toEqual([]);
  });
});
