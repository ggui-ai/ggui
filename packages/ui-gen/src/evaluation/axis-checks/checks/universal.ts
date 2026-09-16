// packages/ui-gen/src/evaluation/axis-checks/checks/universal.ts
//
// Checks that run regardless of axis value — they apply to any generated
// component. Dispatched via a "universal" gate that matches every render
// value.

import { LUCIDE_ICON_NAMES, maxWidth as CONTAINER_MAX_WIDTH } from "@ggui-ai/design";
import { CANVAS_VIEWPORTS, type CanvasClass } from "../../../design-mode.js";
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

// ── universal.scoped_surface_owns_ground (ggui#1047) ─────────────────
// A SCOPED surface — `surface="inverted"` or `"hero"` on Card / Box — owns its
// ground: the primitive paints it, the scope rule swaps every ink beneath it.
// The served Mosaic hello repainted an inverted card's ground with the page's
// (`style={{ background: 'var(--ggui-color-ground)' }}`) and its hero text
// read 1:1 — the swapped inks over a ground the scope did not own. The design
// package now strips that background at render; this check makes the fix turn
// remove it at the source, so the author's intent never silently vanishes.
// Stands down in `free` design mode (the primitive is optional there).

const SCOPED_SURFACE_TAG_RX = /<(Card|Box)\b([^<>]*?)surface\s*=\s*["'](inverted|hero)["']([^<>]*?)>/g;
const STYLE_BACKGROUND_RX = /\bstyle\s*=\s*\{\{[^}]*\b(background|backgroundColor|backgroundImage)\s*:/;

/** `[tag, surface]` for every scoped Card / Box whose own `style` sets a background. */
export function findScopedSurfaceBackgrounds(sourceCode: string): Array<readonly [string, string]> {
  const hits: Array<readonly [string, string]> = [];
  for (const m of sourceCode.matchAll(SCOPED_SURFACE_TAG_RX)) {
    const attrs = `${m[2] ?? ""} ${m[4] ?? ""}`;
    if (STYLE_BACKGROUND_RX.test(attrs)) hits.push([m[1] ?? "", m[3] ?? ""]);
  }
  return hits;
}

function runScopedSurfaceOwnsGround(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  if (input.designMode === "free") return [];
  const hits = findScopedSurfaceBackgrounds(input.sourceCode);
  if (hits.length === 0) return [];
  const [tag, surface] = hits[0]!;
  return [
    mkIssue(
      "universal.scoped_surface_owns_ground",
      `<${tag} surface="${surface}"> sets its own background in style — a scoped surface owns its ground; repainting it puts the scope's swapped inks over the wrong ground (ink on ink).`,
      `Remove the background from that ${tag}'s style — surface="${surface}" paints the ground; pick another surface if a different ground is wanted.`,
    ),
  ];
}

// ── universal.caps_label_invented (ggui#1075 Track A) ─────────────────
// A caps label (`<Text caps>` — the eyebrow / kicker / overline treatment)
// whose entire content is a string literal is copy the model INVENTED: the
// contract carries no such member, so nothing the agent sends can change
// it, and every served card wears it ("LET'S BEGIN", "WELCOME" — 59 of 63
// generated sources in one sample, none bound to a prop). Copy comes from the
// props; a caps label exists only when a prop supplies its text. A label
// whose content is an expression (`{props.section}`, `{label ?? …}`) is
// bound and passes; a `<Text caps>` with no text children is not a label.
const CAPS_TEXT_RX = /<Text\b(?=[^>]*\bcaps\b)[^>]*>([\s\S]*?)<\/Text>/g;

/** Every `<Text caps>` whose content is nothing but literal text: `[literal]`. */
export function findInventedCapsLabels(sourceCode: string): string[] {
  const out: string[] = [];
  for (const m of sourceCode.matchAll(CAPS_TEXT_RX)) {
    const inner = (m[1] ?? "").trim();
    if (inner.length === 0) continue;
    if (inner.includes("{")) continue; // bound to an expression — the props speak
    out.push(inner.replace(/\s+/g, " ").slice(0, 60));
  }
  return out;
}

function runCapsLabelInvented(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const invented = findInventedCapsLabels(input.sourceCode);
  if (invented.length === 0) return [];
  const list = invented.map((t) => `"${t}"`).join(", ");
  return [
    mkIssue(
      "universal.caps_label_invented",
      `${invented.length} caps label(s) carry invented copy the props do not supply: ${list} — an eyebrow, kicker or overline the agent cannot change is chatter on every render.`,
      "Remove the label, or bind its text to a prop (`<Text caps>{props.section}</Text>`); copy comes from the contract, never from the component.",
    ),
  ];
}

// ── universal.viewport_sized (ggui#1075 Track A/B, receipted on #1096) ─
// An element sized to the viewport — `100vh` / `100dvh` / `100svh` / `100lvh`
// (bare or inside `calc()`) as a `height` / `min-height`, or the `h-screen` /
// `min-h-screen` utility classes. The frame owns the height: a content-sized
// frame is measured FROM the content, so a viewport-sized root can never
// shrink and grows the frame on every re-measure; under fullscreen the frame
// already stretches the root to its height. 20 of 48 minted cells in one
// sample carried `minHeight: "100vh"` on their root — one an inline chat
// card told "compact". A `max-height` cap on a scroll region is not sizing
// and passes; so do `height: 100%`, `flex: 1` and pixel heights.
// The unit, with a `calc(…)` wrapper closed when present — so the quoted
// snippet reads whole (`height: "calc(100dvh - 64px)"`).
const VIEWPORT_UNIT = String.raw`(?:calc\(\s*)?100(?:vh|dvh|svh|lvh)\b(?:[^)"'\x60;\n]*\))?`;
const VIEWPORT_STYLE_OBJECT_RX = new RegExp(
  String.raw`\b(?:minHeight|height|minBlockSize|blockSize)\s*:\s*["'\x60]\s*${VIEWPORT_UNIT}["'\x60]?`,
  "g",
);
const VIEWPORT_CSS_RX = new RegExp(
  String.raw`(?<![\w-])(?:min-)?(?:height|block-size)\s*:\s*${VIEWPORT_UNIT}`,
  "g",
);
const VIEWPORT_CLASS_RX = /(?<![\w-])(?:min-)?h-(?:screen|dvh|svh|lvh)\b/g;

/** Every viewport-sized height in the source, as written (trimmed, ≤ 60 chars), in order. */
export function findViewportSizing(sourceCode: string): string[] {
  const hits: Array<{ at: number; text: string }> = [];
  for (const rx of [VIEWPORT_STYLE_OBJECT_RX, VIEWPORT_CSS_RX, VIEWPORT_CLASS_RX]) {
    for (const m of sourceCode.matchAll(rx)) {
      hits.push({ at: m.index ?? 0, text: m[0].replace(/\s+/g, " ").trim().slice(0, 60) });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.text);
}

function runViewportSized(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const sized = findViewportSizing(input.sourceCode);
  if (sized.length === 0) return [];
  const list = sized.map((t) => "`" + t + "`").join(", ");
  return [
    mkIssue(
      "universal.viewport_sized",
      `${sized.length} element(s) are sized to the viewport: ${list} — the frame owns the height; a content-sized frame is measured from the content, so a viewport-sized root never shrinks and grows the frame on every re-measure.`,
      "Remove the viewport height — size to content, never to the viewport. Under fullscreen the frame stretches your root already (centre inside it with `display: flex; flex-direction: column; justify-content: center`); to fill a parent that has a height use `height: 100%` or `flex: 1`.",
    ),
  ];
}

// ── universal.terminal_action_unguarded (ggui#1108, mitigation) ────────
// A control whose action the user means ONCE — submit, confirm, approve,
// schedule, reserve, book, pay, checkout, place order — that stays armed after
// it fires is one double-click away from doing it twice. The check is a WARN,
// deliberately: terminality lives in the request and the contract, not in a
// name, so a static rule can suspect it and must not refuse over it. It fires
// only when a terminal-sounding action or control exists AND the source guards
// nothing at all (no `disabled=`, no `aria-disabled`), which is the shape with
// no reading under which the control is safe.
/** The words that make an action read as meant-once. Matched as WORDS, never as substrings. */
const TERMINAL_WORDS = new Set([
  "submit", "confirm", "approve", "schedule", "reserve", "book", "pay", "checkout", "purchase", "order",
]);
/** In prose (a control's label) the same words, with real boundaries. */
const TERMINAL_LABEL_RX = /\b(submit|confirm|approve|schedule|reserve|book|pay|checkout|purchase|place\s+order)\b/i;
const GUARD_RX = /\b(disabled|aria-disabled)\s*=/;

/** `submitBooking` → ['submit','booking']; `place_order` → ['place','order']. A NAME is words, not a string to search. */
function nameWords(name: string): string[] {
  return name
    .split(/(?=[A-Z])|[_\-\s]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

/** The terminal-sounding action names and control labels a source carries, deduped, in order. */
export function findUnguardedTerminalControls(sourceCode: string): string[] {
  if (GUARD_RX.test(sourceCode)) return [];
  const names = new Set<string>();
  for (const m of sourceCode.matchAll(/useAction(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/g)) {
    const name = m[1] ?? "";
    if (nameWords(name).some((w) => TERMINAL_WORDS.has(w))) names.add(name);
  }
  // A control's own words, taken as the plain text immediately before its close
  // tag — attributes can carry `=>`, so a label is read from the text, never by
  // trying to skip an attribute list with a regex.
  for (const m of sourceCode.matchAll(/>([^<>{}]{1,60})<\/Button>/g)) {
    const label = (m[1] ?? "").replace(/\s+/g, " ").trim();
    if (label.length > 0 && TERMINAL_LABEL_RX.test(label)) names.add(label.slice(0, 40));
  }
  return [...names];
}

function runTerminalActionUnguarded(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const found = findUnguardedTerminalControls(input.sourceCode);
  if (found.length === 0) return [];
  const list = found.map((t) => `"${t}"`).join(", ");
  return [
    mkIssue(
      "universal.terminal_action_unguarded",
      `${list} reads as an action the user means once, and nothing in this component disables the control after it fires — a double-click sends it twice.`,
      "Hold the fired state (`const [submitted, setSubmitted] = useState(false)`), set it in the handler, and pass `disabled={submitted}` to that control with a word that says so (\"Submitted\"). If the action IS meant to repeat — sending a message, adding an item — leave it armed and ignore this.",
      "warn",
    ),
  ];
}

// ── universal.root_width_cap (ggui#1117 — the eval leg ggui#1113 left out) ─
// FRAME_SIZING's width half: the outermost element FILLS the frame; a width
// cap belongs INSIDE it, on the column that holds text. A cap on the root is
// the defect on a wide canvas (the card becomes a narrow strip with the
// frame's ground on either side) and a no-op in a chat bubble (~400 px; a
// 480 px cap never binds) — so the check reads `input.canvas`: it stands
// down with no canvas (never a guess) and below `md`, and fires only for a
// cap SMALLER than the canvas. A bare `<Container>` is a cap too — its
// default preset is `lg`, 768 px — so it binds on `lg` / `xl` and not on
// `md`. A cap the check cannot resolve to pixels (a `max-w-*` class, `rem`,
// `%`) is reported because the prompt forbids it on the root. WARN, not
// fail: the prompt names the one shape never to write; whether a centred
// column was the right composition stays the model's call.
export interface RootWidthCap {
  /** The outermost element's tag name as written. */
  readonly element: string;
  /** The cap as written (`maxWidth="sm"`, `maxWidth: '480px'`, `max-w-md`, or `lg (Container default)`). */
  readonly cap: string;
  /** The cap in pixels when it resolves (a Container preset, an `Npx` value); `null` otherwise. */
  readonly px: number | null;
}

/** The opening tag of the OUTERMOST element the default export returns, as written; `null` for none or a fragment. */
function rootOpeningTag(sourceCode: string): { readonly name: string; readonly attrs: string } | null {
  const start = sourceCode.indexOf("export default function");
  const body = start >= 0 ? sourceCode.slice(start) : sourceCode;
  const ret = /\breturn\s*\(?\s*</.exec(body);
  if (ret === null) return null;
  const at = ret.index + ret[0].length - 1;
  const nameMatch = /^<([A-Za-z][\w.]*)/.exec(body.slice(at));
  if (nameMatch === null) return null;
  let j = at + nameMatch[0].length;
  let depth = 0;
  let quote: string | null = null;
  for (; j < body.length; j++) {
    const ch = body[j]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) break;
  }
  return { name: nameMatch[1]!, attrs: body.slice(at + nameMatch[0].length, j) };
}

const CONTAINER_PRESETS: Readonly<Record<string, string>> = CONTAINER_MAX_WIDTH;
const NOT_A_CAP = new Set(["full", "none", "100%", "unset", "initial", "inherit"]);

/** `sm` → 480; `480px` → 480; `100%` / `full` → not a cap (`undefined`); anything else → a cap of unknown size (`null`). */
function capPx(value: string): number | null | undefined {
  const v = value.trim();
  if (NOT_A_CAP.has(v)) return undefined;
  const resolved = CONTAINER_PRESETS[v] ?? v;
  if (NOT_A_CAP.has(resolved)) return undefined;
  const px = /^(\d+(?:\.\d+)?)px$/.exec(resolved);
  return px === null ? null : Number(px[1]);
}

/** The width cap the outermost returned element carries, or `null` when it fills the frame. */
export function findRootWidthCap(sourceCode: string): RootWidthCap | null {
  const root = rootOpeningTag(sourceCode);
  if (root === null) return null;
  const { name, attrs } = root;
  const prop = /\bmaxWidth\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?))\s*\})/.exec(attrs);
  if (prop !== null) {
    const raw = prop[1] ?? prop[2] ?? prop[3] ?? prop[4] ?? `${prop[5]!}px`;
    const px = capPx(raw);
    return px === undefined ? null : { element: name, cap: `maxWidth="${raw}"`, px };
  }
  const style = /\bmaxWidth\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|(\d+(?:\.\d+)?))/.exec(attrs);
  if (style !== null) {
    const raw = style[1] ?? style[2] ?? style[3] ?? `${style[4]!}px`;
    const px = capPx(raw);
    return px === undefined ? null : { element: name, cap: `maxWidth: '${raw}'`, px };
  }
  const cls = /(?<![\w-])max-w-([\w[\]%.-]+)/.exec(attrs);
  if (cls !== null) {
    if (cls[1] === "full" || cls[1] === "none") return null;
    return { element: name, cap: `max-w-${cls[1]!}`, px: null };
  }
  if (name === "Container") return { element: name, cap: "lg (Container default)", px: capPx("lg") ?? null };
  return null;
}

const WIDE_CANVASES: ReadonlySet<CanvasClass> = new Set<CanvasClass>(["md", "lg", "xl"]);

function runRootWidthCap(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  if (input.canvas === undefined || !WIDE_CANVASES.has(input.canvas)) return [];
  const cap = findRootWidthCap(input.sourceCode);
  if (cap === null) return [];
  const width = CANVAS_VIEWPORTS[input.canvas].width;
  if (cap.px !== null && cap.px >= width) return [];
  const sized = cap.px !== null ? `${cap.px}px on a ${width}px canvas` : `on a ${width}px canvas`;
  return [
    mkIssue(
      "universal.root_width_cap",
      `The outermost element <${cap.element}> carries a width cap (${cap.cap}, ${sized}): on this canvas the card becomes a narrow strip with the frame's ground on either side. The frame owns the width; a cap belongs INSIDE the root, on the column that holds text.`,
      'Let the root fill the frame — drop the cap on the element you return at the top (or `maxWidth="full"`) — and put the reading measure on an inner column: `<Box padding="lg"><Container maxWidth="sm">…</Container></Box>`.',
      "warn",
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
    id: "universal.caps_label_invented",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runCapsLabelInvented,
  },
  {
    id: "universal.viewport_sized",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runViewportSized,
  },
  {
    id: "universal.root_width_cap",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runRootWidthCap,
  },
  {
    id: "universal.terminal_action_unguarded",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runTerminalActionUnguarded,
  },
  {
    id: "universal.accent_text_ink",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runAccentTextInk,
  },
  {
    id: "universal.scoped_surface_owns_ground",
    axis: "render",
    values: ALL_RENDER_VALUES,
    run: runScopedSurfaceOwnsGround,
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
