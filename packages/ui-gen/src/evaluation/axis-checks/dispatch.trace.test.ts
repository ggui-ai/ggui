// Pin (ggui#1046): under GGUI_AXIS_CHECK_TRACE=1 the dispatcher prints ONE JSON line per
// round with the facts a verdict was built from, and the board check prints its own line
// beside it (PASS and stand-down included); off by default, no line at all.
import type { DataContract } from "@ggui-ai/protocol";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { classifyAxes } from "../../classifier/index.js";
import type { BoardColumnsTrace } from "./checks/grid.js";
import { runAxisChecks, type AxisCheckTrace } from "./dispatch.js";

const SRC = `
export default function Component(props: Props) {
  const columns = props.columns ?? [];
  return (<Stack gap="lg">{columns.map((col) => (<Stack key={col.id}><Text>{col.title}</Text></Stack>))}</Stack>);
}`;
const PROMPT = "a kanban board";
const CONTRACT: DataContract = { propsSpec: { properties: { columns: { schema: { type: "array" }, required: true } } } };

interface TraceLine {
  axisCheckTrace?: AxisCheckTrace;
  boardColumnsTrace?: BoardColumnsTrace;
}

function traceLines(spy: MockInstance<typeof console.log>): TraceLine[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("{\"axisCheckTrace\"") || l.startsWith("{\"boardColumnsTrace\""))
    .map((l) => JSON.parse(l) as TraceLine);
}

describe("axis-check trace (ggui#1046)", () => {
  const saved = process.env["GGUI_AXIS_CHECK_TRACE"];
  let spy: MockInstance<typeof console.log>;
  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    spy.mockRestore();
    if (saved === undefined) delete process.env["GGUI_AXIS_CHECK_TRACE"];
    else process.env["GGUI_AXIS_CHECK_TRACE"] = saved;
  });

  it("off by default: neither the dispatcher nor the board check prints a line", () => {
    delete process.env["GGUI_AXIS_CHECK_TRACE"];
    const issues = runAxisChecks(classifyAxes({ contract: {}, prompt: PROMPT }), { sourceCode: SRC, compiledCode: "x", originalPrompt: PROMPT, contract: CONTRACT });
    expect(issues.some((i) => i.subcategory === "grid.board_columns_side_by_side")).toBe(true);
    expect(traceLines(spy)).toEqual([]);
  });

  it("on: the dispatcher's line carries the source digest, prompt, design mode, classification, contract prop keys, matched gates and issues; the board check's line sits beside it", () => {
    process.env["GGUI_AXIS_CHECK_TRACE"] = "1";
    const classification = classifyAxes({ contract: {}, prompt: PROMPT });
    runAxisChecks(classification, { sourceCode: SRC, compiledCode: "x", originalPrompt: PROMPT, contract: CONTRACT });
    const lines = traceLines(spy);
    const dispatcher = lines.find((l) => l.axisCheckTrace !== undefined)?.axisCheckTrace;
    const board = lines.find((l) => l.boardColumnsTrace !== undefined)?.boardColumnsTrace;
    expect(lines.filter((l) => l.axisCheckTrace !== undefined)).toHaveLength(1);
    expect(dispatcher).toBeDefined();
    expect(dispatcher?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dispatcher).toMatchObject({ originalPrompt: PROMPT, designMode: "constrained", propsSpecKeys: ["properties"], propsSpecPropertyKeys: ["columns"] });
    expect(dispatcher?.classification).toMatchObject({ render: "grid" });
    expect(dispatcher?.matched).toContain("grid.board_columns_side_by_side");
    expect(dispatcher?.issues).toContainEqual({ id: "grid.board_columns_side_by_side", result: "fail" });
    expect(board).toMatchObject({ declared: ["columns"], names: ["columns"], designMode: "constrained", standDown: false, result: "fail" });
    expect(board?.perName).toEqual([{ name: "columns", maps: 1, enclosing: ["Stack"] }]);
  });

  it("on, free mode: the board check's line says stand-down and no board issue is emitted; a null compile prints the dispatcher's note and runs nothing", () => {
    process.env["GGUI_AXIS_CHECK_TRACE"] = "1";
    const classification = classifyAxes({ contract: {}, prompt: PROMPT });
    const issues = runAxisChecks(classification, { sourceCode: SRC, compiledCode: "x", originalPrompt: PROMPT, contract: CONTRACT, designMode: "free" });
    expect(issues.some((i) => i.subcategory === "grid.board_columns_side_by_side")).toBe(false);
    expect(traceLines(spy).find((l) => l.boardColumnsTrace !== undefined)?.boardColumnsTrace).toMatchObject({ standDown: true, result: "stand-down", designMode: "free" });
    spy.mockClear();
    expect(runAxisChecks(classification, { sourceCode: SRC, compiledCode: null, originalPrompt: PROMPT, contract: CONTRACT })).toEqual([]);
    expect(traceLines(spy).find((l) => l.axisCheckTrace !== undefined)?.axisCheckTrace).toMatchObject({ matched: [], issues: [], note: "compiledCode null — no check ran" });
  });
});
