// core/src/benchmarks/multi-sdk/fixtures/onboarding-wizard.fixture.ts

import { retrofit } from "./retrofit";

export const onboardingWizard = retrofit("onboarding-wizard", {
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
      layout: "prompt",
    tooling: "default",
    },
  },
  evalGoals: [
    "formData state covers all complete payload keys",
    "initialProfile is read in the useState initializer (pre-fill)",
    "currentStep state drives rendering branch",
    "Review step shows summary from formData",
    "complete invoked with assembled payload",
    "Both arr<str> option props mapped (avatarOptions, roleOptions)",
  ],
  whyNotReducible:
    "Multi-step form with initial-values pre-fill. Tests the initial_values_seeded axis-check path " +
    "that survey-form doesn't exercise.",
});

export default onboardingWizard;
