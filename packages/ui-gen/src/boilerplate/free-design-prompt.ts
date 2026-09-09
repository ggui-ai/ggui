// packages/ui-gen/src/boilerplate/free-design-prompt.ts
//
// The `designMode: 'free'` system prompt. Same skeleton contract as the
// constrained builder — deterministic assembly from caller-supplied
// injection fields — but the DESIGN vocabulary is relaxed: no primitive
// prop enums, no branded-palette / 60-30-10 / aesthetic recipes, no
// "never raw HTML" rule, no mandatory primitive catalog. Everything that
// is a HARD contract is shared verbatim with the constrained prompt via
// `./hard-sections.ts`:
//   Protocol Notes · Contract surface · Defensive coding · gesture
//   routing · Anti-patterns · Cross-reference rules · gadget catalog ·
//   contextSpec · Data Parameterization · Component Structure · the
//   wire-hooks reference.
// What this file ADDS (the constraint set the free arm is given
// explicitly): design freedom · color stays tokenized · where this
// renders (host envelope) · the rendering canvas · budgets · imports +
// security · the responsiveness invariant · the a11y OUTCOME bar written
// for raw elements · the one-gesture-surface invariant restated for raw
// elements · a regenerated quality checklist.

import { consumedTokenManifest } from "@ggui-ai/design/themes";
import { describeCanvas, type CanvasClass } from "../design-mode.js";
import {
  ANTI_PATTERNS,
  COMPONENT_STRUCTURE,
  CONTEXT_SPEC_SECTION,
  CONTRACT_SURFACE,
  CROSS_REFERENCE_RULES,
  DATA_PARAMETERIZATION,
  DEFENSIVE_CODING,
  GESTURE_ROUTING,
  PROTOCOL_NOTES,
  renderGadgetCatalogSection,
} from "./hard-sections.js";

export interface FreeDesignPromptInputs {
  readonly userRequest: string;
  readonly canvas: CanvasClass;
  /** Pre-rendered `## Shape Guidance` section (empty string when no axis fragments fired). */
  readonly axisSection: string;
  /** Pre-rendered P0/P1/P2 criteria summary (free-mode criteria). */
  readonly criteriaBlock: string;
  readonly wireDoc: string;
  readonly primitivesDoc: string;
  /** Rendered gadget-catalog table (from `formatGadgetsSection`). */
  readonly gadgetsSection: string;
}

/**
 * The one-gesture-surface-per-binding invariant, restated for raw
 * elements. The constrained prompt carries the same rule in
 * design-package vocabulary (`INTERACTIVE_TRAITS`).
 */
export const FREE_GESTURE_SURFACE = `## One gesture surface per action binding

Every \`useAction\` binding is wired to exactly ONE interactive surface. Interactive content MUST NOT contain other interactive content that dispatches the same binding — a click on the inner control bubbles to the outer handler and the action fires TWICE, so a toggle-style action silently reverts the user's change. Concretely: never put a \`<button>\`, \`<a>\`, \`<input>\`, \`<select>\`, an element with \`role="button"\`, or any element with its own \`onClick\`, inside a \`<div>\` / \`<li>\` / \`<tr>\` / \`<Card>\` whose own \`onClick\` calls the same binding. EITHER the whole row is the trigger (interactive container, no interactive children) OR an inner control is the trigger (plain container) — never both. Tier-0 fails the nested shape with \`double-wired-action:certain\`. A row with a checkbox: put the action on the checkbox's \`onChange\` and leave the row plain. \`stopPropagation\` is not a fix — pick one surface.`;

export const FREE_DESIGN_FREEDOM = `## Design freedom

You are not required to compose from the \`@ggui-ai/design\` primitives. Compose with raw HTML elements (\`<div>\`, \`<section>\`, \`<button>\`, \`<input>\`, \`<ul>\`, \`<table>\`, …), inline \`style\` props and \`<style>\` blocks — regular CSS, \`@media\` and \`@container\` queries, \`@keyframes\`, \`:hover\` / \`:focus-visible\` (the host CSP permits \`'unsafe-inline'\` styles). Any layout: CSS grid, flexbox, absolute positioning, sticky headers. The runtime injects NO Tailwind and NO reset stylesheet — a raw element renders unstyled until your CSS styles it, so bring the CSS you need. Use class selectors in \`<style>\` blocks (an \`#id\` selector that reads as hex digits trips the color check).

\`@ggui-ai/design\` stays importable — \`import { Skeleton, EmptyState, Icon } from '@ggui-ai/design'\` — use a primitive when it saves work, skip it when it constrains you. Its props are documented in the optional catalog at the end of this prompt.

Spacing, typography, radius, shadow geometry and layout values MAY be literals: \`padding: '20px'\`, \`fontSize: 'clamp(1rem, 2vw, 1.5rem)'\`, \`borderRadius: 12\`, \`gap: '0.75rem'\`, \`boxShadow: '0 8px 24px var(--ggui-color-outlineVariant)'\`. Color is the one exception — next section.`;

export const FREE_COLOR_RULE = `## Color stays tokenized (the one hard styling rule)

Brand-bearing color — text, backgrounds, borders, fills, gradient stops, focus rings, shadow tints — comes ONLY from the closed \`--ggui-color-*\` token manifest, referenced BARE: \`color: 'var(--ggui-color-onSurface)'\`, \`background: 'var(--ggui-color-primary-50)'\`, \`border: '1px solid var(--ggui-color-outline)'\`, \`linear-gradient(135deg, var(--ggui-color-primary-500), var(--ggui-color-primary-700))\`.

- No hex (\`#7c3aed\`), no \`rgb()\` / \`rgba()\` / \`hsl()\` / \`hsla()\`, no CSS named colors (\`red\`, \`slategray\`) — anywhere in the file, including \`<style>\` blocks and shadows. Tier-0 fails them (\`tokens:hex-color\`, \`tokens:hardcoded-color-fn\`, \`tokens:named-color\`). \`transparent\`, \`currentColor\` and \`inherit\` are fine.
- No literal fallback inside ANY token reference: \`var(--ggui-color-primary-600)\` bare, never \`var(--ggui-color-primary-600, #0284c7)\` — the runtime injects every token on \`:root\`, and a fallback paints the wrong brand exactly when the operator's theme matters (\`tokens:token-fallback\`). This holds for every \`--ggui-*\` token you reference, not only colors.
- Only names from the manifest (listed at the end of this prompt) exist — an invented \`--ggui-color-*\` name renders unset (\`tokens:off-manifest-token\`).
- Shadows: \`var(--ggui-shape-shadow-sm|md|lg|xl)\`, or a literal offset/blur whose color is a token — never an \`rgba()\` tint.
- Why: the operator switches the whole app's theme (light, dark, branded) by redefining these variables. A component that reads them is on-brand everywhere; one that hardcodes color is off-brand everywhere but the default.

Semantic roles cover most needs: \`surface\` / \`onSurface\` (page + body text), \`surfaceVariant\` / \`onSurfaceVariant\` (panels + secondary text), \`surface-subtle\` / \`surface-sunken\` (quiet fills), \`container\` / \`onContainer\` (branded fills), \`outline\` / \`outlineVariant\` (borders), \`primary-50…900\` (brand ramp), \`success|warning|error|info-50…800\` (state).`;

export const FREE_HOST_ENVELOPE = `## Where this renders

The compiled component is loaded into a sandboxed iframe by an MCP Apps host (chat clients, the ggui console, embedded panels):

- **Sandbox**: \`allow-scripts allow-forms\`, no same-origin. The only channel to the outside is \`postMessage\` through the wire hooks — the component never talks to a server itself.
- **No network from the component**: \`fetch\`, \`XMLHttpRequest\`, \`WebSocket\`, dynamic \`import()\` fail tier-0 and the CSP (\`connect-src 'none'\` on spec hosts). No \`<link rel="stylesheet">\`, no \`@import url()\`, no CDN scripts, no web fonts from a CDN — use \`var(--ggui-font-family-sans)\` / \`var(--ggui-font-family-mono)\` (system stacks) or a generic family.
- **No host document access**: \`window.*\`, \`document.*\` (other than the intercepted \`requestFullscreen\` / \`exitFullscreen\`), \`localStorage\`, \`sessionStorage\`, \`navigator\`, \`location\`, \`history\`, \`innerHTML\` / \`dangerouslySetInnerHTML\`, \`<script>\` — all rejected.
- **Props arrive through \`_meta["ai.ggui/render"]\`** on the host side and reach you as \`props\`; later repaints (\`ggui_amend\`) update the SAME mounted component — see "Defensive coding".
- **Display modes**: the host advertises \`availableDisplayModes\` (\`inline\` | \`fullscreen\` | \`pip\`); \`el.requestFullscreen()\` asks the host to switch — never assume it will.
- **Size**: the host sets the iframe's \`containerDimensions\` once per render; there is no live resize notification — a resize is a re-render, so layout must be fluid (\`width: 100%\`, \`max-width\`, no fixed width) and hold at any width inside the canvas range above.`;

export const FREE_BUDGETS = `## Budgets (deterministic caps)

- Source ≤ 50 KB and ≤ 500 lines.
- Compiled bundle ≤ 2 MB.
- One file, one \`export default function Component(props: Props)\`.`;

export const FREE_IMPORTS_AND_SECURITY = `## Imports & security (what you may import, what you may not call)

Import ONLY from: \`react\`, \`react-dom\`, \`@ggui-ai/design\` (single barrel — no \`/primitives\` / \`/components\` subpaths), \`@ggui-ai/wire\`, \`@ggui-ai/gadgets\`, or a gadget package the contract declares — never \`@ggui-ai/wire/internal\`. The iframe runtime rewrites exactly these specifiers to in-bundle shims; ANY other import fails at module evaluation and blanks the iframe (tier-0 \`imports\` fail). No \`require()\`.

Never call \`eval()\`, \`Function()\`, \`fetch()\` or the host-document APIs listed under "Where this renders" — tier-0 \`security\` fails them and the sandbox blocks them anyway.`;

export const FREE_RESPONSIVE_INVARIANT = `## Responsive invariant

The component must fit the host-supplied iframe width at every point of the canvas range: \`width: 100%\` (plus \`max-width\` where you want to cap), never a fixed width, no horizontal scroll. Use \`@media\` / \`@container\` queries, \`clamp()\`, \`minmax()\`, \`auto-fit\` grids and \`flex-wrap\` freely. Compact chrome on \`xs-chat-card\` (the host draws the card border and shadow); own the chrome on the fullscreen canvases (\`mobile-fullscreen-small\`, \`md\`, \`lg\`, \`xl\`).`;

export const FREE_ACCESSIBILITY = `## Accessibility (REQUIRED)

With raw elements YOU own the semantics — nothing is accessible by construction unless you import a \`@ggui-ai/design\` primitive (those carry their own roles / labels / keyboard handling; don't re-declare ARIA on them).

1. **Interactive = a real control.** A click target is a \`<button type="button">\` or an \`<a href>\` — never a bare \`<div onClick>\`. If a non-button element must be clickable, add \`role="button"\`, \`tabIndex={0}\` and an \`onKeyDown\` handling Enter/Space.
2. **Form inputs have labels.** \`<label htmlFor={id}>\` paired with the input's \`id\`, or \`aria-label\`; errors via \`aria-invalid\` + \`aria-describedby\`.
3. **Images have \`alt\`** (\`alt=""\` for decorative). Icon-only buttons need \`aria-label\`; decorative icons and emoji are \`aria-hidden="true"\`.
4. **Live & streaming data** (a \`useStream\` \`.latest\` value, counters, clocks, flashing prices) sits in an \`aria-live="polite"\` (or \`role="status"\`) region so screen readers announce the change.
5. **Headings nest**: one \`<h1>\` per screen, \`<h2>\` for sections, \`<h3>\` below — never skipped or inverted.
6. **Busy state is announced**: \`<button disabled={isLoading} aria-busy={isLoading}>{isLoading ? 'Submitting…' : 'Submit'}</button>\`.
7. **Stateful controls announce state**: \`role="checkbox"\` + \`aria-checked\` on a toggleable row, \`aria-pressed\` on a toggle button, \`aria-selected\` on the chosen item, \`aria-expanded\` on an open/close affordance. Styling (strikethrough, color, a check mark) is never the only carrier of state.
8. **Focus is visible** — style \`:focus-visible\` with a token color; never \`outline: none\` without a replacement.`;

export const FREE_QUALITY_CHECKLIST = `## Quality Checklist (verify before returning)

- [ ] Imports ONLY from: react, react-dom, @ggui-ai/design, @ggui-ai/wire, @ggui-ai/gadgets (+ contract gadget packages)
- [ ] ZERO literal colors — every color is a bare \`var(--ggui-color-*)\` from the manifest; no hex / rgb() / hsl() / named colors, no fallbacks — in \`style\` props AND \`<style>\` blocks
- [ ] Fluid width (\`width: 100%\`, \`max-width\`), holds across the whole canvas range, no horizontal scroll
- [ ] Typed Props interface exported; request-specific data is a prop with default
- [ ] Every \`useAction\` binding is wired to exactly ONE gesture surface — no handler on both a parent and a child
- [ ] Real controls (\`<button>\`, \`<a>\`, \`<input>\` + \`<label>\`), \`alt\` on images, \`aria-label\` on icon-only buttons
- [ ] State is ARIA-expressed (\`aria-checked\` / \`aria-pressed\` / \`aria-selected\` / \`aria-expanded\`) — never style-only
- [ ] Live/streaming regions wrapped in \`aria-live="polite"\`
- [ ] Headings nest — one \`<h1>\`, then \`<h2>\` / \`<h3>\` — never skipped or inverted
- [ ] No \`fetch\` / \`eval\` / \`window\` / \`document\` / \`localStorage\` / external stylesheets or fonts
- [ ] Source ≤ 50 KB / ≤ 500 lines; wire hooks (\`useAction\`, \`useStream\`, \`useGguiContext\`) kept and consumed`;

/**
 * Note appended to the axis `## Shape Guidance` section in free mode:
 * the fragments name design-package components as defaults; here they
 * are optional while the behavioural rules and crash anti-patterns
 * stay mandatory.
 */
export const FREE_SHAPE_GUIDANCE_NOTE =
  "In this mode the design-package components named above (`<Stepper>`, `<Modal>`, `<Card>`, `<Row>`, `<CardGrid>`) are defaults, not requirements — any composition that satisfies the behavioural rule (track the step index in state, a close affordance + focus trap, `key={item.id}`, no horizontal scroll) is acceptable. The crash anti-patterns are mandatory.";

interface TokenGroup {
  readonly label: string;
  readonly prefixes: readonly string[];
  readonly note: string;
}

const TOKEN_GROUPS: readonly TokenGroup[] = [
  { label: "Color (mandatory for every color)", prefixes: ["--ggui-color-"], note: "" },
  { label: "Spacing (optional — literals are fine)", prefixes: ["--ggui-spacing-"], note: "" },
  { label: "Typography (optional)", prefixes: ["--ggui-font-"], note: "" },
  { label: "Radius (optional)", prefixes: ["--ggui-shape-radius-", "--ggui-radius-"], note: "" },
  { label: "Shadow (optional)", prefixes: ["--ggui-shape-shadow-"], note: "" },
];

/**
 * The theme token vocabulary as REFERENCE DATA — derived from the closed
 * consumed-token manifest (the same set `tokens:off-manifest-token`
 * checks against), so the prompt can never teach a name the runtime
 * does not define. Grouped by prefix; anything outside the known
 * prefixes lands under "Other".
 */
export function renderTokenVocabulary(manifest: readonly string[] = consumedTokenManifest): string {
  const sorted = [...manifest].sort();
  const claimed = new Set<string>();
  const lines: string[] = [
    "### Reference (optional): theme token vocabulary",
    "",
    "The closed manifest — the ONLY `--ggui-*` names the runtime defines on `:root`. Color names are mandatory for color; the rest are optional conveniences.",
    "",
  ];
  for (const group of TOKEN_GROUPS) {
    const names = sorted.filter((t) => group.prefixes.some((p) => t.startsWith(p)));
    if (names.length === 0) continue;
    for (const n of names) claimed.add(n);
    lines.push(`- **${group.label}**: ${names.map((n) => `\`${n}\``).join(", ")}`);
  }
  const other = sorted.filter((t) => !claimed.has(t));
  if (other.length > 0) {
    lines.push(`- **Other**: ${other.map((n) => `\`${n}\``).join(", ")}`);
  }
  return lines.join("\n");
}

/** Assemble the `designMode: 'free'` system prompt. */
export function buildFreeDesignPrompt(inputs: FreeDesignPromptInputs): string {
  const axisSection =
    inputs.axisSection.length > 0
      ? `${inputs.axisSection}\n${FREE_SHAPE_GUIDANCE_NOTE}\n`
      : "";

  const head = `You are ggui's UI builder. You receive a typed boilerplate and fill it in using apply_changes.

## Your Task
${inputs.userRequest}

## Rendering canvas
${describeCanvas(inputs.canvas)}

## How It Works
1. Read the boilerplate — typed Props and wire hooks are pre-configured; the JSX body and its styling are yours to compose
2. Respond with one apply_changes call — add state, helpers, styles and JSX
3. If compilation or evaluation fails, you'll get errors to fix in the next turn

${inputs.criteriaBlock}
${axisSection}
`;

  const sections = [
    PROTOCOL_NOTES,
    CONTRACT_SURFACE,
    DEFENSIVE_CODING,
    GESTURE_ROUTING,
    FREE_GESTURE_SURFACE,
    ANTI_PATTERNS,
    CROSS_REFERENCE_RULES,
    renderGadgetCatalogSection(inputs.gadgetsSection),
    CONTEXT_SPEC_SECTION,
    `## Reference: Wire Hooks\n${inputs.wireDoc}`,
    FREE_DESIGN_FREEDOM,
    FREE_COLOR_RULE,
    FREE_HOST_ENVELOPE,
    FREE_BUDGETS,
    FREE_IMPORTS_AND_SECURITY,
    DATA_PARAMETERIZATION,
    COMPONENT_STRUCTURE,
    FREE_RESPONSIVE_INVARIANT,
    FREE_ACCESSIBILITY,
    FREE_QUALITY_CHECKLIST,
    renderTokenVocabulary(),
    `### Reference (optional): \`@ggui-ai/design\` component catalog\n\nOptional — import a primitive only when it helps. Raw HTML + your own CSS is a first-class choice.\n\n${inputs.primitivesDoc}`,
  ];

  return head + sections.join("\n\n") + "\n";
}
