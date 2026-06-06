// packages/ui-gen/src/fragments/render.ts
//
// Render-axis fragments. One per RenderShape. Kept minimal — the stable
// prefix already covers primitives + design tokens. These only add the
// per-shape layout pattern the LLM needs to commit to up front.

import type { HarnessFragment } from "./types.js";

export const renderFragments: Record<string, HarnessFragment> = {
  static: {
    axis: "render",
    value: "static",
    cacheTier: "axisDelta",
    // Static = single entity detail. Stable prefix already covers the
    // obvious pattern (Card + Stack + Heading + fields). No prompt text
    // here keeps low-risk fixtures fast.
  },
  list: {
    axis: "render",
    value: "list",
    cacheTier: "axisDelta",
    promptText:
      "## Render: list\nVertical column of items. Each item is a <Card> with <Row> + <Text>. Use key={item.id} on each item. Do not paginate unless the contract has a fetch tool with cursor/offset.",
  },
  grid: {
    axis: "render",
    value: "grid",
    cacheTier: "axisDelta",
    promptText:
      "## Render: grid\n2D tile layout. Use <CardGrid> or CSS `display: grid` with `grid-blueprint-columns: repeat(N, 1fr)`. If items carry row/col fields, position each tile at (row, col). Do not scroll horizontally.",
  },
  spatial: {
    axis: "render",
    value: "spatial",
    cacheTier: "axisDelta",
    promptText:
      "## Render: spatial\nGeo/coord-positioned items. Use absolute positioning inside a relative container, or a map primitive if available. Normalize coords to the container's bounds. Treat lat/lng as y/x, not strings.",
  },
  timeline: {
    axis: "render",
    value: "timeline",
    cacheTier: "axisDelta",
    promptText:
      "## Render: timeline\nGroup items by day (or other temporal bucket). Render a sticky date header per group, then the grouped items. Sort newest-first unless the contract says otherwise. Memoize the grouping with useMemo.",
  },
  chart: {
    axis: "render",
    value: "chart",
    cacheTier: "axisDelta",
    promptText:
      "## Render: chart\nNumeric → visual. Render with inline SVG (no chart library). Compute the viewBox from data min/max. Add axis labels and one value label on the latest/peak point. Keep it readable on a 400px container.",
  },
  "master-detail": {
    axis: "render",
    value: "master-detail",
    cacheTier: "axisDelta",
    promptText:
      "## Render: master-detail\nSplit view: list on one side, detail panel on the other. Track `selectedId` in useState, default to the first item's id. Desktop = side-by-side; mobile/chat shell = stacked with back button.",
  },
};
