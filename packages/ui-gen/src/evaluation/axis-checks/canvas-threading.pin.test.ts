/**
 * Pin (ggui#1117): `AxisCheckInput.canvas` is threaded from the harness onto every axis check, and
 * a check that gets no canvas sees `undefined` — never a default.
 *
 * Why: a width cap on the OUTERMOST element is the defect on a fullscreen canvas (the card becomes
 * a strip with the frame's ground beside it) and a NO-OP in a chat bubble (~400 px; a 480 px cap
 * never binds). A canvas-blind check has two shapes and both are bad — fire everywhere (people
 * learn to ignore the warn) or fire nowhere (the defect ships). The canvas was known where the
 * harness is assembled and not threaded onto the check input; now it is, on both paths:
 * `runCheck` (the served loop, over the harness's pre-filtered checks) and `runAxisChecks` (gate + run).
 *
 * Also pinned: an existing check's behaviour is byte-identical with and without the canvas — no
 * registry check reads it yet, and the field is optional, so the registry's verdicts cannot move.
 */
import type { DataContract } from "@ggui-ai/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAxes } from "../../classifier/index.js";
import { createHarness } from "../../create-harness.js";
import { runCheck } from "../../run-check.js";
import type { AxisCheck, AxisCheckInput } from "../types-public.js";
import { runAxisChecks, runGatedAxisChecks, type AxisCheckTrace } from "./dispatch.js";
import type { CanvasClass } from "../../design-mode.js";

afterEach(() => {
  delete process.env["GGUI_AXIS_CHECK_TRACE"];
  vi.restoreAllMocks();
});

const SRC = `
export default function Component(props: Props) {
  const columns = props.columns ?? [];
  return (<Stack gap="lg">{columns.map((col) => (<Stack key={col.id}><Text>{col.title}</Text></Stack>))}</Stack>);
}`;
const PROMPT = "a kanban board";
const CONTRACT: DataContract = { propsSpec: { properties: { columns: { schema: { type: "array" }, required: true } } } };

/** A check that records what it was handed and emits nothing. */
function probe(seen: Array<{ has: boolean; canvas: CanvasClass | undefined }>, render: string): AxisCheck {
  return {
    id: "probe.canvas_seen",
    axis: "render",
    values: [render],
    run(input: AxisCheckInput) {
      seen.push({ has: "canvas" in input, canvas: input.canvas });
      return [];
    },
  };
}

describe("AxisCheckInput.canvas is threaded, never defaulted (ggui#1117)", () => {
  it("the pre-gated runner hands a check exactly what it was given: a canvas when present, no key at all when absent", () => {
    const classification = classifyAxes({ contract: CONTRACT, prompt: PROMPT });
    const seen: Array<{ has: boolean; canvas: CanvasClass | undefined }> = [];
    const base: AxisCheckInput = { sourceCode: SRC, compiledCode: "x", contract: CONTRACT, originalPrompt: PROMPT, classification };
    runGatedAxisChecks([probe(seen, classification.vector.render)], base);
    runGatedAxisChecks([probe(seen, classification.vector.render)], { ...base, canvas: "lg" });
    runGatedAxisChecks([probe(seen, classification.vector.render)], { ...base, canvas: "xs-chat-card" });
    expect(seen).toEqual([
      { has: false, canvas: undefined },
      { has: true, canvas: "lg" },
      { has: true, canvas: "xs-chat-card" },
    ]);
  });

  it("SERVED PATH: runCheck threads the harness's canvas; a harness built without one hands the check no canvas", async () => {
    const classification = classifyAxes({ contract: CONTRACT, prompt: PROMPT });
    const seen: Array<{ has: boolean; canvas: CanvasClass | undefined }> = [];
    const withCanvas = createHarness({ classification, contract: CONTRACT, prompt: PROMPT, canvas: "lg", axisChecks: [probe(seen, classification.vector.render)] });
    const withoutCanvas = createHarness({ classification, contract: CONTRACT, prompt: PROMPT, axisChecks: [probe(seen, classification.vector.render)] });
    const call = { sourceCode: SRC, compiledCode: "x", contract: CONTRACT, prompt: PROMPT, skipRuntimeRender: true } as const;
    const a = await runCheck({ harness: withCanvas, ...call });
    const b = await runCheck({ harness: withoutCanvas, ...call });
    expect(a.firedCheckIds).toContain("probe.canvas_seen");
    expect(b.firedCheckIds).toContain("probe.canvas_seen");
    expect(seen).toEqual([
      { has: true, canvas: "lg" },
      { has: false, canvas: undefined },
    ]);
  });

  it("a DERIVED harness keeps the canvas it was built for — deriveHarness rebuilds from the original input; one built without stays without", () => {
    const classification = classifyAxes({ contract: CONTRACT, prompt: PROMPT });
    const withCanvas = createHarness({ classification, contract: CONTRACT, prompt: PROMPT, canvas: "md" });
    const withoutCanvas = createHarness({ classification, contract: CONTRACT, prompt: PROMPT });
    expect(withCanvas.canvas).toBe("md");
    expect(withCanvas.derive({ classification }).canvas).toBe("md");
    expect("canvas" in withoutCanvas).toBe(false);
    expect("canvas" in withoutCanvas.derive({ classification })).toBe(false);
  });

  it("an existing check's behaviour is byte-identical with and without the canvas (the registry ignores the field)", () => {
    const classification = classifyAxes({ contract: {}, prompt: PROMPT });
    const input = { sourceCode: SRC, compiledCode: "x", originalPrompt: PROMPT, contract: CONTRACT };
    const without = runAxisChecks(classification, input);
    const withLg = runAxisChecks(classification, { ...input, canvas: "lg" });
    const withChat = runAxisChecks(classification, { ...input, canvas: "xs-chat-card" });
    expect(without.length).toBeGreaterThan(0); // the kanban fixture fires grid.board_columns_side_by_side — a real verdict, not an empty one
    expect(withLg).toEqual(without);
    expect(withChat).toEqual(without);
  });

  it("the ggui#1046 trace line carries the canvas a verdict was built for, and omits the key — never a default — when there was none", () => {
    process.env["GGUI_AXIS_CHECK_TRACE"] = "1";
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const classification = classifyAxes({ contract: {}, prompt: PROMPT });
    const input = { sourceCode: SRC, compiledCode: "x", originalPrompt: PROMPT, contract: CONTRACT };
    const lines = (): AxisCheckTrace[] =>
      spy.mock.calls
        .map((c) => JSON.parse(String(c[0])) as { axisCheckTrace?: AxisCheckTrace })
        .flatMap((l) => (l.axisCheckTrace ? [l.axisCheckTrace] : []));
    runAxisChecks(classification, { ...input, canvas: "md" });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ canvas: "md", designMode: "constrained" });
    spy.mockClear();
    runAxisChecks(classification, input);
    expect(lines()).toHaveLength(1);
    expect("canvas" in lines()[0]!).toBe(false);
  });
});
