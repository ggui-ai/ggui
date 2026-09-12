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
import { axisCheckTraceEnabled, mkIssue } from "../helpers.js";

/** Prop names a board's column array goes by. */
const BOARD_PROP_RX = /^(columns?|lanes?|stages?|lists?|buckets?|swimlanes?)$/i;
const BOARD_PROMPT_RX = /\b(kanban|board)\b/i;
/** The names a board's column array goes by, for the prompt and source paths. */
const BOARD_NAMES = ["columns", "lanes", "stages", "lists", "buckets", "swimlanes"] as const;
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

/** What the check read (ggui#1046): the board names it walked and, per name, every JSX map's enclosing layout tag. */
export interface BoardRead {
  readonly declared: readonly string[];
  readonly names: readonly string[];
  readonly perName: ReadonlyArray<{ readonly name: string; readonly maps: number; readonly enclosing: readonly string[] }>;
}

/** The board check's own trace line (ggui#1046). */
export interface BoardColumnsTrace extends BoardRead {
  readonly designMode: string;
  readonly standDown: boolean;
  readonly result: "pass" | "fail" | "stand-down";
}

export function describeBoardRead(input: AxisCheckInput): BoardRead {
  // Which array the board's columns are: the contract names it; else the prompt says
  // "board" / "kanban"; else the SOURCE itself does — a JSX map over a board-shaped name
  // (ggui#1046: on candidate 20 the check flagged every stacked source locally and none on
  // the serving deployment, where the contract and prompt reach it in another shape; the
  // source is the one input every path hands over verbatim).
  const declared = boardPropNames(input.contract);
  const names = declared.length > 0
    ? declared
    : BOARD_PROMPT_RX.test(input.originalPrompt)
      ? [...BOARD_NAMES]
      : BOARD_NAMES.filter((n) => jsxMapPositions(input.sourceCode, n).length > 0);
  const perName = names.map((name) => {
    const positions = jsxMapPositions(input.sourceCode, name);
    return { name, maps: positions.length, enclosing: positions.map((pos) => enclosingLayoutTag(input.sourceCode, pos) ?? "nothing") };
  });
  return { declared, names, perName };
}

/** Board maps composed under something other than <Grid> / <Row>: `[propName, enclosing tag or "nothing"]`. */
export function findStackedBoardColumns(input: AxisCheckInput): Array<readonly [string, string]> {
  const stacked: Array<readonly [string, string]> = [];
  for (const { name, enclosing } of describeBoardRead(input).perName) {
    for (const tag of enclosing) if (!SIDE_BY_SIDE.has(tag)) stacked.push([name, tag]);
  }
  return stacked;
}

function runBoardColumnsSideBySide(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const standDown = input.designMode === "free";
  const stacked = standDown ? [] : findStackedBoardColumns(input);
  if (axisCheckTraceEnabled()) {
    // The check's own line beside the dispatcher's (ggui#1046): what it read, PASS and stand-down included.
    const line: BoardColumnsTrace = {
      ...describeBoardRead(input),
      designMode: input.designMode ?? "constrained",
      standDown,
      result: standDown ? "stand-down" : stacked.length > 0 ? "fail" : "pass",
    };
    console.log(JSON.stringify({ boardColumnsTrace: line }));
  }
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
