/**
 * ggui#1398 leg 3 — the adapter carries the probe's pending-affordance walk
 * onto the `ran` outcome, and only there: it is never an eval issue, and an
 * outcome whose check ran no walk has no field.
 */
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

const CONTRACT: DataContract = { actionSpec: { send: { label: "Send" } } };
const SOURCE = `
import { useAction } from '@ggui-ai/wire';
export default function Component() {
  const send = useAction('send');
  return <button onClick={() => send({})}>Send</button>;
}
`;
const run = () =>
  DEFAULT_RUNTIME_RENDER_CHECK.run({ sourceCode: SOURCE, compiledCode: "var C = () => null;", contract: CONTRACT });

describe("the runtime-render adapter — the pending-affordance walk (ggui#1398)", () => {
  beforeEach(() => {
    stubbed.result = undefined;
  });

  it("is carried onto the ran outcome as the check reported it, with no issue", async () => {
    const pendingAffordance = { dispatched: 1, visible: 0, missing: ["send"] };
    stubbed.result = { ok: true, issues: [], stats: { actionsChecked: 1, streamsChecked: 0, renderMs: 5, pendingAffordance } };
    const outcome = await run();
    expect(outcome.status).toBe("ran");
    expect(outcome.issues).toEqual([]);
    expect(outcome.pendingAffordance).toEqual(pendingAffordance);
  });

  it("stays absent when the check ran no walk", async () => {
    stubbed.result = { ok: true, issues: [], stats: { actionsChecked: 0, streamsChecked: 0, renderMs: 5 } };
    const outcome = await run();
    expect(outcome.status).toBe("ran");
    expect(outcome).not.toHaveProperty("pendingAffordance");
  });
});
