// packages/ui-gen/src/evaluation/axis-checks/extras.test.ts
//
// Pins for the Exp-47 P2 slice: `layout.multi_step.stepper_adopted`
// owns the Stepper mandate on the CHECK leg, and the always-on
// `stepper-display-only` pitfall is gone from the prompt (its guidance
// moved into this check's fix string). The pair is the contract — if
// the check ever regresses AND the pitfall stays deleted, multi-step
// cells lose the mandate entirely.

import { describe, expect, it } from "vitest";
import type { Classification } from "../../classifier/axes.js";
import type { AxisCheckInput } from "./types.js";
import { matches } from "./types.js";
import { EXTRA_CHECKS } from "./extras.js";
import { renderPitfallsBlock } from "../../harness/pitfalls.js";

const stepperAdopted = EXTRA_CHECKS.find(
  (c) => c.id === "layout.multi_step.stepper_adopted",
);

function classification(layout: "single" | "multi-step"): Classification {
  return {
    vector: {
      render: "static",
      state: "none",
      writes: "submit",
      writeTrigger: "click",
      realtime: "none",
      fetch: "none",
      layout,
      tooling: "none",
    },
    provenance: {
      render: "default",
      state: "default",
      writes: "default",
      writeTrigger: "default",
      realtime: "default",
      fetch: "default",
      layout: "default",
      tooling: "default",
    },
    riskTier: "low",
  };
}

function makeInput(sourceCode: string, layout: "single" | "multi-step"): AxisCheckInput {
  return {
    sourceCode,
    compiledCode: "compiled",
    originalPrompt: "a multi-step wizard",
    classification: classification(layout),
  };
}

describe("layout.multi_step.stepper_adopted", () => {
  it("is registered and gates on layout=multi-step only", () => {
    expect(stepperAdopted).toBeDefined();
    expect(matches(classification("multi-step").vector, stepperAdopted!)).toBe(true);
    expect(matches(classification("single").vector, stepperAdopted!)).toBe(false);
  });

  it("passes when the source renders a Stepper", () => {
    const src = `const STEPS = ["A", "B"];
      export default function W() {
        const [step, setStep] = useState(0);
        return <div><Stepper steps={STEPS} current={step} /></div>;
      }`;
    expect(stepperAdopted!.run(makeInput(src, "multi-step"))).toEqual([]);
  });

  it("fails when a multi-step cell never renders Stepper", () => {
    const src = `export default function W() {
      const [step, setStep] = useState(0);
      return <div>step {step}</div>;
    }`;
    const issues = stepperAdopted!.run(makeInput(src, "multi-step"));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.result).toBe("fail");
    expect(issues[0]!.subcategory).toBe("layout.multi_step.stepper_adopted");
    // The retired pitfall's display-only guidance must live on in the fix.
    expect(issues[0]!.fix).toMatch(/display-only/);
  });

  it("skips when compile failed (nothing to check)", () => {
    const input = { ...makeInput("no stepper here", "multi-step"), compiledCode: null };
    expect(stepperAdopted!.run(input)).toEqual([]);
  });
});

describe("stepper-display-only pitfall retirement", () => {
  it("the always-on pitfalls block no longer mentions Stepper", () => {
    // Exp 47 P2: adoption is carried by fragment + JSDoc (17/18 with no
    // enforcement) and now guarded by the axis check above — the 6th
    // always-on prompt rule was pure attention-dilution (exp66 class).
    expect(renderPitfallsBlock()).not.toMatch(/Stepper/);
  });
});
