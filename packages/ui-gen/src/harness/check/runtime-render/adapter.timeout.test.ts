// ggui#1299 — a render check that ran out of wall-clock time is not a verdict
// on the component. The isolated check's bound is wall-clock, so on a
// contended host an ordinary card crosses it; the old mapping reported that
// as `render-no-throw` FAIL ("Component crashed at runtime"), fed it to the
// coding agent as a crash to fix, and counted it as a failure class. Pinned
// here, with the render check stubbed at its module seam:
//   - an `incomplete` check becomes the `timed-out` probe status, carrying its
//     elapsed ms and the host load, with NO eval issue;
//   - a check that ran carries its host load too;
//   - the blueprint validator names it `runtime:probe-timeout` (a warning),
//     never `probe-not-applicable` and never an error.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import type { RenderCheckResult } from "./render-check.js";

const stubbed = vi.hoisted((): { result: RenderCheckResult | undefined } => ({ result: undefined }));
vi.mock("./render-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-check.js")>();
  return {
    ...actual,
    runRenderCheck: async (): Promise<RenderCheckResult> => {
      if (stubbed.result === undefined) throw new Error("test did not stub the render check");
      return stubbed.result;
    },
  };
});

import { DEFAULT_RUNTIME_RENDER_CHECK } from "./adapter.js";
import { validateBlueprint } from "../../../blueprint-validator.js";

const CONTRACT: DataContract = {
  propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } },
  actionSpec: { save: { label: "Save" } },
};

const SOURCE = `
import { useAction } from '@ggui-ai/wire';
export default function Component(props: { title: string }) {
  const save = useAction('save');
  return <button onClick={() => save({ id: '1' })}>{props.title}</button>;
}
`;

const LOAD = { start: 312.4, end: 298.1, cores: 12 };

const TIMED_OUT: RenderCheckResult = {
  ok: false,
  issues: [],
  incomplete: { kind: "timeout", elapsedMs: 30_412, boundMs: 30_000 },
  stats: { actionsChecked: 0, streamsChecked: 0, renderMs: 30_415, hostLoad: LOAD },
};

describe("the runtime-render adapter — a check that ran out of time (ggui#1299)", () => {
  beforeEach(() => {
    stubbed.result = undefined;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("is the timed-out status with its elapsed ms and host load — never an eval issue", async () => {
    stubbed.result = TIMED_OUT;
    const outcome = await DEFAULT_RUNTIME_RENDER_CHECK.run({
      sourceCode: SOURCE,
      compiledCode: "var C = () => null;",
      contract: CONTRACT,
    });

    expect(outcome.status).toBe("timed-out");
    expect(outcome.issues).toEqual([]);
    expect(outcome.elapsedMs).toBe(30_412);
    expect(outcome.hostLoad).toEqual(LOAD);
    expect(outcome.reason).toContain("did not finish within 30000 ms");
    expect(outcome.reason).toContain("host load 312.4 → 298.1 on 12 CPUs");
  });

  it("a check that ran carries its host load beside its issues", async () => {
    stubbed.result = {
      ok: true,
      issues: [],
      stats: { actionsChecked: 1, streamsChecked: 0, renderMs: 900, hostLoad: LOAD },
    };
    const outcome = await DEFAULT_RUNTIME_RENDER_CHECK.run({
      sourceCode: SOURCE,
      compiledCode: "var C = () => null;",
      contract: CONTRACT,
    });

    expect(outcome.status).toBe("ran");
    expect(outcome.hostLoad).toEqual(LOAD);
    expect(outcome.elapsedMs).toBeUndefined();
  });

  it("the blueprint validator names it runtime:probe-timeout — a warning, never an error", async () => {
    stubbed.result = TIMED_OUT;
    const result = await validateBlueprint({ blueprint: { source: SOURCE, contract: CONTRACT } });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    const runtimeCodes = result.warnings.filter((w) => w.tier === "runtime").map((w) => w.code);
    expect(runtimeCodes).toEqual(["runtime:probe-timeout"]);
  });
});
