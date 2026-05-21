// packages/ui-gen/src/patch.ts
//
// Pure line-range patch implementation. Mirrors the `apply_changes` tool
// logic (from coding-agent/tools.ts) without workspace / git / preflight
// coupling — the harness exposes this as the default `PatchFn` so
// variants can override with alternative patch grammars (diff3,
// atomic-write, inline-markup, etc.) while reusing the orchestration
// around them.
//
// Invariants:
//   - Changes sorted ascending by startLine.
//   - No overlapping ranges.
//   - All line numbers within [1, fileLines].
//   - Applied in reverse order to preserve upstream line numbers.
//
// This is the default patch function — every production harness uses it
// unless a variant overrides `what.applyPatch`.

import type { PatchFn } from "./harness/types-public.js";

/** Core pure logic — exported separately for tests + alternative wrappers. */
export function applyLineRanges(
  sourceBefore: string,
  rawChanges: ReadonlyArray<{
    startLine: number;
    endLine: number;
    code: readonly string[];
    description?: string;
  }>,
): { ok: true; sourceAfter: string } | { ok: false; error: string } {
  if (rawChanges.length === 0) {
    return { ok: false, error: "No changes provided." };
  }

  // Normalize — stable copy, sort ascending by startLine
  const changes = rawChanges
    .map((c, i) => ({
      startLine: c.startLine,
      endLine: c.endLine,
      code: [...c.code],
      description: c.description ?? `change ${i + 1}`,
    }))
    .sort((a, b) => a.startLine - b.startLine);

  // Required fields + non-empty code
  for (const c of changes) {
    if (typeof c.startLine !== "number" || typeof c.endLine !== "number") {
      return { ok: false, error: `Change "${c.description}" missing startLine or endLine.` };
    }
    if (c.code.length === 0) {
      return {
        ok: false,
        error: `Change "${c.description}" has empty code. Use [""] to delete lines.`,
      };
    }
  }

  // Overlaps
  for (let i = 1; i < changes.length; i++) {
    if (changes[i].startLine <= changes[i - 1].endLine) {
      return {
        ok: false,
        error:
          `Changes overlap — "${changes[i - 1].description}" (lines ` +
          `${changes[i - 1].startLine}-${changes[i - 1].endLine}) overlaps with ` +
          `"${changes[i].description}" (lines ${changes[i].startLine}-${changes[i].endLine}).`,
      };
    }
  }

  // Line-number bounds
  const fileLines = sourceBefore.split("\n");
  for (const c of changes) {
    if (c.startLine < 1 || c.endLine < c.startLine || c.startLine > fileLines.length) {
      return {
        ok: false,
        error:
          `Invalid line range ${c.startLine}-${c.endLine} for "${c.description}". ` +
          `File has ${fileLines.length} lines.`,
      };
    }
  }

  // Apply in reverse to preserve line numbers
  const resultLines = [...fileLines];
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    const deleteCount = c.endLine - c.startLine + 1;
    resultLines.splice(c.startLine - 1, deleteCount, ...c.code);
  }

  return { ok: true, sourceAfter: resultLines.join("\n") };
}

/**
 * Harness-compatible wrapper around `applyLineRanges`. The default
 * patch function attached to every new harness's `what.applyPatch`.
 * Variants can override with alternative implementations (e.g., diff3
 * merge, atomic file write, etc.) to test different patch grammars
 * end-to-end.
 */
export const defaultApplyPatch: PatchFn = async ({ sourceBefore, changes }) => {
  const result = applyLineRanges(sourceBefore, changes);
  if (result.ok) {
    return { ok: true, sourceAfter: result.sourceAfter };
  }
  return { ok: false, error: result.error };
};
