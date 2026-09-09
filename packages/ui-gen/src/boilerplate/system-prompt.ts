// packages/ui-gen/src/boilerplate/system-prompt.ts
//
// System-prompt skeleton for the coding agent. Deterministic assembly;
// injection points for funnel content (pitfalls) and for large content
// blocks that are OWNED BY OTHER PACKAGES (design-system docs,
// primitives doc, wire doc). Those blocks travel as strings so ui-gen
// doesn't silently pull in megabytes of auto-generated content from
// `@ggui-ai/design` / `@ggui-ai/wire` that those packages authoritatively
// own.
//
// The only content this skeleton carries by default is the coding-
// criteria summary (`buildCodingCriteriaSummary()` over the open
// `CRITERIA` single-source-of-truth). Everything else defaults to empty
// string — the skeleton still renders cleanly for OSS callers who don't
// pass doc blocks.

import { resolveAppGadgets } from "@ggui-ai/protocol";
import type {
  GadgetDescriptor,
  GadgetExport,
  GadgetHookExport,
  GadgetComponentExport,
} from "@ggui-ai/protocol";
import { buildCodingCriteriaSummary } from "../evaluation/types-public.js";
import {
  DEFAULT_DESIGN_MODE,
  canvasForRendering,
  type DesignMode,
  type RenderCanvas,
} from "../design-mode.js";
import { buildFreeDesignPrompt } from "./free-design-prompt.js";
import {
  ANTI_PATTERNS,
  COMPONENT_STRUCTURE,
  CONTEXT_SPEC_SECTION,
  CONTRACT_SURFACE,
  CROSS_REFERENCE_RULES,
  DATA_PARAMETERIZATION,
  DEFENSIVE_CODING,
  GESTURE_ROUTING,
  INTERACTIVE_TRAITS,
  PROTOCOL_NOTES,
  renderGadgetCatalogSection,
} from "./hard-sections.js";
import {
  extractCallSignaturesFromDts,
  extractComponentPropsFromDts,
} from "../internal/extract-call-signatures.js";

/** Narrow a {@link GadgetExport} to its hook variant by field presence. */
function isHookExport(exp: GadgetExport): exp is GadgetHookExport {
  return "hook" in exp;
}

/** Narrow a {@link GadgetExport} to its component variant by field presence. */
function isComponentExport(exp: GadgetExport): exp is GadgetComponentExport {
  return "component" in exp;
}

export interface SystemPromptInputs {
  /** The user's original request. */
  userRequest: string;
  /** Shell layout mode. */
  shellType?: string;
  /** Target screen size. */
  screen?: string;
  /** Axis-conditioned prompt fragments (from `compose()`). */
  axisDelta?: string;
  /**
   * Funnel content injection — env-gated pitfalls block rendered by the
   * caller. OSS default: `""`. The hosted runtime's core wrapper passes
   * `renderPitfallsBlock()` which honors `GGUI_PITFALLS` /
   * `GGUI_NEW_PITFALLS` env vars.
   */
  pitfallsBlock?: string;
  /**
   * Pre-rendered criteria block. Defaults to
   * `buildCodingCriteriaSummary()` over the open CRITERIA registry.
   * Callers that want to override (e.g. a trimmed summary for fast mode)
   * pass their own string.
   */
  criteriaBlock?: string;
  /** Hand-written design-token reference. Owned by `@ggui-ai/design`. */
  designSystemDocs?: string;
  /** Auto-generated primitives reference. Owned by `@ggui-ai/design`. */
  primitivesDoc?: string;
  /** Auto-generated wire-hooks reference. Owned by `@ggui-ai/wire`. */
  wireDoc?: string;
  /**
   * Per-app gadget catalog. When provided, replaces the default
   * `STDLIB_GADGETS`-only table in the
   * `clientCapabilities — registered catalog` section so registered
   * third-party gadgets (Leaflet, Mapbox, Stripe, …) instruct the
   * code-gen LLM with the same teaching text the synth + decision LLMs
   * see.
   *
   * When omitted, the section renders the standard-library seed (the
   * first-party browser-capability hooks).
   */
  appGadgets?: readonly GadgetDescriptor[];
  /**
   * A `package -> .d.ts content` map for THIRD-PARTY gadget wrappers
   * (the render handler parallel-fetches each non-stdlib gadget's
   * `.d.ts`). When a gadget's `package` has an entry here,
   * `formatGadgetsSection` renders a `**Type**:` line carrying the
   * hook's extracted call signature — the LLM sees the real call shape
   * of a wrapper it cannot otherwise know.
   *
   * Stdlib gadgets (`@ggui-ai/gadgets`) get NO `Type:` line — they
   * already carry an `example` and are well-known; extracting stdlib
   * signatures is deliberately out of scope. Omit for STDLIB-only
   * callers (the section stays byte-identical).
   */
  gadgetTypes?: Readonly<Record<string, string>>;
  /**
   * Which triad the prompt teaches. `constrained` (default) is today's
   * design-system prompt, byte-identical to the pre-`designMode`
   * output; `free` relaxes only the design vocabulary — see
   * `./free-design-prompt.ts` and `../design-mode.ts`.
   */
  designMode?: DesignMode;
  /**
   * Rendering canvas class — `free` mode only. Rendered as an explicit
   * width-range sentence so the agent is TOLD its canvas. When omitted
   * it is derived from `shellType` × `screen`. Ignored in `constrained`
   * mode (that prompt keeps its shell/screen descriptors verbatim).
   */
  canvas?: RenderCanvas;
}

const SHELL_DESCRIPTIONS: Record<string, string> = {
  chat: "inline component inside ChatShell message bubble (~400px wide, compact)",
  fullscreen: "full viewport, responsive layout",
  spatial: "floating AR/VR panel (~600px, touch-friendly)",
};

const SCREEN_DESCRIPTIONS: Record<string, string> = {
  mobile: "single column, large touch targets",
  tablet: "flexible columns, medium spacing",
  desktop: "multi-column, dense layout",
  universal: "responsive across all breakpoints",
};

/**
 * Render the `clientCapabilities — registered catalog` table from the
 * per-app gadget catalog. Each registered gadget renders one row
 * with hook + permission + the `description`-or-`usage` field as the
 * "what it does" column. Permission falls back to `(none)` when the
 * descriptor doesn't declare one.
 *
 * The table is built dynamically from the catalog so all three triad
 * surfaces (synth contract authoring, decision LLM, code-gen system
 * prompt) instruct the model uniformly about which gadgets are
 * available.
 *
 * Rows are emitted in catalog order. An empty catalog produces a hint
 * to seed it via `app.gadgets` rather than an empty table.
 *
 * When `gadgetTypes` carries a `.d.ts` for a gadget's `package`, a
 * `**Type**:` block is appended after the table with one line per
 * THIRD-PARTY gadget: `\`<hook>\`: <extracted call signature>`. The
 * signature is extracted from the wrapper's `.d.ts` via
 * `extractCallSignaturesFromDts`. Stdlib gadgets (`@ggui-ai/gadgets`)
 * get NO `Type:` line — they already carry an `example` and are
 * well-known. A hook whose signature can't be extracted is silently
 * skipped.
 *
 * Pure helper. Exported for unit testing.
 */
export function formatGadgetsSection(
  appGadgets: readonly GadgetDescriptor[],
  gadgetTypes?: Readonly<Record<string, string>>,
): string {
  if (appGadgets.length === 0) {
    return [
      "When the contract declares a `clientCapabilities.gadgets` entry,",
      "the hook MUST be one the operator has registered on",
      "`App.gadgets`. The default ggui server seeds the 7",
      "first-party STDLIB hooks; this server has none registered (the",
      "operator's `ggui.json#app.gadgets` is empty). Don't",
      "declare `clientCapabilities.gadgets` until a hook is registered.",
    ].join(" ");
  }
  // The LLM DIRECT-IMPORTS gadget hooks. The boilerplate emits
  // one combined `import { hookA, hookB } from '<package>'` line per
  // registered gadget package, above a `DO NOT EDIT` banner. The
  // `Package` column below IS the import specifier — it is load-bearing.
  //
  // Each `GadgetDescriptor` is a PACKAGE with `exports[]`;
  // flatten to the hook exports (one table row per hook), carrying
  // package identity through for the Package column.
  const hookExports = appGadgets.flatMap((descriptor) =>
    descriptor.exports
      .filter(isHookExport)
      .map((exp) => ({ exp, descriptor })),
  );
  // Component exports get their own table + render teaching.
  const componentExports = appGadgets.flatMap((descriptor) =>
    descriptor.exports
      .filter(isComponentExport)
      .map((exp) => ({ exp, descriptor })),
  );
  const header =
    "When the contract declares a hook gadget on `clientCapabilities.gadgets`, the hook MUST be one of the registered hooks below. The boilerplate has already emitted a direct import per gadget package — `import { <hook>, … } from '<package>'` — above a `// DO NOT EDIT` banner. KEEP those imports exactly; they are the runtime-resolution anchor and self_check rejects the code if one disappears. Import each STDLIB hook from `@ggui-ai/gadgets`; import each third-party hook from the package named in the `Package` column. DO NOT invent your own import paths. Available registered hooks:";
  const tableHead = [
    "| Hook                  | Package (import from here)         | Permission         | What it does                                |",
    "| --------------------- | ---------------------------------- | ------------------ | ------------------------------------------- |",
  ];
  const rows = hookExports.map(({ exp, descriptor }) => {
    const hookCol = `\`${exp.hook}\``.padEnd(21, " ");
    const pkgCol = `\`${descriptor.package}\``.padEnd(34, " ");
    const permCol = exp.permission
      ? `\`${exp.permission}\``.padEnd(18, " ")
      : "(none)".padEnd(18, " ");
    const what = (exp.usage ?? exp.description ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return `| ${hookCol} | ${pkgCol} | ${permCol} | ${what.padEnd(43, " ")} |`;
  });

  // `**Type**:` lines for THIRD-PARTY gadgets. A gadget is third-party
  // when its `package` has a `.d.ts` entry in `gadgetTypes` (stdlib
  // `@ggui-ai/gadgets` is never in the map). The LLM can't know a
  // third-party wrapper's call shape; the extracted signature gives it
  // the exact param/return type to code against.
  // Stdlib gadgets get nothing here by design — `example` covers them.
  const typeLines: string[] = [];
  if (gadgetTypes !== undefined) {
    for (const { exp, descriptor } of hookExports) {
      const dts = gadgetTypes[descriptor.package];
      if (dts === undefined) continue; // stdlib or no `.d.ts` fetched.
      const signatures = extractCallSignaturesFromDts(dts, [exp.hook]);
      const sig = signatures[exp.hook];
      if (sig === undefined) continue; // graceful — couldn't extract.
      typeLines.push(`- \`${exp.hook}\`: \`${sig}\``);
    }
  }
  const typeBlock =
    typeLines.length > 0
      ? [
          "",
          "**Type** (third-party gadgets — call signature from the wrapper's published `.d.ts`):",
          "",
          ...typeLines,
        ]
      : [];

  const hookSection =
    hookExports.length > 0
      ? [header, "", ...tableHead, ...rows, ...typeBlock].join("\n")
      : "";

  // Component gadgets: their own table + RENDER (not call)
  // teaching. A component export is mounted as a JSX element; the LLM
  // never invokes it like a hook.
  const componentRows = componentExports.map(({ exp, descriptor }) => {
    const compCol = `\`${exp.component}\``.padEnd(21, " ");
    const pkgCol = `\`${descriptor.package}\``.padEnd(34, " ");
    const what = (exp.usage ?? exp.description ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return `| ${compCol} | ${pkgCol} | ${what.padEnd(53, " ")} |`;
  });

  // `**Props**:` lines for THIRD-PARTY component gadgets. The
  // props-object shape is extracted from the wrapper's published
  // `.d.ts` so the LLM knows the exact JSX attributes of `<X … />`. A
  // component whose `package` has no `.d.ts` entry is skipped
  // (graceful — the `example` still covers it).
  const componentPropsLines: string[] = [];
  if (gadgetTypes !== undefined) {
    for (const { exp, descriptor } of componentExports) {
      const dts = gadgetTypes[descriptor.package];
      if (dts === undefined) continue; // stdlib or no `.d.ts` fetched.
      const propsMap = extractComponentPropsFromDts(dts, [exp.component]);
      const props = propsMap[exp.component];
      if (props === undefined) continue; // graceful — couldn't extract.
      componentPropsLines.push(`- \`${exp.component}\`: \`${props}\``);
    }
  }
  const componentPropsBlock =
    componentPropsLines.length > 0
      ? [
          "",
          "**Props** (third-party component gadgets — prop shape from the wrapper's published `.d.ts`):",
          "",
          ...componentPropsLines,
        ]
      : [];

  const componentSection =
    componentExports.length > 0
      ? [
          "When the contract declares a component gadget on `clientCapabilities.gadgets`, the export is a COMPONENT — RENDER it as a JSX element (`<X … />`) in the tree you return. Do NOT call it like a hook. The boilerplate has already emitted a direct import per gadget package — `import { <Component>, … } from '<package>'` — above a `// DO NOT EDIT` banner. KEEP those imports exactly; they are the runtime-resolution anchor and self_check rejects the code if one disappears. Import each component from the package named in the `Package` column. Available registered components:",
          "",
          "| Component             | Package (import from here)         | What it does                                          |",
          "| --------------------- | ---------------------------------- | ----------------------------------------------------- |",
          ...componentRows,
          ...componentPropsBlock,
        ].join("\n")
      : "";

  return [hookSection, componentSection]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

/**
 * Assemble the coding-agent system prompt. Deterministic — the only
 * variable content comes from the caller-supplied injection fields.
 */
export function buildSystemPrompt(inputs: SystemPromptInputs): string {
  const shell = inputs.shellType ?? "fullscreen";
  const scr = inputs.screen ?? "universal";
  const shellDesc = SHELL_DESCRIPTIONS[shell] ?? SHELL_DESCRIPTIONS.fullscreen;
  const screenDesc = SCREEN_DESCRIPTIONS[scr] ?? SCREEN_DESCRIPTIONS.universal;

  const designMode = inputs.designMode ?? DEFAULT_DESIGN_MODE;
  const criteriaBlock =
    inputs.criteriaBlock ?? buildCodingCriteriaSummary(designMode);
  const pitfallsBlock = inputs.pitfallsBlock ?? "";
  const designSystemDocs = inputs.designSystemDocs ?? "";
  const primitivesDoc = inputs.primitivesDoc ?? "";
  const wireDoc = inputs.wireDoc ?? "";
  // Default to the standard-library seed when no per-app catalog is
  // supplied. Callers that resolve `App.gadgets` thread it through here.
  //
  // `gadgetTypes` carries third-party wrapper `.d.ts` content;
  // `formatGadgetsSection` renders a `Type:` line per third-party
  // gadget from it. When omitted, no `Type:` lines are rendered.
  const gadgetsSection = formatGadgetsSection(
    resolveAppGadgets(inputs.appGadgets),
    inputs.gadgetTypes,
  );

  const axisSection =
    inputs.axisDelta && inputs.axisDelta.trim().length > 0
      ? `\n## Shape Guidance\n${inputs.axisDelta}\n`
      : "";

  if (designMode === "free") {
    return buildFreeDesignPrompt({
      userRequest: inputs.userRequest,
      canvas: inputs.canvas ?? canvasForRendering(inputs.shellType, inputs.screen),
      axisSection,
      criteriaBlock,
      wireDoc,
      primitivesDoc,
      gadgetsSection,
    });
  }

  return `You are ggui's UI builder. You receive a typed boilerplate and fill it in using apply_changes.

## Your Task
${inputs.userRequest}

## Rendering Context
- **Shell**: \`${shell}\` — ${shellDesc}
- **Screen**: \`${scr}\` — ${screenDesc}

## How It Works
1. Read the boilerplate — typed Props, wire hooks, and layout container are pre-configured
2. Respond with one apply_changes call — add state, helpers, and JSX
3. If compilation or evaluation fails, you'll get errors to fix in the next turn

${criteriaBlock}
${axisSection}
` +
    [
      PROTOCOL_NOTES,
      CONTRACT_SURFACE,
      DEFENSIVE_CODING,
      GESTURE_ROUTING,
      INTERACTIVE_TRAITS,
      ANTI_PATTERNS,
      CROSS_REFERENCE_RULES,
      renderGadgetCatalogSection(gadgetsSection),
      CONTEXT_SPEC_SECTION,
    ].join("\n\n") +
    `

${pitfallsBlock}

## Reference: Wire Hooks
${wireDoc}

${DESIGN_SYSTEM_GUIDANCE}

### CSS Token Documentation
${designSystemDocs}

### Component Reference
${primitivesDoc}
`;
}

/**
 * Hand-written design-system guidance embedded in every coding-agent
 * system prompt. Lists prop-value enums, branded color strategy, and
 * responsive/parameterization rules that make a generated component
 * feel polished — the system prompt without it would only list
 * primitive *names*. Exported so `prompt-type-drift.test.ts` can
 * verify its enum claims against the auto-generated primitive catalog.
 */
const DESIGN_SYSTEM_GUIDANCE_SURFACE_AND_TOKENS = `## Imports & Component Surface

Import ONLY from: \`react\`, \`@ggui-ai/design\`, \`@ggui-ai/wire\`. The ENTIRE design system — every primitive, component, composition and trait — is exported from the single \`@ggui-ai/design\` entry: \`import { Card, Grid, Stack, Modal, Clickable } from '@ggui-ai/design'\`. There are NO subpaths (\`/primitives\`, \`/components\`, …) — never import from them. Use the design components — DO NOT use raw HTML elements (\`<button>\`, \`<input>\`, \`<div>\` for layout) or Tailwind classes; those render unstyled in the iframe runtime.

Available primitives (all from \`@ggui-ai/design\`):
- Layout: Box, Container, Stack, Row, Grid, Spacer, Divider
- Typography: Heading, Text, Link
- Form: Button, Input, TextArea, Checkbox, Toggle, RadioGroup, Select, Slider
- Display: Card, Alert, Badge, Avatar, Image, Icon, Progress, Spinner, Skeleton, Tooltip
- Composite: Accordion, Tabs, Table, Toast

Available compound components (all from \`@ggui-ai/design\`):
- Autocomplete, Breadcrumb, Dropdown, EmptyState, FormField, Markdown, MarkdownInline, MenuItem, Pagination, SearchField, Stat, Stepper, Tag

**Choosing between similar components** — pick by intent, don't guess:
- **Pick from options**: one value from a short fixed list (a form field) → \`Select\`. Type-to-filter a long list, then pick → \`Autocomplete\`. A menu of actions off a button (edit / delete / …) → \`Dropdown\`. A search box that filters displayed content → \`SearchField\`.
- **Tabular data** → \`Table\`. Reach for \`DataTable\` ONLY when you need built-in sorting / pagination / row-selection.
- **Messaging**: an inline message in the layout flow → \`Alert\`. A transient popup → \`Toast\`. A panel listing many notifications → \`NotificationCenter\`.
- **Step progress**: a wizard's step indicator → \`Stepper\`. NOT \`Tabs\` (implies free navigation), NOT \`Progress\` (continuous bar), NOT \`Breadcrumb\` (hierarchy).
- **Containers**: width-constrain a page region → \`Container\`. A visually-contained surface (background + shadow + border) → \`Card\`. Plain grouping / spacing with no chrome → \`Box\`.

EXACT primitive prop values (other values are silently ignored — the design system maps them to defaults):
- \`<Text size="...">\` — ONLY \`xs | sm | base | lg | xl | 2xl | 3xl | 4xl\`. For a HUGE number/temperature, use \`<Text size="4xl" weight="bold">\`. \`caps\` uppercases with letter-spacing — the eyebrow/overline label look is \`<Text size="xs" weight="semibold" caps tone="muted">\`.
- \`<Text weight="...">\` — \`normal | medium | semibold | bold\`.
- \`<Text tone="...">\` — typed semantic slot. \`default | muted | subtle | emphasized | loud | success | warning | error | info | inverse | inherit\`. The theme decides what each tone LOOKS like — \`muted\` is a quiet warm grey on Claudic, a cool slate on Indigo. \`tone\` is the ONLY way to set Text color; the legacy \`color="..."\` prop has been removed.
- \`<Heading level={1|2|3|4|5|6}>\` — sizes are preset by level (h1 = 4xl bold, h2 = 3xl bold, h3 = 2xl semibold). Pass a number, not \`level="h1"\`. Heading uses the same \`tone\` slot vocabulary as Text.
- \`<Icon name="..." tone="...">\` / \`<Spinner tone="...">\` / \`<Link href="..." tone="...">\` / \`<Divider tone="...">\` — same \`tone\` vocabulary as Text. Default = \`currentColor\` (Icon), primary-tinted (Spinner / Link), outlineVariant (Divider). Use \`tone="inherit"\` when you want the element to track the parent's foreground color (e.g. an Icon next to muted text).
- \`<Button variant="...">\` — \`primary | secondary | outline | ghost | danger\`. Sizes \`xs | sm | md | lg\`. Use \`primary\` for the main action — renders in the brand color automatically.
- \`<Card padding="lg" shadow="md" radius="lg" surface="default">\` — shadow \`none|sm|md|lg|xl\`, radius \`none|sm|md|lg|xl\`. \`surface\` slot picks the fill: \`default | elevated | sunken | accent | inverted | transparent\`. Use \`inverted\` for dark testimonial-style cards on a light theme; \`accent\` for branded fills.
- \`<Box surface="...">\` — same surface slots as Card. \`surface\` is the ONLY theme-tracking background prop; the legacy \`background="..."\` prop has been removed. For non-theme-mapped brand colors (a partner's exact brand hex like Stripe purple), use the typed escape \`<Box assetColor="#635BFF" assetSemantic="stripe-brand-purple">\` — both props are required, and \`assetSemantic\` MUST be a non-empty human-readable label. Tier-0 self-check rejects every other hex / rgba on Box.
- \`<Stack gap="...">\` / \`<Row gap="...">\` — \`gap\` takes the **spacing scale** (next bullet). \`align\` (cross-axis) is ONLY \`start | center | end | stretch\` and \`justify\` (main-axis) is ONLY \`start | center | end | between | around | evenly\` — NEVER the raw CSS values \`flex-start\` / \`flex-end\` / \`space-between\`, which are type errors.
- **Spacing scale** — \`gap\` (Stack / Row / Grid) and \`padding\` (Card / Box / Container) take a t-shirt size: \`none | xs | sm | md | lg | xl | 2xl\`. Each resolves to a \`--ggui-spacing-*\` token (xs≈4px, sm≈8px, md≈16px, lg≈24px, xl≈32px, 2xl≈48px). A bare number is treated as pixels. NEVER pass a raw CSS length such as \`gap="8px"\` — it is silently dropped by the browser and the gap collapses to 0; use the scale name (\`gap="sm"\`).
- \`<Grid columns={N} gap="md">\` — 2-D layout (rows AND columns). Reach for it for card galleries, stat grids and dashboards — NEVER hand-roll \`style={{ display: 'grid' }}\`. When the request names exact per-breakpoint counts ("3 per row on desktop, 1 on mobile"), pass a map: \`<Grid columns={{ base: 1, md: 3 }}>\` (breakpoints \`sm\`/\`md\`/\`lg\`/\`xl\`; the design system emits the media queries). For an open-ended gallery where any column count is fine, use \`<Grid minColumnWidth={220}>\` — it fits as many equal columns as the width allows. \`radius\` (Card / Box / Image) takes the scale \`none | sm | md | lg | xl\`.
- \`<Stat label="…" value="…" delta="+12%" trend="up">\` — KPI display (label + big value + trend-coloured delta + optional \`icon\`). \`trend\` is \`up | down | neutral\` (delta renders green / red / muted). Reach for it for any "show a number" UI; drop several into a \`<Grid>\` for a stat grid instead of hand-building label+value pairs.
- \`<Stepper steps={STEPS} current={step} />\` — display-only step indicator for wizards/checkouts. \`steps\` is a top-level \`const\` array of labels; \`current\` is YOUR zero-indexed \`useState\` value; \`orientation\` is \`horizontal | vertical\`; optional \`onStepClick={(i) => …}\` makes steps clickable. Stepper never owns navigation state — your Next/Back handlers move \`current\`.
- \`<Badge variant="...">\` — \`default | primary | secondary | success | warning | error | info\` for colored pills. Great for status/condition labels. There is NO \`neutral\` variant — use \`default\` (or \`secondary\`) for an un-tinted pill.

**Color choice rule of thumb.** Reach for typed slots first: Button \`variant\`, Badge \`variant\`, Alert \`variant\`, Text/Heading/Icon/Spinner/Link/Divider \`tone\`, Box/Card \`surface\`. NEVER hardcode hex \`#XXXXXX\`, rgba, or hsl — tier-0 self-check rejects them with \`tokens:hex-color\` / \`tokens:hardcoded-color-fn\` and the LLM must remediate. Hardcoded colors break the operator's theme switch (Indigo → Claudic → Cyberpunk preset has zero effect on a card hardcoded with \`background: '#000'\`).

**Asset-color escape (Box only).** When you genuinely need a non-theme color — a partner's exact brand hex (Stripe purple \`#635BFF\`, Slack aubergine \`#4A154B\`), a fixed product surface — use \`<Box assetColor="#635BFF" assetSemantic="stripe-brand-purple">…</Box>\`. The \`assetSemantic\` is REQUIRED and MUST be a non-empty human-readable label that documents intent. Tier-0 allows hex inside this typed pair; one without the other fails the check. Reach for \`surface\` first — \`assetColor\` is rare.

## Accessibility (REQUIRED)

The design-system primitives are accessible by construction — they emit their own roles, labels, keyboard handlers, and error wiring. Your job is to USE them correctly, NOT to re-declare ARIA on top of them.

1. **Form inputs** — give every \`Input\` / \`TextArea\` / \`Select\` a \`label\` prop. The primitive renders its own \`<label htmlFor>\`, and exposes \`aria-invalid\` + \`aria-describedby\` for errors. Do NOT add a separate \`<Text>\` label or your own \`htmlFor\` — that double-labels the field.
   \`\`\`tsx
   <Input label="Email" value={email} onChange={setEmail} type="email" />
   \`\`\`
2. **Don't re-declare built-in ARIA.** \`Progress\`, \`RadioGroup\`, \`Tabs\`, \`Toggle\`, \`Slider\`, \`Spinner\`, \`Alert\`, \`Accordion\` already carry the correct \`role\` / \`aria-*\`. \`Card as={Clickable}\` already adds \`role="button"\` + keyboard activation. Adding your own is redundant and often wrong.
3. **Icons are decorative by default** — \`<Icon name="check" />\` is hidden from screen readers, which is correct for an icon sitting next to text. Add \`aria-label\` ONLY for a standalone, meaning-bearing icon with no adjacent text. Icon-only \`Button\`s still need \`aria-label\` on the **Button** itself.
4. **Live & streaming data** — wrap any region whose content updates on its own (a \`useStream\` \`.latest\` value, a live clock, an "N new" counter, a flashing price) in an element with \`aria-live="polite"\` so screen readers announce the change.
5. **Headings nest** — one \`<Heading level={1}>\` per screen, \`level={2}\` for sections, \`level={3}\` for subsections. Never skip or invert levels.
6. **Buttons** — descriptive text content; icon-only buttons need \`aria-label\`. Announce busy state: \`<Button disabled={isLoading} aria-busy={isLoading}>{isLoading ? 'Submitting…' : 'Submit'}</Button>\`.
7. **Stateful controls announce their state.** Toggleable / selectable / expandable things use the primitive that carries the semantics (\`Checkbox\`, \`Toggle\`, \`Tabs\`, \`Accordion\`) — never a styled \`Box\`/\`Icon\` that only *looks* checked. When you hand-roll one with \`as={Clickable}\`, \`Clickable\` adds button + keyboard semantics but NOT state — add it yourself: \`role="checkbox"\` + \`aria-checked={done}\` on a toggleable row, \`aria-pressed\` on a toggle button, \`aria-selected\` on the chosen item, \`aria-expanded\` on an open/close affordance. Styling (strikethrough, color, a check icon) must never be the only carrier of state.

## Design System Usage (CRITICAL)

EVERY color, spacing, typography, shadow, and radius value MUST come from design-system CSS variables. The runtime injects them on \`:root\`.

MANDATORY:
1. NEVER use hardcoded hex colors like \`#7c3aed\` — ONLY \`var(--ggui-color-*)\` tokens.
2. NEVER use CSS gradients with custom colors. If you need a gradient: \`linear-gradient(to bottom, var(--ggui-color-primary-500), var(--ggui-color-primary-700))\`.
3. NEVER invent your own palette. The system provides primary, neutral, success, warning, error, and info — use ONLY these.
4. NEVER include literal fallback values in ANY token reference — colors, spacing, typography, radius, shadows alike. Write \`var(--ggui-spacing-4)\` bare, never \`var(--ggui-spacing-4, 16px)\`; \`var(--ggui-color-primary-600)\` bare, never \`var(--ggui-color-primary-600, #0284c7)\`. The runtime injects every token; a literal fallback paints the wrong value exactly when the operator's theme matters most.

Token categories:
- Brand: \`var(--ggui-color-primary-600)\`, \`var(--ggui-color-primary-50)\`
- Text: \`var(--ggui-color-onSurface)\`, \`var(--ggui-color-onSurfaceVariant)\`
- Backgrounds: \`var(--ggui-color-surface)\`, \`var(--ggui-color-surfaceVariant)\`
- Borders: \`var(--ggui-color-outline)\`
- Spacing: \`var(--ggui-spacing-4)\`, \`var(--ggui-spacing-6)\`
- Typography: \`var(--ggui-font-size-sm)\`, \`var(--ggui-font-weight-semibold)\`
- Shadows: \`var(--ggui-shape-shadow-sm)\`, \`var(--ggui-shape-shadow-md)\`, \`var(--ggui-shape-shadow-lg)\`
- Radius: \`var(--ggui-shape-radius-md)\`, \`var(--ggui-shape-radius-lg)\`

Prefer primitives' built-in styling props over inline styles when possible.

### Branded Color Strategy

Use the FULL primary palette throughout the component — NOT only on submit buttons. A well-themed component feels distinctly branded, not gray-with-one-colored-button.

| Element | Token | Purpose |
|---------|-------|---------|
| Section headers, hero areas, highlight strips | \`primary-50\` / \`primary-100\` | Subtle branded backgrounds |
| Borders, dividers, focus rings, input focus | \`primary-200\` / \`primary-300\` | Branded structure |
| Icons, links, labels, active indicators | \`primary-500\` / \`primary-600\` | Core accent color |
| Buttons, CTAs, filled interactive elements | \`primary-600\` / \`primary-700\` | Primary actions |
| Headings on light primary backgrounds | \`primary-800\` / \`primary-900\` | High-contrast branded text |

Use semantic tokens (\`onSurface\`, \`onSurfaceVariant\`) for body text and secondary info. NEVER use raw \`neutral-*\` or \`gray-*\` for body text — they break in dark themes.

### Theme-Agnostic Design

Components MUST be theme-agnostic — they reference CSS variables but NEVER assume a specific style. The theme decides what \`primary-600\` looks like.

DO:
- Use \`var(--ggui-color-primary-*)\` for brand elements — the theme controls what "primary" means
- Use \`var(--ggui-shape-shadow-*)\` for depth, \`var(--ggui-shape-radius-*)\` for corners
- Use semantic color roles: primary for brand, surface/onSurface for structure, success/error/warning for state

DON'T:
- Don't assume primary is blue — could be red, green, purple
- Don't hardcode gradients tuned for a specific theme
- Don't use fixed shadow values

Visual hierarchy via tokens:
- Elevated sections: \`var(--ggui-shape-shadow-md)\` + \`var(--ggui-shape-radius-lg)\`
- Highlighted regions: \`var(--ggui-color-primary-50)\` background
- Active/selected: \`var(--ggui-color-primary-100)\` background
- Section headers: \`var(--ggui-color-primary-600)\` text or border-bottom

## Responsive Design (CRITICAL)

Generated components become reusable blueprints — the same blueprint serves phones, tablets, desktops, spatial headsets. Design for ALL screen sizes:

1. Design tokens for ALL spacing — never hardcode pixel values for padding/margins/gaps. Use the named spacing scale on props (\`gap="md"\`, \`padding="lg"\`); for inline \`style\` use \`var(--ggui-spacing-*, …)\`.
2. Relative/fluid units — prefer \`%\`, \`em\`, \`rem\`, \`min()\`, \`max()\`, \`clamp()\` over fixed \`px\`.
3. Fluid widths — \`max-width\` with \`width: 100%\`. Never set a fixed width.
4. Compact padding — components are embedded in containers that provide their own chrome.
5. No raw \`@media\` queries in component code — for a layout that must change by breakpoint, use \`<Grid columns={{ base: 1, md: 3 }}>\` (the design system emits the media queries for you) or a fluid \`minColumnWidth\` grid.`;

const DESIGN_SYSTEM_GUIDANCE_AESTHETICS_AND_CHECKLIST = `## Aesthetic Guidance (READ CAREFULLY — this is what separates "polished" from "ok")

### Visual hierarchy — the SCALE GAP rule

A polished UI has ONE hero that dominates. Everything else supports it. Bad layouts have everything at similar sizes — the eye has nowhere to land. The rule:

**Hero metric vs supporting text must have a 2–3× size gap.** If the hero is the temperature, score, count, status, price — it's ENORMOUS. Use \`<Text size="4xl" weight="bold">\` — the largest \`size\` the type allows (\`4xl\` = 36px). Pair it with a small supporting label (\`size="sm"\`, ~14px) so the gap reads as 2–3×. The hero number should feel oversized compared to the location/title around it. \`size\` accepts ONLY \`xs | sm | base | lg | xl | 2xl | 3xl | 4xl\` — \`5xl\` / \`6xl\` are NOT valid and fail tier-0 type-check.

\`\`\`tsx
// BAD — temperature is the same size as the location heading
<Heading level={1}>Seoul, South Korea</Heading>
<Text size="lg" weight="bold">18°C</Text>

// GOOD — temperature dominates (4xl), location supports it (sm)
<Text size="sm" tone="muted">Seoul, South Korea</Text>
<Text size="4xl" weight="bold">18°C</Text>
<Text size="lg" tone="muted">Partly Cloudy · Feels like 16°C</Text>
\`\`\`

### Color discipline — the 60/30/10 rule

Don't paint everything in primary. Use:
- **60% surface** (\`var(--ggui-color-surface)\` / \`onSurface\`) — body text, default backgrounds, structure
- **30% surfaceVariant + onSurfaceVariant** — secondary text, captions, labels, dividers
- **10% primary** — hero number, ONE highlight element, CTAs, brand accent

If your component is 100% purple text on purple backgrounds, you've lost the eye. Headings can be \`onSurface\` (dark neutral) — they'll still feel weighty. Save the primary palette for one or two STAR moments.

\`\`\`tsx
// BAD — everything purple, eye has no anchor
<Heading tone="emphasized">Title</Heading>
<Text tone="emphasized">42</Text>
<Text tone="emphasized">all body text</Text>

// GOOD — hero pops, body is neutral, primary is reserved
<Heading>Title</Heading>  {/* defaults to onSurface */}
<Text size="4xl" weight="bold" tone="emphasized">42</Text>
<Text tone="muted">all body text</Text>
\`\`\`

### Visual rhythm — vary your card treatments

A row of identical flat tiles feels monotone. Use card-treatment variation to create rhythm:
- **Hero card**: \`<Card padding="xl" shadow="lg" radius="xl">\` with branded gradient background — anchors the eye
- **Stat tiles**: \`<Card padding="md" shadow="sm" radius="md">\` with surface bg — secondary
- **Inline rows / list items**: no card chrome at all, just \`<Stack gap="sm">\` with dividers — tertiary

The hero should literally have higher elevation than the supporting tiles. If everything has \`shadow="md"\`, nothing does.

### Iconography — emoji + Icon are visual weight on the cheap

Don't render text-only metrics. A weather widget without a sun/cloud, a stock card without an arrow, a status panel without a colored dot — all feel undersold. Pair every hero metric with an icon or emoji at large size:

\`\`\`tsx
<Row gap="md" align="center">
  <Text size="3xl">☀️</Text>
  <Stack gap="xs">
    <Text size="4xl" weight="bold">18°C</Text>
    <Text size="sm" tone="muted">Sunny · feels like 16°</Text>
  </Stack>
</Row>
\`\`\`

Use \`<Icon name="..." />\` (Lucide icon names in kebab-case) for line icons; emoji directly for status/weather/mood. Both are valid. For per-stat tiny accents, use a small icon next to the label.

### Spacing — generosity beats compactness

Hero sections should feel airy. Use \`padding="xl"\` (32px) on the main card, not \`padding="md"\`. Whitespace IS design. A cramped polished card looks worse than a roomy plain one.

### Concrete recipes

- **Hero metric card** (weather, stock, score): hero number at \`size="4xl"\` (the max), icon/emoji at \`size="3xl"\` next to it (use \`<Row gap="md">\`), supporting label at \`size="sm"\` muted, branded gradient bg, \`shadow="lg"\`, \`padding="xl"\`.
- **Stat grid** (3–6 quick metrics): \`<Grid columns={3} gap="md">\` of \`<Stat>\` — each \`<Stat label="…" value="…" delta="…" trend="…" />\` handles the label-on-top / value-below / trend-coloured-delta layout for you. Wrap each in a \`<Card padding="md" shadow="sm">\` if you want tile chrome.
- **List item** (forecast day, todo, message): no card per item, use \`<Stack gap="md">\` with each row as \`<Row gap="md">\` of icon + content + meta. Add \`<Divider>\` between rows.
- **Multi-step wizard** (survey, onboarding, checkout): \`<Stepper steps={STEPS} current={step} />\` at the top, the current step's fields below, Next/Back buttons that move \`step\`. Don't hand-roll a "2 of 4" indicator.
- **Key-value rows** (specs, order summary, flight details): \`<Stack gap="sm">\` of \`<Row justify="between">\` — label as \`<Text size="sm" tone="muted">\`, value as \`<Text size="sm" weight="medium">\`.
- **Section header**: \`<Heading level={2}>\` left-aligned, optional \`<Badge>\` to its right for count/status, optional muted caption below.
- **CTA section**: ONE primary button. Other actions as ghost/outline. Don't stack three primary buttons.

## Quality Checklist (verify before returning)

- [ ] Imports ONLY from: react, @ggui-ai/design, @ggui-ai/wire
- [ ] No raw HTML elements (\`<button>\`, \`<input>\`, \`<div>\` for layout) — uses primitives
- [ ] ZERO hardcoded hex colors — every color is a bare \`var(--ggui-color-*)\`, no literal fallback
- [ ] No raw pixel values for spacing — all via \`var(--ggui-spacing-*)\` tokens
- [ ] Primary palette used throughout (headers, borders, icons) — not just buttons
- [ ] Typed Props interface exported; request-specific data is a prop with default
- [ ] Every Input/TextArea/Select has a \`label\` prop (no separate \`<Text>\` label)
- [ ] Icon-only buttons have \`aria-label\`; no redundant \`role\`/\`aria-*\` on primitives
- [ ] Toggleable/selected/expanded state is ARIA-expressed (\`aria-checked\`/\`aria-pressed\`/\`aria-selected\`/\`aria-expanded\`) — never style-only
- [ ] Live/streaming regions wrapped in \`aria-live="polite"\`
- [ ] Headings nest — one \`level={1}\`, then \`level={2}\`/\`{3}\` — never skipped or inverted
- [ ] Wire hooks (\`useAction\`, \`useStream\`) imported from \`@ggui-ai/wire\` and consumed`;

export const DESIGN_SYSTEM_GUIDANCE = [
  DESIGN_SYSTEM_GUIDANCE_SURFACE_AND_TOKENS,
  DATA_PARAMETERIZATION,
  COMPONENT_STRUCTURE,
  DESIGN_SYSTEM_GUIDANCE_AESTHETICS_AND_CHECKLIST,
].join("\n\n");
