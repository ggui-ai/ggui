// core/src/benchmarks/multi-sdk/fixtures/stock-ticker.fixture.ts

import { retrofit } from "./retrofit";

export const stockTicker = retrofit("stock-ticker", {
  expected: {
    vector: {
      render: "grid",
      state: "merge",
      writes: "none",
      writeTrigger: "click",
      realtime: "mixed",
      streamKinds: { priceUpdate: "merge", marketStatus: "status" },
      fetch: "drill-down",
      layout: "single",
    tooling: "wired",
    },
    riskTier: "high",
    provenance: {
      // prompt describes 3-per-row grid of cards; contract has arr<obj> stocks
      render: "prompt",
      state: "contract",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "default",
    tooling: "contract",
    },
  },
  evalGoals: [
    "stocks state seeded from props.stocks",
    "Stream priceUpdate merges by stock.symbol (not id)",
    "marketStatus stream replaces singleton market state",
    "getStockDetail wiredTool invoked on card click for drill-down",
    "Color-coded positive/negative change",
    "Flash animation on price update (prompt requirement)",
  ],
  whyNotReducible:
    "Canonical passive-merge collection with mixed streams (entity-merge + singleton-status). " +
    "identity field is 'symbol', not 'id' — tests idField inference beyond the default. " +
    "Auto-promoted to high by realtime=mixed.",
});

export default stockTicker;
