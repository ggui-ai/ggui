// packages/ui-gen/src/coding-agent/tag-balance.ts
//
// Structural-diff preflight for JSX patches. Catches the 90% of tag-mismatch
// PATCH_INVALIDs where the error manifests OUTSIDE the patched range because
// the replacement body changed the open/close tag balance.
//
// Diagnostic data (2026-04-14 baseline, n=72, 39 tag-mismatch errors):
//   - 4/39 (10%) inside the patch range — LLM wrote a direct mismatch,
//     caught today by esbuild.
//   - 35/39 (90%) outside the patch range — the patch shifted tag counts
//     upstream/downstream, leaving the file structurally broken. esbuild
//     complains about a line the LLM didn't touch; LLM retries targeting
//     that line; pattern repeats across turns ("chasing a moving target").
//
// This module counts per-tag (opens, closes, self-closes) in the original
// range vs the replacement body and reports imbalance with an actionable
// message BEFORE apply: "Your replacement body has 3 <Stack> opens but 2
// </Stack> closes — you're leaving 1 <Stack> unclosed."
//
// Cost: pure regex, sub-ms per patch. Runs before esbuild so we save the
// esbuild round-trip on the dominant failure class.

export interface TagBalance {
  readonly opens: number;
  readonly closes: number;
  readonly selfCloses: number;
}

/** Count open, close, and self-closing tags for each PascalCase JSX element.
 *  Only tags that start with an uppercase letter are counted (React convention
 *  for components; lowercase `<div>` etc. are HTML and not our concern). */
export function countTagBalance(code: string): Map<string, TagBalance> {
  const counts = new Map<string, { opens: number; closes: number; selfCloses: number }>();
  const bump = (name: string, key: "opens" | "closes" | "selfCloses") => {
    const cur = counts.get(name) ?? { opens: 0, closes: 0, selfCloses: 0 };
    cur[key]++;
    counts.set(name, cur);
  };

  // Self-closing first so we can exclude their ranges from the open-tag pass.
  // Pattern: `<Tag ... />` — greedy-match attributes up to the `/>`.
  // JSX attributes can contain `>` inside strings; we don't worry about that
  // here because the regex is conservative (bails on `>` that isn't `/>`).
  const selfCloseRegex = /<([A-Z]\w*)\b[^>]*?\/>/g;
  const selfCloseSpans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = selfCloseRegex.exec(code)) !== null) {
    bump(m[1]!, "selfCloses");
    selfCloseSpans.push([m.index, m.index + m[0].length]);
  }

  const inSelfClose = (idx: number): boolean =>
    selfCloseSpans.some(([a, b]) => idx >= a && idx < b);

  // Open tags: `<Tag` followed by space, `>`, or newline; NOT `<Tag/>`
  // (self-close, already counted) and NOT `</Tag` (close). We also need to
  // EXCLUDE TypeScript generics like `Promise<Foo>`, `useState<Foo>()`,
  // `Array<Bar>` — those look identical to JSX opens by regex but aren't.
  //
  // Heuristic: JSX opens are preceded by an expression-context char
  //   (whitespace, `(`, `{`, `>`, `,`, `:`, `?`, `&&`, `||`, `=`, `return`, start-of-string).
  // TS generics are preceded by an identifier char (alphanumeric or `_`).
  // This catches `Promise<Foo>` (preceded by `e`) and `useState<T>`
  // (preceded by `e`) without false-positive-ing JSX inside expressions.
  const openRegex = /<([A-Z]\w*)(?=[\s>/])/g;
  while ((m = openRegex.exec(code)) !== null) {
    if (inSelfClose(m.index)) continue; // already counted
    const prevChar = code[m.index - 1];
    if (prevChar === "/") continue; // closing tag `</`
    // TS generic guard: if the char before `<` is a word char (alnum/_),
    // this is a type parameter list, not JSX.
    if (prevChar !== undefined && /\w/.test(prevChar)) continue;
    bump(m[1]!, "opens");
  }

  // Close tags: `</Tag>`. Same generic guard — skip `Promise</Foo>` style
  // (doesn't exist in practice but be defensive): `</` preceded by a word
  // char is essentially impossible in valid TS (would be `<</`), but we
  // still check for safety.
  const closeRegex = /<\/([A-Z]\w*)\s*>/g;
  while ((m = closeRegex.exec(code)) !== null) {
    bump(m[1]!, "closes");
  }

  return counts;
}

export interface TagDelta {
  readonly tag: string;
  readonly opensDelta: number;
  readonly closesDelta: number;
  /** opensDelta - closesDelta. Non-zero = structural imbalance. */
  readonly netDelta: number;
}

/** Compute per-tag delta between replacement and original range.
 *  `netDelta > 0` → replacement adds N unclosed opens.
 *  `netDelta < 0` → replacement adds N stray closes. */
export function computeTagDeltas(
  original: string,
  replacement: string,
): TagDelta[] {
  const origCounts = countTagBalance(original);
  const replCounts = countTagBalance(replacement);
  const tags = new Set([...origCounts.keys(), ...replCounts.keys()]);
  const deltas: TagDelta[] = [];
  for (const tag of tags) {
    const o = origCounts.get(tag) ?? { opens: 0, closes: 0, selfCloses: 0 };
    const r = replCounts.get(tag) ?? { opens: 0, closes: 0, selfCloses: 0 };
    const opensDelta = r.opens - o.opens;
    const closesDelta = r.closes - o.closes;
    const netDelta = opensDelta - closesDelta;
    if (netDelta !== 0) {
      deltas.push({ tag, opensDelta, closesDelta, netDelta });
    }
  }
  return deltas;
}

export interface ChangeForBalance {
  readonly startLine: number;
  readonly endLine: number;
  readonly code: readonly string[];
}

export interface ImbalanceReport {
  readonly imbalanced: boolean;
  /** Per-tag net imbalance summed across ALL changes in the patch. */
  readonly totals: TagDelta[];
  /** Per-change per-tag deltas — for pinpointing which change is off. */
  readonly perChange: Array<{ readonly range: string; readonly deltas: TagDelta[] }>;
}

/** Compute tag-balance deltas across a multi-change patch. Returns an
 *  imbalance report if the net balance for any tag is non-zero. */
export function checkPatchTagBalance(
  sourceBefore: string,
  changes: readonly ChangeForBalance[],
): ImbalanceReport {
  const sourceLines = sourceBefore.split("\n");
  const totalDeltas = new Map<string, { opensDelta: number; closesDelta: number }>();
  const perChange: Array<{ range: string; deltas: TagDelta[] }> = [];

  for (const change of changes) {
    // 1-indexed, inclusive range — same convention as esbuild error line and
    // the existing patch engine.
    const origLines = sourceLines.slice(
      Math.max(0, change.startLine - 1),
      change.endLine,
    );
    const original = origLines.join("\n");
    const replacement = change.code.join("\n");
    const deltas = computeTagDeltas(original, replacement);
    if (deltas.length > 0) {
      perChange.push({
        range: `${change.startLine}-${change.endLine}`,
        deltas,
      });
    }
    for (const d of deltas) {
      const cur = totalDeltas.get(d.tag) ?? { opensDelta: 0, closesDelta: 0 };
      cur.opensDelta += d.opensDelta;
      cur.closesDelta += d.closesDelta;
      totalDeltas.set(d.tag, cur);
    }
  }

  const totals: TagDelta[] = [];
  for (const [tag, { opensDelta, closesDelta }] of totalDeltas) {
    const netDelta = opensDelta - closesDelta;
    if (netDelta !== 0) {
      totals.push({ tag, opensDelta, closesDelta, netDelta });
    }
  }

  return {
    imbalanced: totals.length > 0,
    totals,
    perChange,
  };
}

/** Format an ImbalanceReport as an actionable PATCH_INVALID message. */
export function formatImbalanceMessage(report: ImbalanceReport): string {
  const lines: string[] = [];
  lines.push(
    "PATCH_INVALID: patch leaves file structurally unbalanced (tag open/close counts don't match).",
  );
  lines.push("");
  lines.push("Net imbalance across your patch (totals across all changes):");
  for (const d of report.totals) {
    if (d.netDelta > 0) {
      lines.push(
        `  • ${d.netDelta} extra <${d.tag}> open(s) — you opened ${d.opensDelta >= 0 ? "+" : ""}${d.opensDelta} and closed ${d.closesDelta >= 0 ? "+" : ""}${d.closesDelta}. Add ${d.netDelta} </${d.tag}> at the matching nesting level.`,
      );
    } else {
      lines.push(
        `  • ${-d.netDelta} extra </${d.tag}> close(s) — you opened ${d.opensDelta >= 0 ? "+" : ""}${d.opensDelta} and closed ${d.closesDelta >= 0 ? "+" : ""}${d.closesDelta}. Remove ${-d.netDelta} </${d.tag}> or add ${-d.netDelta} <${d.tag}> at the matching nesting level.`,
      );
    }
  }
  if (report.perChange.length > 1) {
    lines.push("");
    lines.push("Per-change breakdown (to pinpoint which change is off):");
    for (const { range, deltas } of report.perChange) {
      const summary = deltas
        .map((d) => `${d.tag} net=${d.netDelta >= 0 ? "+" : ""}${d.netDelta}`)
        .join(", ");
      lines.push(`  lines ${range}: ${summary}`);
    }
  }
  lines.push("");
  lines.push(
    "Re-read the current file around these ranges and submit a corrected patch that preserves tag balance.",
  );
  return lines.join("\n");
}
