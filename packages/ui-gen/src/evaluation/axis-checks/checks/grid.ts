// packages/ui-gen/src/evaluation/axis-checks/checks/grid.ts
//
// Checks gated on `render=grid`.
//
// ── grid.board_columns_side_by_side (ggui#1046) ─────────────────────────
// A kanban classifies as `render=grid` (the classifier's GRID_RX carries
// `kanban`), and three of four constrained mints on the candidate-15 image
// composed the board's columns as a vertical <Stack> of sections — no <Grid>
// anywhere — then read below the judge's bar; the tier-2 evaluator saw the
// stacking only as a `warn`, which never costs a fix turn. This check reads
// the source the way the fix turn must: find the JSX map over the board's
// columns array and name the layout primitive that ENCLOSES it. <Grid> or
// <Row> = side by side; <Stack> / <Card> / <Box> / a bare block / nothing =
// stacked. Stands down in `free` design mode, where the primitive is optional.

import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import { mkIssue } from "../helpers.js";

/** Prop names a board's column array goes by. */
const BOARD_PROP_RX = /^(columns?|lanes?|stages?|lists?|buckets?|swimlanes?)$/i;
const BOARD_PROMPT_RX = /\b(kanban|board)\b/i;
/** Layout primitives whose nesting decides side-by-side vs stacked. */
const LAYOUT_TAG_RX = /<(\/?)(Grid|Row|Stack|Card|Box|Container|ScrollArea|div|section)\b([^<>]*?)>/g;
const SIDE_BY_SIDE = new Set(["Grid", "Row"]);

interface PropShapeLike {
  type?: string;
  schema?: { type?: string };
}

/** The board prop names the contract declares as arrays. */
export function boardPropNames(contract: AxisCheckInput["contract"]): string[] {
  const propsField = contract?.propsSpec as { properties?: Record<string, PropShapeLike> } | undefined;
  const properties = propsField?.properties ?? {};
  return Object.entries(properties)
    .filter(([name, p]) => BOARD_PROP_RX.test(name) && (p?.type === "array" || p?.schema?.type === "array"))
    .map(([name]) => name);
}

/**
 * Every JSX map over `name`, by index — an expression-body arrow (`name.map((col) => (<…`)
 * or a block-body one (`name.map((col) => { … return (<…`); the serving deployment's candidate-18 kanban
 * mints composed two of three stacked boards through the block form (ggui#1046), which the
 * first reader never matched.
 */
function jsxMapPositions(sourceCode: string, name: string): number[] {
  const rx = new RegExp(
    `\\b${name}(?:\\?\\.)?\\.map\\(\\s*\\(?\\s*\\w+(?:\\s*,\\s*\\w+)?\\s*\\)?\\s*=>\\s*(?:\\(?\\s*<|\\{[^{}]{0,600}?\\breturn\\s*\\(?\\s*<)`,
    "g",
  );
  return [...sourceCode.matchAll(rx)].map((m) => m.index ?? 0);
}

/** The layout primitive enclosing `pos`, walked as a tag stack over the source before it. */
export function enclosingLayoutTag(sourceCode: string, pos: number): string | undefined {
  const stack: string[] = [];
  for (const m of sourceCode.slice(0, pos).matchAll(LAYOUT_TAG_RX)) {
    const closing = m[1] === "/";
    const name = m[2] ?? "";
    const attrs = m[3] ?? "";
    if (closing) {
      if (stack[stack.length - 1] === name) stack.pop();
      continue;
    }
    if (attrs.trimEnd().endsWith("/")) continue; // self-closing
    stack.push(name);
  }
  return stack[stack.length - 1];
}

/** Board maps composed under something other than <Grid> / <Row>: `[propName, enclosing tag or "nothing"]`. */
export function findStackedBoardColumns(input: AxisCheckInput): Array<readonly [string, string]> {
  const declared = boardPropNames(input.contract);
  const names = declared.length > 0
    ? declared
    : BOARD_PROMPT_RX.test(input.originalPrompt)
      ? ["columns", "lanes", "stages", "lists", "buckets", "swimlanes"]
      : [];
  const stacked: Array<readonly [string, string]> = [];
  for (const name of names) {
    for (const pos of jsxMapPositions(input.sourceCode, name)) {
      const tag = enclosingLayoutTag(input.sourceCode, pos);
      if (tag === undefined || !SIDE_BY_SIDE.has(tag)) stacked.push([name, tag ?? "nothing"]);
    }
  }
  return stacked;
}

function runBoardColumnsSideBySide(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  if (input.designMode === "free") return [];
  const stacked = findStackedBoardColumns(input);
  if (stacked.length === 0) return [];
  const [name, tag] = stacked[0]!;
  return [
    mkIssue(
      "grid.board_columns_side_by_side",
      `The board's \`${name}\` are composed under <${tag}> — a vertical stack of column sections; at md and wider the columns must sit side by side.`,
      `Wrap the ${name} map in <Grid columns={{ base: 1, md: ${name}.length }} gap="md"> (each column its own <Stack> of cards); never a <Stack> of column sections.`,
    ),
  ];
}

export const GRID_CHECKS: readonly AxisCheck[] = [
  {
    id: "grid.board_columns_side_by_side",
    axis: "render",
    values: ["grid"],
    run: runBoardColumnsSideBySide,
  },
];
