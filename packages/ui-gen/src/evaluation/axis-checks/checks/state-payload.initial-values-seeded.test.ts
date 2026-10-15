/**
 * `state.payload.initial_values_seeded` (ggui#1261) — an `initial*` object prop must seed form
 * state. The property is "a useState initializer reads the prop", directly or through a local
 * bound from it; Exp 011's stuck cell re-seeded correctly through a normalized local, was
 * refused by the literal-only form of this check, and spent a turn restoring the literal.
 */
import { describe, expect, it } from "vitest";
import type { Classification } from "../../../classifier/axes.js";
import type { AxisCheckInput } from "../types.js";
import { STATE_PAYLOAD_CHECKS } from "./state-payload.js";

const check = STATE_PAYLOAD_CHECKS.find((c) => c.id === "state.payload.initial_values_seeded");
if (check === undefined) throw new Error("check not registered");

const classification: Classification = {
  vector: { render: "static", state: "none", writes: "submit", writeTrigger: "click", realtime: "none", fetch: "none", layout: "single", tooling: "none" },
  provenance: { render: "default", state: "default", writes: "default", writeTrigger: "default", realtime: "default", fetch: "default", layout: "default", tooling: "default" },
  riskTier: "low",
};

function run(sourceCode: string) {
  const input: AxisCheckInput = {
    sourceCode,
    compiledCode: sourceCode,
    originalPrompt: "",
    classification,
    contract: {
      propsSpec: { properties: { initialProfile: { description: "pre-filled values", schema: { type: "object" } } } },
      actionSpec: {},
    },
  };
  return check!.run(input);
}

describe("state.payload.initial_values_seeded (ggui#1261)", () => {
  it("passes a useState initializer that reads the prop directly", () => {
    expect(run(`const [name, setName] = useState(props.initialProfile?.name ?? '');`)).toEqual([]);
  });

  it("passes seeding through a local bound from the prop (the stuck cell's correct re-seed)", () => {
    expect(
      run(`
        const initial = normalizeProfile(props.initialProfile);
        const [name, setName] = useState(initial.name);
        const [email, setEmail] = useState(initial.email);
      `),
    ).toEqual([]);
  });

  it("passes seeding through a destructure of the prop, and reads optional chaining on props", () => {
    expect(
      run(`
        const { name: seedName, email } = props?.initialProfile ?? {};
        const [name, setName] = useState(seedName ?? '');
      `),
    ).toEqual([]);
  });

  // ggui#1869: the reader takes each useState initializer whole, to its matching paren. The old
  // reader matched any `useState(` within 400 characters ahead of the reference, so a prop read that
  // merely sat near an unrelated useState passed as a seed (the over-match case below).
  it("flags a prop read that only sits near an unrelated useState, with the real state seeded from nothing", () => {
    expect(
      run(`
        const [name, setName] = useState('');
        const [step, setStep] = useState(0);
        return <p>Editing {props.initialProfile?.name} — step {step}</p>;
      `),
    ).toHaveLength(1);
  });

  it("still flags a prop that is only rendered, with no useState seeding anything", () => {
    expect(run(`return <p>{props.initialProfile?.name}</p>;`)).toHaveLength(1);
  });

  it("still flags a local bound from the prop when no useState initializer reads it", () => {
    expect(
      run(`
        const initial = normalizeProfile(props.initialProfile);
        return <p>{initial.name}</p>;
      `),
    ).toHaveLength(1);
  });
});

// ggui#1869 — a form built on generated context slots has no useState to seed: the boilerplate
// declares `const [name, setName] = useGguiContext<string>('name')`, the runtime owns the state,
// and the hook takes no initial value. Seeding is a setter fed from the prop in an effect, or the
// slot's value falling back to the prop. A replayed model cell did both and was refused.
describe("state.payload.initial_values_seeded on context slots (ggui#1869)", () => {
  const SLOTS = `
    const [name, setName] = useGguiContext<string>('name'); // DO NOT EDIT
    const [email, setEmail] = useGguiContext<string>('email'); // DO NOT EDIT
  `;

  it("passes the replayed cell's shape: an effect seeding the slots, and fallbacks to the prop", () => {
    expect(
      run(`${SLOTS}
        useEffect(() => {
          const p = props.initialProfile;
          if (!p) return;
          if (p.name && !name) setName(p.name);
          if (p.email && !email) setEmail(p.email);
        }, [props.initialProfile]);
        const nameValue = name ?? props.initialProfile?.name ?? '';
        return <TextField value={nameValue} onChange={setName} />;
      `),
    ).toEqual([]);
  });

  it("passes an effect that feeds a slot setter straight from the prop", () => {
    expect(
      run(`${SLOTS}
        useEffect(() => { setName(props.initialProfile?.name ?? ''); }, []);
      `),
    ).toEqual([]);
  });

  it("passes a slot value that falls back to the prop, with no effect", () => {
    expect(run(`${SLOTS} const shown = email ?? props.initialProfile?.email;`)).toEqual([]);
  });

  it("flags a slot setter fed from the prop only in an event handler (a click is not a mount)", () => {
    expect(
      run(`${SLOTS}
        return <Button onClick={() => setName(props.initialProfile?.name ?? '')}>Reset</Button>;
      `),
    ).toHaveLength(1);
  });

  it("flags an effect that names the prop only in its deps and sets the slot from a literal", () => {
    expect(
      run(`${SLOTS}
        useEffect(() => { setName(''); }, [props.initialProfile]);
        return <p>{props.initialProfile?.name}</p>;
      `),
    ).toHaveLength(1);
  });

  it("flags a slot that falls back to a literal while the prop is only rendered", () => {
    expect(
      run(`${SLOTS}
        const shown = name ?? '';
        return <p>{shown} / {props.initialProfile?.name}</p>;
      `),
    ).toHaveLength(1);
  });

  it("does not take a member access named like a slot for the slot (`p.name ?? props…`)", () => {
    expect(
      run(`${SLOTS}
        const label = user.name ?? props.initialProfile?.name;
        return <p>{label}</p>;
      `),
    ).toHaveLength(1);
  });
});
