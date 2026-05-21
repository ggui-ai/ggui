// packages/ui-gen/src/fragments/state.ts
//
// State-axis fragments. This is the most error-prone axis — "merge" in
// particular collapses into append-only bugs without explicit guidance.

import type { HarnessFragment } from "./types.js";

export const stateFragments: Record<string, HarnessFragment> = {
  none: {
    axis: "state",
    value: "none",
    cacheTier: "axisDelta",
    // Pure props → JSX. Stable prefix is enough — no useState call at all.
  },
  "ui-affordance": {
    axis: "state",
    value: "ui-affordance",
    cacheTier: "axisDelta",
    promptText:
      "## State: ui-affordance\nLocal UI state for filter text / selected id / active tab / quantity. Use useState with a sensible default. Do NOT mirror props into state — read props directly and track only the affordance value.",
  },
  merge: {
    axis: "state",
    value: "merge",
    cacheTier: "axisDelta",
    promptText:
      "## State: merge (live entity reconciliation)\n1. Seed `const [items, setItems] = useState(props.items ?? [])`.\n2. On stream updates: `setItems(prev => prev.map(it => it.id === event.id ? { ...it, ...event } : it))` — merge by id, do NOT append.\n3. Memoize derived views (grouping/sorting/filtering) with useMemo.\n4. Per-item actions pass `{ id, ... }` in the payload.\n5. Never push the stream payload into an append-only list unless realtime=append.",
    boilerplateMarker: [
      "",
      "  // ── Live entity state (merge-by-id) ──",
      "  // useState(props.items ?? []); merge stream events by item.id; never append.",
      "",
    ].join("\n"),
  },
  payload: {
    axis: "state",
    value: "payload",
    cacheTier: "axisDelta",
    promptText:
      "## State: payload (form assembly)\nAccumulate form fields in a single state object. Validate on blur or on submit — do NOT block keystrokes. The submit action fires once, with the assembled payload.",
    boilerplateMarker: [
      "",
      "  // ── Form payload ──",
      "  // useState<FormData> seeded with defaults from props or empty; validate on submit.",
      "",
    ].join("\n"),
  },
  draft: {
    axis: "state",
    value: "draft",
    cacheTier: "axisDelta",
    promptText:
      "## State: draft (in-place editor)\nEdit one item at a time. Track `draft` as a separate useState (not mutating the source). Support cancel (discard draft) and save (commit draft → fire action).",
  },
};
