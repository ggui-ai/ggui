// packages/ui-gen/src/fragments/writes.ts
//
// Writes-axis fragments. Covers both WriteShape (what) and WriteTrigger (how).

import type { HarnessFragment } from "./types.js";

export const writeFragments: Record<string, HarnessFragment> = {
  none: {
    axis: "writes",
    value: "none",
    cacheTier: "axisDelta",
  },
  commit: {
    axis: "writes",
    value: "commit",
    cacheTier: "axisDelta",
    promptText:
      "## Writes: commit\nOne action with a small payload (e.g., addToCart). Wire useAction on a single Button. Do not block the UI on completion — this is fire-and-forget.",
  },
  "multi-commit": {
    axis: "writes",
    value: "multi-commit",
    cacheTier: "axisDelta",
    promptText:
      "## Writes: multi-commit\nMultiple unrelated single-commit actions (e.g., cancel / change destination / contact driver). Each action has its own Button. No shared payload assembly.",
  },
  "per-item": {
    axis: "writes",
    value: "per-item",
    cacheTier: "axisDelta",
    promptText:
      "## Writes: per-item\nEach item in the entity list has its own action button(s). The payload must include the item's id. Example: `onClick={() => toggle({ id: item.id, completed: !item.completed })}`.",
    boilerplateMarker: [
      "",
      "  // ── Per-item actions ──",
      "  // Pass {id, ...} in the payload; wire to a Button inside each item's card.",
      "",
    ].join("\n"),
  },
  submit: {
    axis: "writes",
    value: "submit",
    cacheTier: "axisDelta",
    promptText:
      "## Writes: submit\nTerminal form submit. One action fires with the full assembled payload at the end. Disable the submit button while pending and after success.",
  },
  compose: {
    axis: "writes",
    value: "compose",
    cacheTier: "axisDelta",
    promptText:
      "## Writes: compose (cross-entity action)\nOne trigger references ids from two or more entity lists (e.g., {eventId, calendarId}). Track both selections in local state. Only enable the trigger once both are chosen.",
  },
};

// WriteTrigger is a separate axis but lives in the same file for locality.
export const writeTriggerFragments: Record<string, HarnessFragment> = {
  click: {
    axis: "writeTrigger",
    value: "click",
    cacheTier: "axisDelta",
    // Default case — covered by stable prefix.
  },
  drag: {
    axis: "writeTrigger",
    value: "drag",
    cacheTier: "axisDelta",
    promptText:
      "## Trigger: drag\nDrag-drop interaction. Use HTML5 drag events (onDragStart, onDragOver, onDrop) on the item and drop zones. Track the dragged item id in useState. Set data-ggui-draggable on draggable elements. Do NOT pull in an external dnd library.",
    boilerplateMarker: [
      "",
      "  // ── Drag state ──",
      "  // Track the dragged item id; fire the action on drop with {id, destination}.",
      "",
    ].join("\n"),
  },
  swipe: {
    axis: "writeTrigger",
    value: "swipe",
    cacheTier: "axisDelta",
    promptText:
      "## Trigger: swipe\nTouch gesture → one of N actions. Use onTouchStart/onTouchMove/onTouchEnd. Also expose fallback Buttons so desktop users can trigger the same actions by click.",
  },
  keystroke: {
    axis: "writeTrigger",
    value: "keystroke",
    cacheTier: "axisDelta",
    promptText:
      "## Trigger: keystroke\nKeyboard shortcut. Attach onKeyDown to the container (with tabIndex={0}) or use a window listener inside useEffect with cleanup. Document visible shortcuts in the UI.",
  },
  auto: {
    axis: "writeTrigger",
    value: "auto",
    cacheTier: "axisDelta",
    promptText:
      "## Trigger: auto\nEffect-driven. Use useEffect with a debounce (setTimeout + clearTimeout). Do not fire the action on every keystroke.",
  },
};
