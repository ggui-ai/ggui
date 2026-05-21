// core/src/benchmarks/multi-sdk/fixtures/weather-card.fixture.ts

import { retrofit } from "./retrofit";

export const weatherCard = retrofit("weather-card", {
  expected: {
    vector: {
      render: "static",
      state: "none",
      writes: "none",
      writeTrigger: "click",
      realtime: "none",
      fetch: "none",
      layout: "single",
    tooling: "none",
    },
    riskTier: "low",
    provenance: {
      render: "contract",
      state: "contract",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "default",
    tooling: "default",
    },
  },
  evalGoals: [
    "All required props referenced in render",
    "No useState anywhere (pure passive)",
    "Forecast arr mapped with stable key",
  ],
  whyNotReducible:
    "Canonical pure-passive render. No state, no writes, no streams, no actions. " +
    "Floor case for the bypass gate.",
});

export default weatherCard;
