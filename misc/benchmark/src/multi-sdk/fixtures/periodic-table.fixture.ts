// core/src/benchmarks/multi-sdk/fixtures/periodic-table.fixture.ts

import { retrofit } from "./retrofit";

export const periodicTable = retrofit("periodic-table", {
  expected: {
    vector: {
      render: "grid",
      state: "ui-affordance",
      writes: "none",
      writeTrigger: "click",
      realtime: "none",
      fetch: "none",
      layout: "single",
    tooling: "none",
    },
    riskTier: "low",
    provenance: {
      // contract: 2D grid position props (row, col) signal grid
      render: "contract",
      // prompt describes search input + click-to-select; contract alone is passive
      state: "prompt",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "default",
    tooling: "default",
    },
  },
  evalGoals: [
    "CSS grid with element cells placed by row/col from data",
    "useState for search query and selected element",
    "Filter based on name/symbol match — case-insensitive",
    "Legend renders all categories with color coding",
  ],
  whyNotReducible:
    "Grid render (not list) with ui-affordance state driven by prompt (search + select). " +
    "No writes, no streams — the bypass-adjacent case where state exists but no backend contact.",
});

export default periodicTable;
