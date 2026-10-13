// packages/ui-gen/src/evaluation/axis-checks/checks/tint.ts
//
// ggui#1846 — the categorical `tint` fill's usage rules, as WARNINGS. The kit
// gives `Box` / `Card` eight theme-tracked steps (`tint-1` … `tint-8`) for DATA
// categories. The rules (ggui-team-cdo's, taught in the system prompt) are a
// property of the rendered card, and from source each can only be read by a
// heuristic over names or JSX structure. A heuristic that FAILS loops a
// generation that is correct but trips it, so these warn: the model sees the
// repair line as feedback, nothing blocks, and the follow and false-fire rates
// are measured. An out-of-range step fails through the prop's own type instead.
//
// Not checked here: "the same category bound to two steps in one card". Reading
// that needs data flow, not the tag's text.

import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import { mkIssue } from "../helpers.js";

const ALL_RENDER_VALUES = [
  "static", "list", "grid", "spatial", "timeline", "chart", "master-detail",
] as const;

/** One tinted `Box` / `Card`: the tag, the `tint` value's source text, and the JSX between its open and close tags. */
export interface TintedElement {
  readonly tag: "Box" | "Card";
  readonly tint: string;
  readonly inner: string;
}

const OPEN_TINTED_RX = /<(Box|Card)\b([^<>]*?)\btint\s*=\s*(\{[^{}]*\}|"[^"]*"|'[^']*')([^<>]*?)(\/?)>/g;

/** Every tinted `Box` / `Card` in the source, with its inner JSX (empty when self-closing). */
export function findTintedElements(sourceCode: string): TintedElement[] {
  const found: TintedElement[] = [];
  for (const m of sourceCode.matchAll(OPEN_TINTED_RX)) {
    const tag = m[1] === "Card" ? "Card" : "Box";
    const tint = m[3] ?? "";
    if (m[5] === "/") {
      found.push({ tag, tint, inner: "" });
      continue;
    }
    // Walk to the matching close tag, counting nested opens of the same name.
    const start = (m.index ?? 0) + m[0].length;
    const tagRx = new RegExp(`<(/?)${tag}\\b[^<>]*?(/?)>`, "g");
    tagRx.lastIndex = start;
    let depth = 1;
    let end = sourceCode.length;
    for (let t = tagRx.exec(sourceCode); t !== null; t = tagRx.exec(sourceCode)) {
      if (t[2] === "/") continue; // self-closing nested tag
      depth += t[1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    found.push({ tag, tint, inner: sourceCode.slice(start, end) });
  }
  return found;
}

const STATE_WORD_RX = /\b(status|state|isLive|live|draft|signal|error|success|warning|danger|isActive|active|selected|isSelected|online|offline|pending|loading|disabled)\b/i;

/** Text a reader sees inside the cell: a text primitive, a JSX expression child, or literal JSX text. */
function hasWords(inner: string): boolean {
  if (/<(Text|Heading|Label|Badge|Caption|Link)\b/.test(inner)) return true;
  if (/\{[^{}]+\}/.test(inner.replace(/\b[a-zA-Z]+=\{[^{}]*\}/g, ""))) return true;
  return />\s*[^<>{}\s][^<>{}]*</.test(`>${inner}<`);
}

function runTintStateBound(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const bound = findTintedElements(input.sourceCode).filter((e) => e.tint.startsWith("{") && STATE_WORD_RX.test(e.tint));
  if (bound.length === 0) return [];
  return [
    mkIssue(
      "universal.tint_state_bound",
      `\`tint\` reads as bound to a state (${bound.map((e) => `\`${e.tint}\``).join(", ")}) — tints are for data categories, never for state.`,
      "A status takes live, draft or signal, not a tint. Keep `tint` for a data category (series, lane, kind, group), and show state with its own props.",
      "warn",
    ),
  ];
}

function runTintCategoryInWords(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const tinted = findTintedElements(input.sourceCode);
  if (tinted.length === 0) return [];
  if (/\blegend\b/i.test(input.sourceCode)) return [];
  if (tinted.every((e) => hasWords(e.inner))) return [];
  return [
    mkIssue(
      "universal.tint_category_in_words",
      "A tinted cell carries no words, and the card has no legend — colour is the only way to tell its category.",
      "Give this cell a label, or add a legend to the card. The category is always also in words.",
      "warn",
    ),
  ];
}

const MUTED_TONE_RX = /\btone\s*=\s*["'](subtle|muted)["']/;

function runTintMutedText(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  if (!findTintedElements(input.sourceCode).some((e) => MUTED_TONE_RX.test(e.inner))) return [];
  return [
    mkIssue(
      "universal.tint_muted_text",
      'Muted text (`tone="subtle"` / `tone="muted"`) sits on a tint — it can read under 4.5:1 there.',
      "Text on a tint is the theme's ink only, one short line (a label, a symbol, a value). Put secondary or muted text beside the cell or in the legend.",
      "warn",
    ),
  ];
}

export const TINT_CHECKS: readonly AxisCheck[] = [
  { id: "universal.tint_state_bound", axis: "render", values: ALL_RENDER_VALUES, run: runTintStateBound },
  { id: "universal.tint_category_in_words", axis: "render", values: ALL_RENDER_VALUES, run: runTintCategoryInWords },
  { id: "universal.tint_muted_text", axis: "render", values: ALL_RENDER_VALUES, run: runTintMutedText },
];
