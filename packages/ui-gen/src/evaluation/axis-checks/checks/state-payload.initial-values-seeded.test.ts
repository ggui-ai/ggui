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

  // The check's window is deliberately as loose as before (any useState( within 400 characters
  // ahead of the reference): tightening it would ADD self-check fails, the opposite of ggui#1261.
  // So the "still flags" cases carry no useState near the prop at all.
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
