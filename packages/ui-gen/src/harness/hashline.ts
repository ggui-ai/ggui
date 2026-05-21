// Hashline format. The technique injects 2-char content hashes
// alongside line numbers in the file view and requires the LLM to echo
// them in apply_changes references.
//
// The hash serves as a "trusted anchor" — if the file changed since the
// LLM's last read (due to tool interleaving or the model miscounting),
// the hash-check rejects the edit before corruption.
//
// Display format (in `## Current File` block):
//   47:a3│  const x = 1;
//   48:f2│  return x;
//
// LLM emits refs as `"47:a3"` (string) instead of `47` (number) in the
// apply_changes.changes[].startLine / endLine fields when the hashline
// tool is active.

import { createHash } from "node:crypto";

/** Compute a 2-char hex hash of a line's content. Uses SHA-256 trimmed to
 *  2 hex chars (1 byte / 256-space) — enough to disambiguate within a
 *  single file (typical 100-400 line components; collision ~5-20%). The
 *  hash is computed on the RAW line content (no trim), so whitespace
 *  sensitivity is preserved — important for detecting "file changed by
 *  whitespace-only edit." */
export function computeLineHash(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 2);
}

/** Format a file's content with hashlines. Each line becomes `N:hh│content`.
 *  `N` is 1-indexed; line numbering matches what apply_changes already
 *  expects. The `│` separator is the same character used by the existing
 *  workspace.cat() output for visual continuity. */
export function formatWithHashlines(content: string): string {
  const lines = content.split("\n");
  return lines
    .map((line, i) => `${i + 1}:${computeLineHash(line)}│${line}`)
    .join("\n");
}

export interface ParsedHashlineRef {
  readonly line: number;
  readonly expectedHash: string;
}

/** Parse a hashline ref string like "47:a3" into {line, expectedHash}.
 *  Returns null if the input doesn't match the pattern — the handler
 *  should fall back to treating it as a legacy numeric ref or reject. */
export function parseHashlineRef(ref: unknown): ParsedHashlineRef | null {
  if (typeof ref !== "string") return null;
  const m = ref.match(/^(\d+):([0-9a-fA-F]{2})$/);
  if (!m) return null;
  return {
    line: parseInt(m[1]!, 10),
    expectedHash: m[2]!.toLowerCase(),
  };
}

export interface HashlineValidationIssue {
  readonly changeIndex: number;
  readonly field: "startLine" | "endLine";
  readonly line: number;
  readonly expectedHash: string;
  readonly actualHash: string;
  /** The actual current content of the line — helps the LLM re-orient. */
  readonly actualContent: string;
}

/** Validate that the expected hashes on a list of changes match the current
 *  file. Returns issues[] for any mismatches; empty = all good. */
export function validateHashlineRefs(
  sourceBefore: string,
  changes: ReadonlyArray<{
    startLine: number;
    endLine: number;
    expectedStartHash?: string;
    expectedEndHash?: string;
  }>,
): HashlineValidationIssue[] {
  const sourceLines = sourceBefore.split("\n");
  const issues: HashlineValidationIssue[] = [];

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!;
    // startLine validation
    if (c.expectedStartHash !== undefined) {
      const sourceLine = sourceLines[c.startLine - 1];
      if (sourceLine === undefined) {
        issues.push({
          changeIndex: i,
          field: "startLine",
          line: c.startLine,
          expectedHash: c.expectedStartHash,
          actualHash: "??",
          actualContent: `<line ${c.startLine} out of bounds; file has ${sourceLines.length} lines>`,
        });
      } else {
        const actual = computeLineHash(sourceLine);
        if (actual !== c.expectedStartHash.toLowerCase()) {
          issues.push({
            changeIndex: i,
            field: "startLine",
            line: c.startLine,
            expectedHash: c.expectedStartHash.toLowerCase(),
            actualHash: actual,
            actualContent: sourceLine,
          });
        }
      }
    }
    // endLine validation
    if (c.expectedEndHash !== undefined) {
      const sourceLine = sourceLines[c.endLine - 1];
      if (sourceLine === undefined) {
        issues.push({
          changeIndex: i,
          field: "endLine",
          line: c.endLine,
          expectedHash: c.expectedEndHash,
          actualHash: "??",
          actualContent: `<line ${c.endLine} out of bounds; file has ${sourceLines.length} lines>`,
        });
        continue;
      }
      const actual = computeLineHash(sourceLine);
      if (actual !== c.expectedEndHash.toLowerCase()) {
        issues.push({
          changeIndex: i,
          field: "endLine",
          line: c.endLine,
          expectedHash: c.expectedEndHash.toLowerCase(),
          actualHash: actual,
          actualContent: sourceLine,
        });
      }
    }
  }

  return issues;
}

/** Format a validation result as an actionable PATCH_INVALID message. */
export function formatHashlineStaleMessage(
  issues: ReadonlyArray<HashlineValidationIssue>,
): string {
  const lines: string[] = [];
  lines.push(
    "HASHLINE_STALE: line hash(es) don't match current file — your view is stale. Re-read the `## Current File` block and re-emit with current hashes.",
  );
  lines.push("");
  for (const issue of issues) {
    lines.push(
      `  • change[${issue.changeIndex}].${issue.field} = ${issue.line}:${issue.expectedHash} — expected hash ${issue.expectedHash}, actual hash ${issue.actualHash}`,
    );
    lines.push(`      line ${issue.line} currently: ${issue.actualContent}`);
  }
  lines.push("");
  lines.push(
    "Workspace unchanged. Submit a new apply_changes with line refs like `${N}:${hash}` matching the current file.",
  );
  return lines.join("\n");
}
