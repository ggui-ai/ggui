// ggui#1299 — a render check that ran out of wall-clock time is not a verdict
// on the component. The isolated check's bound is wall-clock, so on a
// contended host an ordinary card crosses it; the old mapping reported that
// as `render-no-throw` FAIL ("Component crashed at runtime"), fed it to the
// coding agent as a crash to fix, and counted it as a failure class. Pinned
// here, with the render check stubbed at its module seam:
//   - an `incomplete` check becomes the `timed-out` probe status, carrying its
//     elapsed ms and the host load, with NO eval issue;
//   - a check that ran carries its host load, its wall-clock (`elapsedMs`,
//     the adapter's own clock around the check — ggui#1380) and the check's
//     render time (`renderMs`);
//   - a `not-applicable` outcome carries neither: nothing ran;
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
    // ggui#1380 — one clock on every status: the adapter's wall-clock, not the
    // worker's reading (which stays in `reason`).
    expect(typeof outcome.elapsedMs).toBe("number");
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(outcome.hostLoad).toEqual(LOAD);
    expect(outcome.reason).toContain("did not finish within 30000 ms");
    expect(outcome.reason).toContain("stopped at 30412 ms");
    expect(outcome.reason).toContain("host load 312.4 → 298.1 on 12 CPUs");
  });

  it("a check that ran carries its host load, its wall-clock and its render time beside its issues (ggui#1380)", async () => {
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
    expect(typeof outcome.elapsedMs).toBe("number");
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(outcome.renderMs).toBe(900);
  });

  it("a not-applicable outcome carries neither elapsedMs nor renderMs — nothing ran", async () => {
    const outcome = await DEFAULT_RUNTIME_RENDER_CHECK.run({
      sourceCode: SOURCE,
      compiledCode: "var C = () => null;",
      contract: undefined,
    });

    expect(outcome.status).toBe("not-applicable");
    expect(outcome).not.toHaveProperty("elapsedMs");
    expect(outcome).not.toHaveProperty("renderMs");
  });

  it("an infra failure carries its wall-clock too (ggui#1380)", async () => {
    vi.mocked(console.warn).mockImplementation(() => {});
    stubbed.result = undefined;
    const outcome = await DEFAULT_RUNTIME_RENDER_CHECK.run({
      sourceCode: SOURCE,
      compiledCode: "var C = () => null;",
      contract: CONTRACT,
    });

    expect(outcome.status).toBe("infra-skipped");
    expect(outcome.reason).toBe("test did not stub the render check");
    expect(typeof outcome.elapsedMs).toBe("number");
    expect(outcome).not.toHaveProperty("renderMs");
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
