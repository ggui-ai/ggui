// Pin (ggui#1046): `grid.board_columns_side_by_side` names a board whose
// columns map is composed under anything but <Grid> / <Row>. RED fixture —
// three of four constrained kanban mints on the candidate-15 image
// (2026-09-12): the columns as a <Stack> of sections, no <Grid>, 1 turn, judged
// below the bar; the fourth wrapped the map in
// `<Grid columns={{ base: 1, sm: 2, md: Math.min(columns.length, 4) }}>`.
import { describe, expect, it } from "vitest";
import { classifyAxes } from "../../../classifier/index.js";
import type { AxisCheckInput } from "../types.js";
import { GRID_CHECKS, boardPropNames, enclosingLayoutTag, findStackedBoardColumns } from "./grid.js";

const check = GRID_CHECKS.find((c) => c.id === "grid.board_columns_side_by_side")!;

const BOARD_CONTRACT = {
  propsSpec: { properties: { columns: { type: "array", required: true, items: { type: "object", properties: { id: {}, title: {}, cards: {} } } } } },
} as unknown as AxisCheckInput["contract"];

function input(sourceCode: string, extra: Partial<AxisCheckInput> = {}): AxisCheckInput {
  const prompt = extra.originalPrompt ?? "a kanban board for this week";
  return {
    sourceCode,
    compiledCode: "compiled",
    originalPrompt: prompt,
    contract: extra.contract ?? BOARD_CONTRACT,
    classification: classifyAxes({ contract: {}, prompt }),
    ...extra,
  };
}

/** b/att2's shape: the outer <Stack>, a header <Card>, a ternary with a self-closing <EmptyState/>, then the map. */
const RED_STACKED = `
export default function Component(props: Props) {
  const columns = props.columns ?? [];
  const targetOptions = columns.map((c) => ({ value: c.id, label: c.title }));
  return (
    <Stack gap="md">
      <Card padding="md"><Row justify="between"><Heading level={2}>Board</Heading><Button onClick={() => setOpen(true)}>Add</Button></Row></Card>
      {columns.length === 0 ? (
        <EmptyState title="No columns yet" description="The board has no columns to display." />
      ) : (
        columns.map((column, idx) => (
          <Stack key={column.id} gap="sm">
            <Row justify="between"><Text weight="semibold">{column.title}</Text><Badge>{column.cards.length}</Badge></Row>
            {column.cards.map((card) => <Card key={card.id} padding="sm">{card.title}</Card>)}
            {idx < columns.length - 1 && <Divider />}
          </Stack>
        ))
      )}
    </Stack>
  );
}`;

/** a/att1's shape: the same ternary, but the map sits inside a responsive <Grid>. */
const GREEN_GRID = RED_STACKED.replace(
  "        columns.map((column, idx) => (",
  '        <Grid columns={{ base: 1, sm: 2, md: Math.min(columns.length, 4) }} gap="md">{columns.map((column, idx) => (',
).replace("        ))\n      )}", "        ))}</Grid>\n      )}");

const GREEN_ROW = `
export default function Component(props: Props) {
  const { lanes } = props;
  return (
    <Stack gap="md">
      <Row align="start" gap="md">
        {lanes.map((lane) => (<Stack key={lane.id}><Text>{lane.title}</Text></Stack>))}
      </Row>
    </Stack>
  );
}`;

const TILE_GALLERY = `
export default function Component(props: Props) {
  return (<Grid columns={3} gap="md">{props.items.map((item) => <Card key={item.id}>{item.name}</Card>)}</Grid>);
}`;

describe("grid.board_columns_side_by_side", () => {
  it("is registered on render=grid only", () => {
    expect(check.values).toEqual(["grid"]);
  });

  it("reads the board prop from the contract and the enclosing layout tag from the source", () => {
    expect(boardPropNames(BOARD_CONTRACT)).toEqual(["columns"]);
    const pos = RED_STACKED.indexOf("columns.map((column, idx)");
    expect(enclosingLayoutTag(RED_STACKED, pos)).toBe("Stack");
    const gpos = GREEN_GRID.indexOf("{columns.map((column, idx)");
    expect(enclosingLayoutTag(GREEN_GRID, gpos)).toBe("Grid");
  });

  it("fails the stacked board (the run18 shape) with the Grid wrap as the fix; the non-JSX map is not counted", () => {
    expect(findStackedBoardColumns(input(RED_STACKED))).toEqual([["columns", "Stack"]]);
    const issues = check.run(input(RED_STACKED));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.subcategory).toBe("grid.board_columns_side_by_side");
    expect(issues[0]!.result).toBe("fail");
    expect(issues[0]!.tier).toBe(0);
    expect(issues[0]!.fix).toContain("<Grid columns={{ base: 1, md: columns.length }}");
  });

  it("stays silent on a <Grid>-wrapped board, a <Row>-wrapped board (contract-less, prompt names the board) and a tile gallery", () => {
    expect(check.run(input(GREEN_GRID))).toEqual([]);
    expect(check.run(input(GREEN_ROW, { contract: undefined, originalPrompt: "a kanban board with lanes" }))).toEqual([]);
    expect(check.run(input(TILE_GALLERY, { contract: undefined, originalPrompt: "a grid of product cards" }))).toEqual([]);
  });

  it("stands down in free design mode and on a source that did not compile", () => {
    expect(check.run(input(RED_STACKED, { designMode: "free" }))).toEqual([]);
    expect(check.run({ ...input(RED_STACKED), compiledCode: null })).toEqual([]);
  });
});
