// @vitest-environment happy-dom
// ggui#1652 — the action-wiring check finds each action by walking the card
// in a mount of its own: it clicks each control once per screen, follows the
// screens that appear (a wizard's Next, an Edit that becomes Save), and
// recognises a screen it has seen, so Back and Next cannot loop. Screens are
// told apart by their controls (labels, disabled state), not by typed values.
// The walk's clicks never reach the main render the other checks read, which
// is still primed as before.

import { describe, it, expect } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import { runRenderCheck, PENDING_PHASE_RESERVE_MS } from "./render-check.js";

// Three steps; Back first in the DOM and disabled on step 0; Next gated on
// a typed name, then on a picked rating; "Submit Survey" only on the review.
const STEP_GATED = `
import { useState } from 'react';
import { useAction, useActionPending } from '@ggui-ai/wire';

export default function Component() {
  const submit = useAction('submit');
  const pending = useActionPending('submit');
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [rating, setRating] = useState(0);
  const valid = step === 0 ? name.trim() !== '' : step === 1 ? rating > 0 : true;
  return (
    <div>
      {step === 0 && <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />}
      {step === 1 && [1, 2, 3].map((n) => <button key={n} onClick={() => setRating(n)}>{n} stars</button>)}
      {step === 2 && <p>Review: {name}, {rating} stars</p>}
      <button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
      {step < 2
        ? <button disabled={!valid} onClick={() => setStep(step + 1)}>Next</button>
        : <button disabled={pending} onClick={() => submit({ name, rating })}>{pending ? 'Submitting…' : 'Submit Survey'}</button>}
    </div>
  );
}
`;

// A step whose radio group takes its name from useId inside a component
// that re-mounts with the step: every return to it carries fresh names.
const GENERATED_NAMES = `
import { useId, useState } from 'react';
import { useAction } from '@ggui-ai/wire';

function Rating({ value, onPick }: { value: number; onPick: (n: number) => void }) {
  const group = useId();
  return <div>{[1, 2, 3].map((n) => <input key={n} type="radio" name={group + '-radio'} checked={value === n} onChange={() => onPick(n)} />)}</div>;
}

export default function Component() {
  const submit = useAction('submit');
  const [step, setStep] = useState(0);
  const [rating, setRating] = useState(0);
  return (
    <div>
      {step === 1 && <Rating value={rating} onPick={setRating} />}
      <button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
      {step < 2
        ? <button disabled={step === 1 && rating === 0} onClick={() => setStep(step + 1)}>Next</button>
        : <button onClick={() => submit({ rating })}>Submit Survey</button>}
    </div>
  );
}
`;

// Next comes FIRST in the DOM and is disabled until an option is picked, so
// the walk presses it once while it does nothing.
const NEXT_BEFORE_ITS_GATE = `
import { useState } from 'react';
import { useAction } from '@ggui-ai/wire';

export default function Component() {
  const submit = useAction('submit');
  const [step, setStep] = useState(0);
  const [plan, setPlan] = useState('');
  if (step === 1) return <button onClick={() => submit({ plan })}>Submit Survey</button>;
  return (
    <div>
      <button disabled={plan === ''} onClick={() => setStep(1)}>Next</button>
      <button onClick={() => setPlan('basic')}>Basic</button>
      <button onClick={() => setPlan('pro')}>Pro</button>
    </div>
  );
}
`;

// The dispatch is on the SECOND click of one toggle.
const TOGGLE_GATED = `
import { useState } from 'react';
import { useAction } from '@ggui-ai/wire';

export default function Component() {
  const taskUpdate = useAction('taskUpdate');
  const [editing, setEditing] = useState(false);
  return (
    <div>
      <span>Design landing page</span>
      <button onClick={() => {
        if (editing) { taskUpdate({ taskId: 't1' }); setEditing(false); }
        else setEditing(true);
      }}>{editing ? 'Save' : 'Edit'}</button>
    </div>
  );
}
`;

// Submit wiring: the form exists only on the second screen.
const FORM_GATED = `
import { useState } from 'react';
import { useAction } from '@ggui-ai/wire';

export default function Component() {
  const send = useAction('send');
  const [open, setOpen] = useState(false);
  if (!open) return <button onClick={() => setOpen(true)}>Write a message</button>;
  return (
    <form onSubmit={(e) => { e.preventDefault(); send({}); }}>
      <input aria-label="Message" />
      <button type="submit">Send</button>
    </form>
  );
}
`;

// Click wiring in source that no reachable screen ever renders.
const NEVER_RENDERED = `
import { useState } from 'react';
import { useAction } from '@ggui-ai/wire';

export default function Component() {
  const go = useAction('go');
  const [tab, setTab] = useState('a');
  const hidden = false;
  return (
    <div>
      <button onClick={() => setTab('a')}>Tab A</button>
      <button onClick={() => setTab('b')}>Tab B</button>
      <p>Showing {tab}</p>
      {hidden && <button onClick={() => go({})}>Go</button>}
    </div>
  );
}
`;

// A prop shown only on step 0, with the action behind Next.
const SHOWS_PROP_ON_FIRST_SCREEN = `
import { useState } from 'react';
import { useAction } from '@ggui-ai/wire';

export default function Component({ title }: { title: string }) {
  const finish = useAction('finish');
  const [step, setStep] = useState(0);
  const [seen, setSeen] = useState(false);
  return (
    <div>
      {step === 0 && <h1>{title}</h1>}
      {step === 0 && <button onClick={() => setSeen(true)}>{seen ? 'Seen' : 'Mark seen'}</button>}
      {step === 0 ? <button onClick={() => setStep(1)}>Continue</button> : <button onClick={() => finish({})}>Finish</button>}
    </div>
  );
}
`;

// A prop shown only on the step behind Continue, where the action is.
const SHOWS_PROP_ON_LATER_SCREEN = `
import { useState } from 'react';
import { useAction } from '@ggui-ai/wire';

export default function Component({ title, note }: { title: string; note: string }) {
  const finish = useAction('finish');
  const [step, setStep] = useState(0);
  return step === 0
    ? <button onClick={() => setStep(1)}>Continue</button>
    : <div><h1>{title}</h1><button onClick={() => finish({})}>Finish</button></div>;
}
`;

// No actions at all: the title shows only once the search box has text, so
// a check reading an UNPRIMED card would not see it.
const SHOWS_PROP_WHEN_FILLED = `
import { useState } from 'react';

export default function Component({ title }: { title: string }) {
  const [query, setQuery] = useState('');
  return (
    <div>
      <input aria-label="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
      {query !== '' && <p>{title}</p>}
    </div>
  );
}
`;

const actions = (name: string, label: string): DataContract => ({ actionSpec: { [name]: { label } } });

describe("runRenderCheck — the action walk (ggui#1652)", () => {
  it("follows a wizard to its last screen (Back first and disabled; Next gated on typed and picked answers) and verifies the action there", async () => {
    const result = await runRenderCheck({ sourceCode: STEP_GATED, mockupProps: {}, contract: actions("submit", "Submit Survey") });
    expect(result.issues.filter((i) => i.check === "action-wiring")).toEqual([]);
    // The control the walk pressed is the one the pending phase reads.
    expect(result.stats.pendingAffordance).toEqual({ dispatched: 1, visible: 1, missing: [], gone: [] });
  }, 30000);

  it("recognises a step it returns to although its controls carry fresh generated names (useId), so Back cannot loop it", async () => {
    const result = await runRenderCheck({ sourceCode: GENERATED_NAMES, mockupProps: {}, contract: actions("submit", "Submit Survey") });
    expect(result.issues.filter((i) => i.check === "action-wiring")).toEqual([]);
  }, 30000);

  it("presses a control again once the screen enables it (Next pressed while disabled, then an option picked)", async () => {
    const result = await runRenderCheck({ sourceCode: NEXT_BEFORE_ITS_GATE, mockupProps: {}, contract: actions("submit", "Submit Survey") });
    expect(result.issues.filter((i) => i.check === "action-wiring")).toEqual([]);
  }, 30000);

  it("clicks a toggle again once it has become another control (Edit → Save)", async () => {
    const result = await runRenderCheck({ sourceCode: TOGGLE_GATED, mockupProps: {}, contract: actions("taskUpdate", "Update task") });
    expect(result.issues.filter((i) => i.check === "action-wiring")).toEqual([]);
  }, 30000);

  it("reaches a form that appears on a later screen, for submit wiring", async () => {
    const result = await runRenderCheck({ sourceCode: FORM_GATED, mockupProps: {}, contract: actions("send", "Send") });
    expect(result.issues.filter((i) => i.check === "action-wiring")).toEqual([]);
  }, 30000);

  it("stays unverified when no screen renders the control, says so, and names what it clicked rather than the first button in the page", async () => {
    const result = await runRenderCheck({ sourceCode: NEVER_RENDERED, mockupProps: {}, contract: actions("go", "Go") });
    const [issue] = result.issues.filter((i) => i.check === "action-wiring");
    expect(issue).toMatchObject({ outcome: "unverified", subject: "go" });
    expect(issue!.elementHint).toBeUndefined();
    expect(issue!.diagnostics?.walk).toMatchObject({ stoppedBy: "explored", namedControlSeen: false });
    expect(issue!.diagnostics!.walk!.presses).toBeGreaterThan(0);
    expect(issue!.diagnostics!.walk!.lastPressed.length).toBeGreaterThan(0);
  }, 30000);

  it("leaves the main render alone: a prop shown only on the first screen still reads as covered", async () => {
    const contract: DataContract = {
      ...actions("finish", "Finish"),
      propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } },
    };
    const result = await runRenderCheck({ sourceCode: SHOWS_PROP_ON_FIRST_SCREEN, mockupProps: { title: "Quarterly review" }, contract });
    expect(result.issues.filter((i) => i.check === "action-wiring")).toEqual([]);
    expect(result.issues.filter((i) => i.check === "prop-coverage")).toEqual([]);
  }, 30000);

  it("counts a prop shown on a screen the walk reached as covered; a prop shown on none still warns", async () => {
    const contract: DataContract = {
      ...actions("finish", "Finish"),
      propsSpec: {
        properties: {
          title: { schema: { type: "string" }, required: true },
          note: { schema: { type: "string" }, required: true },
        },
      },
    };
    const result = await runRenderCheck({
      sourceCode: SHOWS_PROP_ON_LATER_SCREEN,
      mockupProps: { title: "Quarterly review", note: "Never shown anywhere" },
      contract,
    });
    expect(result.issues.filter((i) => i.check === "prop-coverage").map((i) => i.subject)).toEqual(["note"]);
  }, 30000);

  it("still primes the main render the later checks read, on a card with no actions too (as before the walk)", async () => {
    const result = await runRenderCheck({
      sourceCode: SHOWS_PROP_WHEN_FILLED,
      mockupProps: { title: "Periodic table" },
      contract: { propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } } },
    });
    expect(result.issues.filter((i) => i.check === "prop-coverage")).toEqual([]);
  }, 30000);

  it("words a prop-coverage warning as before on a card no walk ran on, and names the walked screens only where a walk ran", async () => {
    const propsSpec = { properties: { note: { schema: { type: "string" as const }, required: true } } };
    const noWalk = await runRenderCheck({ sourceCode: SHOWS_PROP_WHEN_FILLED, mockupProps: { title: "T", note: "Never shown anywhere" }, contract: { propsSpec } });
    expect(noWalk.issues.find((i) => i.check === "prop-coverage")?.reason).toBe(
      `Required prop 'note' value ("Never shown anywhere") not visible in rendered DOM`
    );
    const walked = await runRenderCheck({
      sourceCode: SHOWS_PROP_ON_LATER_SCREEN,
      mockupProps: { title: "T", note: "Never shown anywhere" },
      contract: { ...actions("finish", "Finish"), propsSpec },
    });
    expect(walked.issues.find((i) => i.check === "prop-coverage")?.reason).toBe(
      `Required prop 'note' value ("Never shown anywhere") not visible in rendered DOM, on the first screen or any screen the action walk reached`
    );
  }, 30000);

  it("does not walk into the pending phase's reserve: near the deadline it stops as soon as a press leaves the first screen, and says so", async () => {
    const result = await runRenderCheck({
      sourceCode: STEP_GATED,
      mockupProps: {},
      contract: actions("submit", "Submit Survey"),
      deadlineAt: Date.now() + PENDING_PHASE_RESERVE_MS + 500,
    });
    const [issue] = result.issues.filter((i) => i.check === "action-wiring");
    expect(issue).toMatchObject({ outcome: "unverified", subject: "submit" });
    // Unbounded only while on the first screen with controls left there:
    // Back (disabled, so the screen stays), then Next (it leaves). Nothing
    // past it.
    expect(issue!.diagnostics?.walk).toMatchObject({ stoppedBy: "deadline", presses: 2, screens: 2 });
  }, 30000);
});
