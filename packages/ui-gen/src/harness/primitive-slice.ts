// Axis-keyed primitives doc slice.
//
// `PRIMITIVES_DOCUMENTATION` injected into the first-turn system prompt
// is ~133 KB (~30K tokens) of markdown per-primitive documentation. A
// typical medium/high-risk UI uses 5–10 primitives out of ~40 defined.
// This module computes a per-classification allowlist and slices the
// monolith down to only the primitives likely to be used, typically
// 30–50 KB.
//
// Design decisions:
//   - Union of axis-specific primitive sets + an always-on core.
//     Every fixture gets Layout/Typography primitives unconditionally.
//   - Surface awareness stays intact — the name-only catalog in
//     `buildSystemPrompt` already lists EVERY primitive, so the LLM
//     knows the wider surface exists even when the per-primitive doc
//     is sliced out. ("If you need X, ask for it" — but the hit rate
//     on needing sliced-out primitives should be low by construction.)
//   - Flag-gated behind `ContextPolicy.primitiveDocSlice` (default
//     `"full"`). Byte-identical to pre-#45 behavior when flag is off.
//
// This is the first fresh family after the dupe-break retirement
// (#41–#44). Unlike dupe-break interventions, slicing operates at
// prompt-build time and modifies the LLM's *initial* conditioning
// uniformly — it cannot contaminate a retry trajectory mid-run.

import type { Classification } from "../classifier/index.js";

/** Primitives every fixture needs — layout + typography + core interaction.
 *
 *  `Badge` is in core because the system-prompt "Common Pitfalls" section
 *  (runtime.ts) unconditionally documents its prop API ("Badge variant
 *  accepts ..."). The LLM may reach for it on any fixture. */
const CORE_PRIMITIVES: readonly string[] = [
  "Container",
  "Stack",
  "Row",
  "Box",
  "Card",
  "Divider",
  "Spacer",
  "Text",
  "Heading",
  "Button",
  "Icon",
  "Badge",
];

/**
 * Known primitive / component / composition section names — the set of
 * `### X` headers in `PRIMITIVES_DOCUMENTATION` that represent SLICEABLE
 * primitive docs (as opposed to cross-cutting GUIDANCE sections like
 * `### onChange Behavior (CRITICAL)` or `### Import Constraints`).
 *
 * The slicer filters ONLY on this set. Any `### X` header whose first
 * word is NOT in this set is treated as "guidance" — always kept — so
 * critical cross-cutting sections stay in the sliced doc regardless of
 * the allowlist.
 *
 * Derived from the live primitive documentation structure. Keep in
 * sync with the primitive docs in `tools/` when new primitives are
 * added.
 */
const KNOWN_PRIMITIVE_SECTIONS = new Set<string>([
  // Layout
  "Container", "Card", "Stack", "Box", "Divider", "Spacer",
  // Typography
  "Text", "Heading",
  // Inputs
  "Button", "Input", "TextArea", "Select", "Checkbox", "Toggle", "RadioGroup", "Slider",
  // Display
  "Badge", "Spinner", "Avatar", "Alert", "Progress", "Image", "Icon", "Link", "Tooltip",
  // Data
  "Table", "Tabs", "Toast", "Accordion",
  // Components
  "SearchField", "FormField", "MenuItem", "Tag", "Dropdown", "Autocomplete", "Breadcrumb", "Pagination",
  // Compositions
  "Header", "Sidebar", "CardGrid", "CommentThread", "DataTable", "ChatWindow", "NavigationBar",
  "FileUploader", "UserProfileCard", "NotificationCenter", "Modal", "CommandPalette",
  "Footer", "IncidentTimeline", "Hero",
]);

/** Axis-value → primitive additions. Union'd with CORE_PRIMITIVES. */
const AXIS_PRIMITIVES: Readonly<Record<string, readonly string[]>> = {
  // render ────────────────────────────────────────────────────────
  "render:list":          ["Badge", "Avatar", "Spinner", "Link"],
  "render:grid":          ["CardGrid", "Badge", "Image"],
  "render:timeline":      ["Badge", "Avatar", "Spinner", "Link"],
  "render:master-detail": ["Sidebar", "SearchField", "Badge"],
  "render:spatial":       ["Image"],
  "render:chart":         ["Progress", "Badge"],
  "render:static":        [],
  // state ─────────────────────────────────────────────────────────
  "state:payload":        ["Input", "TextArea", "Select", "Checkbox", "Toggle", "RadioGroup", "Slider", "FormField", "Alert"],
  "state:draft":          ["Input", "TextArea", "FormField", "Alert"],
  "state:ui-affordance":  ["Input", "Toggle", "Tabs", "SearchField"],
  "state:merge":          ["Spinner", "Badge", "Alert"],
  "state:none":           [],
  // writes ────────────────────────────────────────────────────────
  "writes:submit":        ["Input", "TextArea", "Select", "Checkbox", "Toggle", "RadioGroup", "Slider", "FormField", "Alert"],
  "writes:commit":        ["Alert"],
  "writes:multi-commit":  ["Dropdown", "MenuItem", "Alert", "Tag"],
  "writes:per-item":      ["Toggle", "Dropdown", "MenuItem"],
  "writes:compose":       ["Autocomplete", "Dropdown", "Input", "Tag"],
  "writes:none":          [],
  // writeTrigger ──────────────────────────────────────────────────
  "writeTrigger:drag":    [],
  "writeTrigger:swipe":   [],
  "writeTrigger:keystroke": [],
  "writeTrigger:auto":    [],
  "writeTrigger:click":   [],
  // realtime ──────────────────────────────────────────────────────
  "realtime:merge":       ["Spinner", "Badge", "Alert"],
  "realtime:append":      ["Spinner", "Badge"],
  "realtime:status":      ["Badge", "Alert"],
  "realtime:presence":    ["Avatar", "Badge"],
  "realtime:mixed":       ["Spinner", "Badge", "Avatar", "Alert"],
  "realtime:none":        [],
  // fetch ─────────────────────────────────────────────────────────
  "fetch:pagination":     ["Pagination", "Spinner"],
  "fetch:search":         ["SearchField", "Autocomplete", "Spinner"],
  "fetch:drill-down":     ["Spinner", "Breadcrumb"],
  "fetch:refresh":        ["Spinner"],
  "fetch:none":           [],
  // layout ────────────────────────────────────────────────────────
  "layout:multi-step":    ["Tabs", "Progress", "Breadcrumb"],
  "layout:master-detail": ["Sidebar"],
  "layout:overlay":       ["Modal", "Tooltip"],
  "layout:modal":         ["Modal"],
  "layout:single":        [],
  // tooling ───────────────────────────────────────────────────────
  "tooling:wired":        ["Alert"],
  "tooling:client":       ["Alert"],
  "tooling:both":         ["Alert"],
  "tooling:none":         [],
};

/**
 * Compute the primitive allowlist for a given classification.
 *
 * Union of CORE_PRIMITIVES + per-axis additions from AXIS_PRIMITIVES.
 * Returns a sorted array so output is deterministic for snapshot tests.
 */
export function computePrimitiveAllowlist(
  classification: Classification,
): readonly string[] {
  const set = new Set<string>(CORE_PRIMITIVES);
  const v = classification.vector;
  for (const [axis, value] of [
    ["render", v.render],
    ["state", v.state],
    ["writes", v.writes],
    ["writeTrigger", v.writeTrigger],
    ["realtime", v.realtime],
    ["fetch", v.fetch],
    ["layout", v.layout],
    ["tooling", v.tooling],
  ] as const) {
    const additions = AXIS_PRIMITIVES[`${axis}:${value}`] ?? [];
    for (const p of additions) set.add(p);
  }
  return [...set].sort();
}

/**
 * Slice `PRIMITIVES_DOCUMENTATION` to include only the allowlisted primitive
 * sections. The doc structure is:
 *
 *   <preamble / intro>
 *   ## Primitives
 *   Import: ...
 *
 *   ### Container
 *   <Container docs>
 *
 *   ### Stack
 *   <Stack docs>
 *   ...
 *
 * Keep the preamble through `## Primitives` + intro verbatim. Walk the
 * remaining `### <Name>` sections and keep only those whose name is in
 * the allowlist. Concat the result.
 *
 * Falls back to the full doc if the expected structure isn't found
 * (defensive — format changes shouldn't silently drop everything).
 */
export function slicePrimitiveDocumentation(
  fullDoc: string,
  allowlist: readonly string[],
): string {
  const allow = new Set(allowlist);
  // Find the first `### <Name>` header — everything before it is preamble.
  const firstSection = fullDoc.search(/^### \S/m);
  if (firstSection === -1) return fullDoc;
  const preamble = fullDoc.slice(0, firstSection);

  // Split remainder by `### ` headers and filter.
  const remainder = fullDoc.slice(firstSection);
  const sectionRegex = /^### (\S+)/gm;
  const matches: Array<{ name: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRegex.exec(remainder)) !== null) {
    matches.push({ name: m[1]!, start: m.index });
  }
  if (matches.length === 0) return fullDoc;

  // Section-keep rule:
  //   - If the header's first word is a KNOWN primitive, keep iff in allowlist.
  //   - Otherwise, it's a GUIDANCE section (`### onChange Behavior (CRITICAL)`,
  //     `### Import Constraints`, `### Elevation System`, `### Support Types`)
  //     — ALWAYS keep. Guidance sections contain cross-cutting rules the LLM
  //     needs regardless of the primitive allowlist (e.g. "do NOT add new
  //     imports" lives in `### Import Constraints`).
  const kept: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const { name, start } = matches[i]!;
    const end = i + 1 < matches.length ? matches[i + 1]!.start : remainder.length;
    const isKnownPrimitive = KNOWN_PRIMITIVE_SECTIONS.has(name);
    const keep = isKnownPrimitive ? allow.has(name) : true;
    if (keep) kept.push(remainder.slice(start, end));
  }

  return preamble + kept.join("");
}
