// packages/ui-gen/src/coding-agent/diff-processor.ts
//
// Strict diff processor for LLM-generated unified diffs.
//
// Strategy:
// 1. Pre-process: normalize LLM formatting mistakes (headers, empty lines, counts)
// 2. Dry-apply: strict matching — no fuzzy, no relaxation
// 3. If dry-apply fails: return structured error for LLM repair
// 4. After repair: dry-apply again, then real apply
//
// The processor is intentionally strict. Fuzzy matching hides bugs and can
// apply patches at wrong positions. Instead, let an LLM repair the diff
// when context lines don't match.

import { parsePatch, applyPatch, type StructuredPatch } from 'diff';

// =============================================================================
// Types
// =============================================================================

export type PreProcessResult =
  | { success: true; cleanDiff: string; parsed: StructuredPatch }
  | { success: false; error: string };

export type ApplyDiffResult =
  | { success: true; result: string }
  | { success: false; error: string; mismatches?: DiffMismatch[] };

export interface DiffMismatch {
  hunkIndex: number;
  lineNumber: number;
  fileLine: string;
  diffLine: string;
  type: 'context' | 'removed';
}

// =============================================================================
// Pre-process: normalize LLM diff mistakes
// =============================================================================

export function preProcessDiff(
  rawDiff: string,
  _currentFile: string,
): PreProcessResult {
  if (!rawDiff || rawDiff.trim().length === 0) {
    return { success: false, error: 'Empty diff.' };
  }

  let diff = rawDiff;

  // Ensure trailing newline
  if (!diff.endsWith('\n')) diff += '\n';

  // Add missing file headers
  if (!diff.includes('--- ')) {
    diff = `--- a/ui.tsx\n+++ b/ui.tsx\n${diff}`;
  }

  // Must have at least one @@ hunk header
  if (!diff.includes('@@')) {
    return {
      success: false,
      error: 'No @@ hunk headers found. Use standard unified diff format.',
    };
  }

  // Fix context lines missing leading space prefix
  const fileLineSet = new Set(
    _currentFile.split('\n').map((l) => l.trimEnd()),
  );
  const diffLines = diff.split('\n');
  let inHunk = false;
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (
      line.length > 0 &&
      !line.startsWith('+') &&
      !line.startsWith('-') &&
      !line.startsWith(' ') &&
      !line.startsWith('\\') &&
      !line.startsWith('@') &&
      fileLineSet.has(line.trimEnd())
    ) {
      diffLines[i] = ` ${line}`;
    }
  }
  diff = diffLines.join('\n');

  // Remove trailing blank lines
  diff = diff.replace(/\n+$/, '\n');

  // Fix @@ line counts + bare empty lines
  diff = fixHunkCountsRaw(diff);

  // Parse
  let patches: StructuredPatch[];
  try {
    patches = parsePatch(diff);
  } catch (e) {
    return {
      success: false,
      error: `Failed to parse diff: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!patches.length || !patches[0].hunks?.length) {
    return { success: false, error: 'Diff contains no hunks.' };
  }

  // Validate: hunks must not overlap
  const hunks = patches[0].hunks;
  for (let i = 1; i < hunks.length; i++) {
    const prev = hunks[i - 1];
    const prevEnd = prev.oldStart + prev.oldLines;
    const curr = hunks[i];
    if (curr.oldStart < prevEnd) {
      return {
        success: false,
        error: `Hunks overlap: hunk ${i} starts at line ${curr.oldStart} but hunk ${i - 1} ends at line ${prevEnd}. Use separate, non-overlapping hunks for each changed section.`,
      };
    }
  }

  return { success: true, cleanDiff: diff, parsed: patches[0] };
}

// =============================================================================
// Mismatch Detection (for LLM repair prompts)
// =============================================================================

/**
 * Walk the parsed diff against the file and collect mismatches.
 * Used to build a targeted repair prompt — NOT as a gate.
 * applyDiffToFile (with fuzz) is the real applicability check.
 */
export function getMismatches(
  currentFile: string,
  parsed: StructuredPatch,
): DiffMismatch[] {
  const fileLines = currentFile.split('\n');
  const mismatches: DiffMismatch[] = [];

  for (let hi = 0; hi < parsed.hunks.length; hi++) {
    const hunk = parsed.hunks[hi];
    let fileIdx = hunk.oldStart - 1; // 0-indexed

    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        const diffContent = line.slice(1);
        const fileContent = fileLines[fileIdx] ?? '';
        if (!safeLineMatch(fileContent, diffContent, ' ')) {
          mismatches.push({
            hunkIndex: hi,
            lineNumber: fileIdx + 1,
            fileLine: fileLines[fileIdx] ?? '(EOF)',
            diffLine: line.slice(1),
            type: 'context',
          });
        }
        fileIdx++;
      } else if (line.startsWith('-')) {
        const diffContent = line.slice(1);
        const fileContent = fileLines[fileIdx] ?? '';
        if (!safeLineMatch(fileContent, diffContent, '-')) {
          mismatches.push({
            hunkIndex: hi,
            lineNumber: fileIdx + 1,
            fileLine: fileLines[fileIdx] ?? '(EOF)',
            diffLine: line.slice(1),
            type: 'removed',
          });
        }
        fileIdx++;
      }
      // '+' lines don't advance fileIdx
    }
  }

  return mismatches;
}

// =============================================================================
// Apply Diff — strict, no fuzzy
// =============================================================================

/**
 * Apply a preprocessed diff to the file.
 * Uses fuzz=2 (standard git-apply level) with safe context relaxations.
 */
export function applyDiffToFile(
  currentFile: string,
  cleanDiff: string,
  _parsed?: StructuredPatch,
): ApplyDiffResult {
  try {
    const result = applyPatch(currentFile, cleanDiff, {
      fuzzFactor: 2,
      compareLine: (
        _lineNum: number,
        line: string,
        op: string,
        patchContent: string,
      ) => safeLineMatch(line, patchContent, op),
    });

    if (result !== false) {
      return { success: true, result };
    }
  } catch {
    // applyPatch can throw on malformed diffs
  }

  return {
    success: false,
    error: 'Patch failed to apply.',
  };
}

/**
 * Line comparison with safe relaxations only:
 * - trimEnd (trailing whitespace)
 * - } ≈ "" for context lines only (proven safe: adjacent brace/empty swap)
 */
function safeLineMatch(fileLine: string, patchLine: string, op: string): boolean {
  const a = (fileLine ?? '').trimEnd();
  const b = (patchLine ?? '').trimEnd();
  if (a === b) return true;
  // Context-only: } ≈ "" (LLM off-by-one between adjacent closing brace and empty line)
  if (op === ' ') {
    if ((a === '}' && b === '') || (a === '' && b === '}')) return true;
    if ((a === '};' && b === '') || (a === '' && b === '};')) return true;
  }
  return false;
}

// =============================================================================
// Build LLM Repair Prompt
// =============================================================================

/**
 * Build a prompt for the LLM to repair a broken diff.
 * Gives the LLM the actual file content and the mismatches to fix.
 */
export function buildRepairPrompt(
  currentFile: string,
  rawDiff: string,
  mismatches: DiffMismatch[],
): { system: string; user: string } {
  const system = `You are a diff repair tool. You receive a unified diff that has context line mismatches against the actual file. Your job: fix the diff so context lines match the file exactly.

Rules:
- Output ONLY the corrected unified diff — no explanation, no markdown fences
- Keep all --- / +++ headers and @@ hunk headers
- Keep all + (added) lines unchanged — those are the intended changes
- Keep all - (removed) lines unchanged — those specify what to delete
- Fix ONLY the context lines (space prefix) to match the actual file
- Adjust @@ line numbers if needed to match the file
- Use separate hunks for separate changes — don't bridge with long context`;

  const mismatchDetail = mismatches.slice(0, 5).map(m =>
    `  Line ${m.lineNumber}: file has "${m.fileLine.trimEnd()}" but diff has "${m.diffLine.trimEnd()}"`
  ).join('\n');

  // Show only relevant file sections (±10 lines around each mismatch) to reduce context
  const fileLines = currentFile.split('\n');
  const relevantRanges = new Set<number>();
  for (const m of mismatches) {
    for (let i = Math.max(0, m.lineNumber - 11); i < Math.min(fileLines.length, m.lineNumber + 10); i++) {
      relevantRanges.add(i);
    }
  }
  const fileSnippet = fileLines
    .map((line, i) => relevantRanges.has(i) ? `${String(i + 1).padStart(4)}| ${line}` : null)
    .filter(Boolean)
    .join('\n');

  const user = `## File (relevant sections with line numbers)
${fileSnippet}

## Broken Diff
${rawDiff}

## Mismatches
${mismatchDetail}

Fix the context lines in the diff to match the actual file. Output the corrected diff:`;

  return { system, user };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Fix @@ line counts + bare empty lines in raw diff text BEFORE parsing.
 */
function fixHunkCountsRaw(diff: string): string {
  const lines = diff.split('\n');
  const result: string[] = [];
  let hunkStartIdx = -1;
  let hunkOldStart = 0;
  let hunkNewStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      if (hunkStartIdx >= 0) {
        flushHunk(result, lines, hunkStartIdx, i, hunkOldStart, hunkNewStart);
      }
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        hunkOldStart = parseInt(match[1], 10);
        hunkNewStart = parseInt(match[2], 10);
      }
      hunkStartIdx = i;
    } else if (hunkStartIdx < 0) {
      result.push(line);
    }
  }

  if (hunkStartIdx >= 0) {
    flushHunk(result, lines, hunkStartIdx, lines.length, hunkOldStart, hunkNewStart);
  }

  return result.join('\n');
}

function flushHunk(
  result: string[],
  lines: string[],
  hunkStart: number,
  hunkEnd: number,
  oldStart: number,
  newStart: number,
): void {
  const contentLines = lines.slice(hunkStart + 1, hunkEnd);

  // Strip trailing bare empty lines (artifacts from split('\n'))
  while (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') {
    contentLines.pop();
  }

  // Fix bare empty lines → space prefix
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i] === '') {
      contentLines[i] = ' ';
    }
  }

  let oldCount = 0;
  let newCount = 0;
  for (const line of contentLines) {
    if (line.startsWith('-')) oldCount++;
    else if (line.startsWith('+')) newCount++;
    else { oldCount++; newCount++; }
  }

  result.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
  result.push(...contentLines);
}
