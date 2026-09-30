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

const RELABELS_ON_PRESS = `
import { useState } from 'react';
import { useAction, useActionPending } from '@ggui-ai/wire';

export default function Component() {
  const add = useAction('addToCart');
  const adding = useActionPending('addToCart');
  const [added, setAdded] = useState(false);
  return (
    <button disabled={adding} onClick={() => { setAdded(true); add({}); }}>
      {added ? 'Added to Cart' : 'Add to Cart'}
    </button>
  );
}
`;

const BECOMES_ANOTHER_ACTION = `
import { useState } from 'react';
import { useAction } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  const cancel = useAction('cancel');
  const [sent, setSent] = useState(false);
  if (sent) return <button onClick={() => cancel({})}>Cancel</button>;
  return <button onClick={() => { setSent(true); send({}); }}>Send</button>;
}
`;

const FORM_WITH_TYPE_BUTTON = `
import { useAction, useActionPending } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  const sending = useActionPending('send');
  return (
    <form onSubmit={(e) => { e.preventDefault(); send({}); }}>
      <input aria-label="note" defaultValue="" />
      <button type="button">Clear</button>
      <button type="button" disabled={sending}>Send</button>
    </form>
  );
}
`;

const INPUT_SUBMIT_VALUE = `
import { useAction, useActionPending } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  const sending = useActionPending('send');
  return (
    <form onSubmit={(e) => { e.preventDefault(); send({}); }}>
      <input type="submit" value={sending ? 'Sending…' : 'Send'} />
    </form>
  );
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

  it("a node the card reuses for an unrelated control is still read as the pressed one, and not credited: missing", async () => {
    const result = await runRenderCheck({ sourceCode: REPLACED_BY_OTHER_CONTROL, mockupProps: {}, contract: withSend });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 0, missing: ["send"], gone: [] });
  }, 30000);

  it("a button that relabels itself on press ('Add to Cart' → 'Added to Cart') stays its action's control", async () => {
    const contract: DataContract = { actionSpec: { addToCart: { label: "Add to Cart" } } };
    const result = await runRenderCheck({ sourceCode: RELABELS_ON_PRESS, mockupProps: {}, contract });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 1, missing: [], gone: [] });
  }, 30000);

  it("a pressed node that now names ANOTHER of the contract's actions is not this action's control: gone", async () => {
    const contract: DataContract = { actionSpec: { send: { label: "Send" }, cancel: { label: "Cancel" } } };
    const result = await runRenderCheck({ sourceCode: BECOMES_ANOTHER_ACTION, mockupProps: {}, contract });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 0, missing: ["cancel"], gone: ["send"] });
  }, 30000);

  it("a form that submits through a type=button Button is read through that button", async () => {
    const result = await runRenderCheck({ sourceCode: FORM_WITH_TYPE_BUTTON, mockupProps: {}, contract: withSend });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 1, missing: [], gone: [] });
  }, 30000);

  it("an <input type=submit> that relabels through its value reads visible", async () => {
    const result = await runRenderCheck({ sourceCode: INPUT_SUBMIT_VALUE, mockupProps: {}, contract: withSend });
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 1, missing: [], gone: [] });
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
