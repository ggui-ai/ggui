/**
 * The coding loop's tool set — the ONE list `createHarness` builds its
 * coding and scoped tools from, and the identity a build stamp names it
 * by.
 *
 * `harnessToolNames(mode)` returns one entry per tool definition,
 * `<name>@<digest>`: the tool's own (unprefixed) name and the first 8 hex
 * of sha256 over `JSON.stringify` of its definition — so a change to a
 * tool's schema OR its description (prompt text, as output-changing as a
 * template) moves the entry, and two definitions that share a name (a
 * scoped variant keeps the name and narrows the grammar) are two entries.
 * Coding and scoped alike, since the scoped set runs on the
 * duplicate-fingerprint escape; sorted, de-duplicated, a fresh array. It
 * reads the same constants the harness is assembled from, so the list can
 * never drift from what runs; the pin beside it holds the two equal for
 * every design mode. The design mode is part of the signature because the
 * tool set is keyed by the harness a mode builds, even while both modes
 * declare the same tools.
 */
import { createHash } from 'node:crypto';
import type { LLMToolDef } from './llm.js';
import type { DesignMode } from './design-mode.js';
import { APPLY_CHANGES_TOOL, APPLY_CHANGES_TOOL_SCOPED } from './tools.js';

/** The coding tools every harness declares (`what.codingTools`). */
export const HARNESS_CODING_TOOLS: readonly LLMToolDef[] = [APPLY_CHANGES_TOOL];
/** The scoped fallback the runtime promotes into `codingTools` on a duplicate-fingerprint escape. */
export const HARNESS_SCOPED_TOOLS: readonly LLMToolDef[] = [APPLY_CHANGES_TOOL_SCOPED];

/** One tool's entry: `<name>@<first 8 hex of sha256(JSON.stringify(def))>`. */
export function harnessToolEntry(def: LLMToolDef): string {
  return `${def.name}@${createHash('sha256').update(JSON.stringify(def), 'utf8').digest('hex').slice(0, 8)}`;
}

export function harnessToolNames(designMode: DesignMode): string[] {
  void designMode; // one tool set for every mode today; the mode keys the harness, so it stays on the signature
  return [...new Set([...HARNESS_CODING_TOOLS, ...HARNESS_SCOPED_TOOLS].map(harnessToolEntry))].sort();
}
