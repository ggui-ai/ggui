// core/src/benchmarks/multi-sdk/fixtures/survey-form.fixture.ts

import { retrofit } from "./retrofit";

export const surveyForm = retrofit("survey-form", {
  expected: {
    vector: {
      render: "static",
      state: "payload",
      writes: "submit",
      writeTrigger: "click",
      realtime: "none",
      fetch: "none",
      layout: "multi-step",
    tooling: "none",
    },
    riskTier: "medium",
    provenance: {
      render: "contract",
      state: "contract",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      // prompt describes 4-step flow decisively
      layout: "prompt",
    tooling: "default",
    },
  },
  evalGoals: [
    "useState covers every submit payload key (name, email, followUpDate, satisfaction, features, comments)",
    "Step state via useState<number>, 0-indexed (Stepper.current is zero-based)",
    "Each step renders only its fields",
    "Follow-up date collected via Input type=\"date\" (ISO string value), validated as not in the past",
    "Next button disabled until current step validated",
    "Review step shows all collected values before submit",
    "submit invoked with assembled payload on final click",
    "Both arr<str> option props mapped in JSX (featureOptions, satisfactionLabels)",
  ],
  whyNotReducible:
    "Canonical multi-step form. payload-assembly state + terminal submit + step navigation.",
});

export default surveyForm;
