// @vitest-environment happy-dom
// ggui#1398 leg 3 — the click walk reports whether a control whose click
// dispatched an action visibly shows it is working once the action is
// pending. Report-only: it rides `stats.pendingAffordance`, never an issue,
// and it is absent when no action walk ran (so "no data" and "0 of 0" read
// differently).

import { describe, it, expect } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import { runRenderCheck } from "./render-check.js";

const PENDING_AWARE = `
import { useAction, useActionPending } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  const sending = useActionPending('send');
  return (
    <button disabled={sending} aria-busy={sending} onClick={() => send({})}>
      {sending ? 'Sending…' : 'Send'}
    </button>
  );
}
`;

const PENDING_BLIND = `
import { useAction } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  return <button onClick={() => send({})}>Send</button>;
}
`;

const NO_ACTIONS = `
export default function Component() {
  return <p>Nothing to press</p>;
}
`;

const withSend: DataContract = { actionSpec: { send: { label: "Send" } } };

describe("runRenderCheck — the pending affordance (ggui#1398)", () => {
  it("a control that renders from useActionPending counts as visible", async () => {
    const result = await runRenderCheck({ sourceCode: PENDING_AWARE, mockupProps: {}, contract: withSend });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 1, missing: [] });
    // Report-only: the walk adds no issue.
    expect(result.issues.filter((i) => i.subject === "send")).toEqual([]);
  }, 30000);

  it("a control that dispatches but never changes is named as missing", async () => {
    const result = await runRenderCheck({ sourceCode: PENDING_BLIND, mockupProps: {}, contract: withSend });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 0, missing: ["send"] });
    expect(result.issues.filter((i) => i.subject === "send")).toEqual([]);
  }, 30000);

  it("no action walk (no actionSpec) leaves the field absent, not zero", async () => {
    const result = await runRenderCheck({ sourceCode: NO_ACTIONS, mockupProps: {}, contract: {} });
    expect(result.stats.pendingAffordance).toBeUndefined();
  }, 30000);
});
