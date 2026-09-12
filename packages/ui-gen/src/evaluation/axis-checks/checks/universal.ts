// packages/ui-gen/src/evaluation/axis-checks/checks/universal.ts
//
// Checks that run regardless of axis value — they apply to any generated
// component. Dispatched via a "universal" gate that matches every render
// value.

import { LUCIDE_ICON_NAMES } from "@ggui-ai/design";
import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import {
  getRequiredPropNames,
  mkIssue,
} from "../helpers.js";

const ALL_RENDER_VALUES = [
  "static", "list", "grid", "spatial", "timeline", "chart", "master-detail",
] as const;

function runPropCoverage(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const requiredProps = getRequiredPropNames(input.contract);
  const issues: EvalIssue[] = [];
  for (const name of requiredProps) {
    const dotAccess = new RegExp(`\\bprops\\.${name}\\b`);
    const bracketAccess = new RegExp(`\\bprops\\[['"\`]${name}['"\`]\\]`);
    const destructured = new RegExp(
      `props[^;]{0,200}\\{[^}]*\\b${name}\\b[^}]*\\}|\\{[^}]*\\b${name}\\b[^}]*\\}[^;]{0,10}=\\s*props`,
    );
    if (dotAccess.test(src) || bracketAccess.test(src) || destructured.test(src))
      continue;
    issues.push(
      mkIssue(
        "universal.prop_coverage",
        `Required prop "${name}" is not referenced anywhere in the component.`,
        `Render props.${name} — the data contract marks it required.`,
      ),
    );
  }
  return issues;
}

function runNoPropMirror(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const issues: EvalIssue[] = [];
  const re =
    /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState(?:<[^>]*>)?\s*\(\s*props\??\.(\w+)/g;
  for (const m of src.matchAll(re)) {
    const [full, stateVar, setter, propName] = m;
    const idx = m.index ?? 0;
    const after = src.slice(idx + full.length);
    if (new RegExp(`\\b${setter}\\s*\\(`).test(after)) continue;
    issues.push(
      mkIssue(
        "universal.no_prop_mirror",
        `useState(props.${propName}) for "${stateVar}" has no "${setter}" call — this mirrors a prop without mutation.`,
        `Read props.${propName} directly in the render; remove the useState for ${stateVar}.`,
        "warn",
      ),
    );
  }
  return issues;
}

function runNoPhantomUseState(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const issues: EvalIssue[] = [];
  const re = /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState/g;
  for (const m of src.matchAll(re)) {
    const [full, stateVar, setter] = m;
    const idx = m.index ?? 0;
    const after = src.slice(idx + full.length);
    const stateUsed = new RegExp(`\\b${stateVar}\\b`).test(after);
    const setterUsed = new RegExp(`\\b${setter}\\b`).test(after);
    if (stateUsed || setterUsed) continue;
    issues.push(
      mkIssue(
        "universal.no_phantom_useState",
        `useState for "${stateVar}" is declared but neither "${stateVar}" nor "${setter}" is referenced.`,
        `Remove the useState for ${stateVar} — it is dead state.`,
        "warn",
      ),
    );
  }
  return issues;
}

function runPropSeedNoResync(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const issues: EvalIssue[] = [];
  const re =
    /const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState(?:<[^>]*>)?\s*\(\s*props\??\.(\w+)/g;
  for (const m of src.matchAll(re)) {
    const [full, stateVar, setter, propName] = m;
    const idx = m.index ?? 0;
    const after = src.slice(idx + full.length);
    // Never-called setter is `no_prop_mirror`'s case — this check is
    // its #480 complement: the setter IS used (real optimistic state)
    // but nothing re-seeds when the agent repaints the prop.
    if (!new RegExp(`\\b${setter}\\s*\\(`).test(after)) continue;
    // A re-seed effect names the prop in a dependency array. Bracket
    // shape is the pragmatic signal (same looseness as the sibling
    // checks): any `[... props.X ...]` array in the source counts.
    const resync = new RegExp(
      `\\[[^\\[\\]]*props\\??\\.${propName}\\b[^\\[\\]]*\\]`,
    );
    if (resync.test(src)) continue;
    issues.push(
      mkIssue(
        "universal.prop_seed_no_resync",
        `useState(props.${propName}) seeds "${stateVar}" and mutates it, but no effect depends on [props.${propName}] — a ggui_amend repaint pushes new props that never reach this display (#480).`,
        `Add \`useEffect(() => ${setter}(props.${propName}), [props.${propName}]);\` so agent repaints re-seed the state, or derive the display directly from props.${propName}.`,
        "warn",
      ),
    );
  }
  return issues;
}

// ── universal.icon_name_known (ggui#1015) ────────────────────────────
// The Icon primitive renders ONLY its curated Lucide subset; an unknown
// name renders an empty box. The model reaches for names from the full
// Lucide set ("sparkles", "arrow-up-right" on the hello frames), so the
// check flags every string-literal `<Icon name>` outside the subset —
// the fix turn has `get_available_icons`. Dynamic names (`name={x}`)
// and emoji/unicode (rendered as text) are outside the check's scope.

/** Icon.tsx's resolver rule: exact key, else dashes/underscores stripped + lowercased. */
const KNOWN_ICON_KEYS: ReadonlySet<string> = new Set(
  LUCIDE_ICON_NAMES.map((n) => n.replace(/[-_]/g, "").toLowerCase()),
);

export function isKnownIconName(name: string): boolean {
  return KNOWN_ICON_KEYS.has(name.replace(/[-_]/g, "").toLowerCase());
}

const ICON_NAME_LITERAL_RX =
  /<Icon\b[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/g;

export function findUnknownIconNames(sourceCode: string): string[] {
  const unknown = new Set<string>();
  for (const m of sourceCode.matchAll(ICON_NAME_LITERAL_RX)) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    if (name.length === 0) continue;
    if (/[^\x20-\x7e]/.test(name)) continue; // emoji / unicode passthrough renders as text
    if (!isKnownIconName(name)) unknown.add(name);
  }
  return [...unknown];
}

function runIconNameKnown(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const unknown = findUnknownIconNames(input.sourceCode);
  if (unknown.length === 0) return [];
  const list = unknown.map((n) => `"${n}"`).join(", ");
  return [
    mkIssue(
      "universal.icon_name_known",
      `<Icon name=…> uses ${unknown.length} name(s) outside the design system's Lucide subset: ${list} — an unknown name renders an empty box.`,
      "Call get_available_icons and pick a listed name (kebab-case), or use an emoji directly.",
    ),
  ];
}

// ── universal.accent_text_ink (ggui#1039) ────────────────────────────
// The brand ladder's mid stops (300–600) are FILL colours. On a
// low-saturation brand the 600 stop is mid-grey on the surface, and every
// one of four brand-directed hello frames painted its eyebrow and inline
// arrows with it — two of them at 3.5:1 and 2.91:1 on the ground. Accent
// TEXT is the theme's readable ink `--ggui-color-link` (derived per mode to
// clear 4.5:1, ggui#1035) or `<Text tone="emphasized">`; `link` resolves to
// the very same 600 wherever 600 already reads, so the fix never regresses a
// saturated brand. Out of scope by design: tints as text (50–200 — the
// on-fill idiom, `primary-50` on a `primary-600` bubble) and the deep stops
// (700–900 — text on a light primary tint), both documented uses. Matches the
// `color` property in every spelling the model writes — JSX prop, style
// object (source and compiled), CSS declaration — and never a compound
// property (`backgroundColor`, `border-color`, `accent-color`).

const LADDER_STOP_AS_TEXT_RX =
  /(?<![\w-])color\s*(?:=\s*\{?\s*|:\s*)["'`]?\s*var\(--ggui-color-primary-(\d{2,3})\s*[,)]/g;
const TEXT_INK_STOP_MIN = 300;
const TEXT_INK_STOP_MAX = 600;

/** Distinct `primary-<stop>` tokens (300–600) the source paints as a text `color`, in source order. */
export function findLadderStopsAsText(sourceCode: string): string[] {
  const found = new Set<string>();
  for (const m of sourceCode.matchAll(LADDER_STOP_AS_TEXT_RX)) {
    const digits = m[1] ?? "";
    const stop = Number(digits);
    if (stop >= TEXT_INK_STOP_MIN && stop <= TEXT_INK_STOP_MAX) found.add(`primary-${digits}`);
  }
  return [...found];
}

function runAccentTextInk(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const stops = findLadderStopsAsText(input.sourceCode);
  if (stops.length === 0) return [];
  const list = stops.map((s) => `\`${s}\``).join(", ");
  return [
    mkIssue(
      "universal.accent_text_ink",
      `Text is painted with a brand-ladder fill stop as its color (${list}) — on a low-saturation brand these stops are mid-grey on the surface and the text fails readability.`,
      'Accent text (eyebrows, taglines, links, labels, inline arrows) takes var(--ggui-color-link) or <Text tone="emphasized">; body text takes var(--ggui-color-onContainer); keep primary-* stops on fills and borders.',
    ),
  ];
}

export const UNIVERSAL_CHECKS: readonly AxisCheck[] = [
  {
    id: "universal.icon_name_known",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runIconNameKnown,
  },
  {
    id: "universal.accent_text_ink",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runAccentTextInk,
  },
  {
    id: "universal.prop_coverage",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runPropCoverage,
  },
  {
    id: "universal.no_prop_mirror",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runNoPropMirror,
  },
  {
    id: "universal.no_phantom_useState",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runNoPhantomUseState,
  },
  {
    id: "universal.prop_seed_no_resync",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runPropSeedNoResync,
  },
];
