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
  /** The JSX between the open and close tag; empty when self-closing. */
  readonly inner: string;
  /** For a self-closing element, its following siblings up to the next close tag (a swatch's label); else empty. */
  readonly next: string;
}

interface OpenTag {
  readonly attrs: string;
  readonly end: number;
  readonly selfClosing: boolean;
}

/**
 * Read a JSX open tag whose `<Name` starts at `from`. Braces and string
 * literals are skipped as units, so an `onClick={() => …}` arrow does not end
 * the tag the way a `[^<>]` pattern would.
 */
function scanOpenTag(src: string, from: number, nameLength: number): OpenTag | null {
  let depth = 0;
  let quote = "";
  for (let i = from + 1 + nameLength; i < src.length; i++) {
    const ch = src[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    } else if (ch === ">" && depth === 0) {
      const attrs = src.slice(from + 1 + nameLength, i);
      return { attrs, end: i + 1, selfClosing: attrs.trimEnd().endsWith("/") };
    }
  }
  return null;
}

/** The value of a top-level `tint=` attribute, braces or quotes included; null when absent. */
function readTintAttr(attrs: string): string | null {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < attrs.length; i++) {
    const ch = attrs[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && /\s/.test(attrs[i - 1] ?? " ")) {
      const m = /^tint\s*=\s*/.exec(attrs.slice(i));
      if (m === null) continue;
      const v = i + m[0].length;
      const open = attrs[v];
      if (open === '"' || open === "'") {
        const close = attrs.indexOf(open, v + 1);
        return close < 0 ? null : attrs.slice(v, close + 1);
      }
      if (open !== "{") return null;
      let d = 0;
      for (let j = v; j < attrs.length; j++) {
        if (attrs[j] === "{") d++;
        else if (attrs[j] === "}" && --d === 0) return attrs.slice(v, j + 1);
      }
      return null;
    }
  }
  return null;
}

/** Every tinted `Box` / `Card` in the source, with its inner JSX (empty when self-closing). */
export function findTintedElements(sourceCode: string): TintedElement[] {
  const found: TintedElement[] = [];
  for (const m of sourceCode.matchAll(/<(Box|Card)\b/g)) {
    const tag = m[1] === "Card" ? "Card" : "Box";
    const from = m.index ?? 0;
    const open = scanOpenTag(sourceCode, from, tag.length);
    if (open === null) continue;
    const tint = readTintAttr(open.attrs);
    if (tint === null) continue;
    if (open.selfClosing) {
      const close = sourceCode.indexOf("</", open.end);
      found.push({ tag, tint, inner: "", next: sourceCode.slice(open.end, close < 0 ? sourceCode.length : close) });
      continue;
    }
    // Walk to the matching close tag, counting nested opens of the same name.
    const tagRx = new RegExp(`<(/?)${tag}\\b`, "g");
    tagRx.lastIndex = open.end;
    let depth = 1;
    let end = sourceCode.length;
    for (let t = tagRx.exec(sourceCode); t !== null; t = tagRx.exec(sourceCode)) {
      if (t[1] === "/") {
        if (--depth === 0) {
          end = t.index;
          break;
        }
        continue;
      }
      const nested = scanOpenTag(sourceCode, t.index, tag.length);
      if (nested === null) break;
      tagRx.lastIndex = nested.end;
      if (!nested.selfClosing) depth++;
    }
    found.push({ tag, tint, inner: sourceCode.slice(open.end, end), next: "" });
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
  if (tinted.every((e) => hasWords(e.inner) || hasWords(e.next))) return [];
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
