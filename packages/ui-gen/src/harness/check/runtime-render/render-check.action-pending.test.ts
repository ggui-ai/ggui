// @vitest-environment happy-dom
// ggui#1398 leg 3 — the click walk reports whether a control whose click
// dispatched an action visibly shows it is working once the action is
// pending. Report-only: it rides `stats.pendingAffordance`, never an issue,
// and it is absent when no action walk ran (so "no data" and "0 of 0" read
// differently). The pending looks run as their own phase AFTER every other
// check, so a card that crashes or resets while pending cannot change what
// the other checks find.

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

const CRASHES_WHEN_PENDING = `
import { useAction, useActionPending } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  const sending = useActionPending('send');
  if (sending) throw new Error('boom while pending');
  return <button onClick={() => send({})}>Send</button>;
}
`;

const DROPS_CONTROLS_WHEN_PENDING = `
import { useEffect, useState } from 'react';
import { useAction, useActionPending } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  const cancel = useAction('cancel');
  const sending = useActionPending('send');
  const [gone, setGone] = useState(false);
  useEffect(() => { if (sending) setGone(true); }, [sending]);
  if (gone) return <p>Done</p>;
  return (
    <div>
      <button onClick={() => send({})}>Send</button>
      <button onClick={() => cancel({})}>Cancel</button>
    </div>
  );
}
`;

const FORM_SUBMIT_PENDING = `
import { useAction, useActionPending } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  const sending = useActionPending('send');
  return (
    <form onSubmit={(e) => { e.preventDefault(); send({}); }}>
      <button type="submit" disabled={sending}>Send</button>
    </form>
  );
}
`;

const REPLACED_BY_OTHER_CONTROL = `
import { useState } from 'react';
import { useAction } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  const [clicked, setClicked] = useState(false);
  if (clicked) return <button>Help</button>;
  return <button onClick={() => { setClicked(true); send({}); }}>Send</button>;
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
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 1, missing: [], gone: [] });
    // Report-only: the walk adds no issue.
    expect(result.issues.filter((i) => i.subject === "send")).toEqual([]);
  }, 30000);

  it("a control that dispatches but never changes is named as missing", async () => {
    const result = await runRenderCheck({ sourceCode: PENDING_BLIND, mockupProps: {}, contract: withSend });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 0, missing: ["send"], gone: [] });
    expect(result.issues.filter((i) => i.subject === "send")).toEqual([]);
  }, 30000);

  it("a card that throws while pending counts as missing, and adds no finding (no render-no-throw, ok stays true)", async () => {
    const result = await runRenderCheck({ sourceCode: CRASHES_WHEN_PENDING, mockupProps: {}, contract: withSend });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 0, missing: ["send"], gone: [] });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  }, 30000);

  it("runs after the other checks: a card that drops its controls once pending still has every action verified first", async () => {
    const contract: DataContract = { actionSpec: { send: { label: "Send" }, cancel: { label: "Cancel" } } };
    const result = await runRenderCheck({ sourceCode: DROPS_CONTROLS_WHEN_PENDING, mockupProps: {}, contract });
    // Mid-walk, marking `send` would have removed Cancel before its own check ran.
    expect(result.issues.filter((i) => i.check === "action-wiring")).toEqual([]);
    // Marking `send` replaced the whole card, so Cancel is gone before its turn: never marked, never missing.
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 1, missing: [], gone: ["cancel"] });
  }, 30000);

  it("a form submit reads the form's submit control, not the form", async () => {
    const result = await runRenderCheck({ sourceCode: FORM_SUBMIT_PENDING, mockupProps: {}, contract: withSend });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 1, missing: [], gone: [] });
  }, 30000);

  it("a control replaced after its click is re-found only by its own identity, never credited to another control", async () => {
    const result = await runRenderCheck({ sourceCode: REPLACED_BY_OTHER_CONTROL, mockupProps: {}, contract: withSend });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 0, visible: 0, missing: [], gone: ["send"] });
  }, 30000);

  it("with too little of the check's time left, the phase is skipped and the field is absent; the other checks stand", async () => {
    const result = await runRenderCheck({ sourceCode: PENDING_AWARE, mockupProps: {}, contract: withSend, deadlineAt: Date.now() });
    expect(result.stats.pendingAffordance).toBeUndefined();
    expect(result.issues).toEqual([]);
    expect(result.stats.actionsChecked).toBe(1);
  }, 30000);

  it("no action walk (no actionSpec) leaves the field absent, not zero", async () => {
    const result = await runRenderCheck({ sourceCode: NO_ACTIONS, mockupProps: {}, contract: {} });
    expect(result.stats.pendingAffordance).toBeUndefined();
  }, 30000);
});
