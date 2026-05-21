// packages/ui-gen/src/fragments/fetch.ts
//
// Fetch-axis fragments. Covers how the component reacts to agent-fetched
// data — agent-side tools live in `agentCapabilities.tools` (catalog
// only); the component itself never invokes them directly.

import type { HarnessFragment } from "./types.js";

export const fetchFragments: Record<string, HarnessFragment> = {
  none: {
    axis: "fetch",
    value: "none",
    cacheTier: "axisDelta",
  },
  pagination: {
    axis: "fetch",
    value: "pagination",
    cacheTier: "axisDelta",
    promptText:
      "## Fetch: pagination\nTrack `cursor` (or offset/page) in useState. Expose a 'Load more' Button that calls the tool with the next cursor and appends results. Show a spinner while tool.isPending.",
  },
  search: {
    axis: "fetch",
    value: "search",
    cacheTier: "axisDelta",
    promptText:
      "## Fetch: search\nDebounced query → tool call. Track `query` in useState; fire the tool inside useEffect after a 300ms debounce. Replace (don't append) results on each call. Guard against stale responses.",
  },
  "drill-down": {
    axis: "fetch",
    value: "drill-down",
    cacheTier: "axisDelta",
    promptText:
      "## Fetch: drill-down\nOn item click, call the tool with the item's id and show the detail. Track `selectedId` and `detail` separately; render a loading placeholder while tool.isPending.",
  },
  refresh: {
    axis: "fetch",
    value: "refresh",
    cacheTier: "axisDelta",
    promptText:
      "## Fetch: refresh\nUser-triggered re-fetch (e.g., pull-to-refresh or a Refresh button). Re-call the tool with the same args; show a small spinner while pending.",
  },
};
