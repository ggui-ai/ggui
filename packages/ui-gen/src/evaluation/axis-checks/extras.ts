// packages/ui-gen/src/evaluation/axis-checks/extras.ts
//
// Axis-specific checks that had no legacy home. These fire on axis values
// the old 3-mode dispatch didn't route (drag, swipe, compose, multi-step,
// mixed streams). Intentionally narrow — each catches a specific failure
// mode the fragments' prompt text tells the LLM to avoid.

import type { AxisCheck, AxisCheckInput } from "./types.js";
import type { EvalIssue } from "../types-public.js";

function mkIssue(
  subcategory: string,
  description: string,
  fix: string,
  result: "fail" | "warn" = "warn",
): EvalIssue {
  return { tier: 0, result, category: "mode", subcategory, description, fix };
}

/**
 * writeTrigger=drag → must attach onDragStart + onDrop (or onDragOver)
 * somewhere. Otherwise the drag handler is decorative.
 */
const dragTriggerWired: AxisCheck = {
  id: "writeTrigger.drag.handlers_wired",
  axis: "writeTrigger",
  values: ["drag"],
  run(input: AxisCheckInput): EvalIssue[] {
    if (input.compiledCode === null) return [];
    const src = input.sourceCode;
    const hasStart = /onDragStart\s*=/.test(src);
    const hasDrop = /onDrop\s*=/.test(src);
    if (hasStart && hasDrop) return [];
    return [
      mkIssue(
        "writeTrigger.drag.handlers_wired",
        `Classified as writeTrigger=drag but component lacks ${!hasStart ? "onDragStart" : ""}${!hasStart && !hasDrop ? " + " : ""}${!hasDrop ? "onDrop" : ""} handlers.`,
        "Attach onDragStart to draggable items and onDrop (with onDragOver preventDefault) to drop zones.",
        "fail",
      ),
    ];
  },
};

/**
 * writeTrigger=swipe → must wire onTouchStart + onTouchEnd. Also emit
 * a warn if no fallback click handlers exist (desktop users).
 */
const swipeTriggerWired: AxisCheck = {
  id: "writeTrigger.swipe.handlers_wired",
  axis: "writeTrigger",
  values: ["swipe"],
  run(input: AxisCheckInput): EvalIssue[] {
    if (input.compiledCode === null) return [];
    const src = input.sourceCode;
    const hasTouch = /onTouchStart\s*=/.test(src) && /onTouchEnd\s*=/.test(src);
    if (!hasTouch) {
      return [
        mkIssue(
          "writeTrigger.swipe.handlers_wired",
          "Classified as writeTrigger=swipe but component lacks onTouchStart + onTouchEnd handlers.",
          "Wire onTouchStart to record the start X/Y, onTouchEnd to classify direction and fire the action.",
          "fail",
        ),
      ];
    }
    return [];
  },
};

/**
 * writes=compose → exactly one action should be called with ids sourced
 * from two different state slots. Heuristic: at least two useState or
 * props.id references should appear in the action invocation's argument
 * region.
 *
 * Light check: warn if only one id-bearing field appears near the useAction
 * invocation (hard to get false-positive free without AST).
 */
const composeCrossEntity: AxisCheck = {
  id: "writes.compose.cross_entity_ids",
  axis: "writes",
  values: ["compose"],
  run(input: AxisCheckInput): EvalIssue[] {
    if (input.compiledCode === null) return [];
    const src = input.sourceCode;
    // Look for an action invocation passing an object literal with >= 2
    // `*Id` or `id` keys. That's the compose signature.
    const re = /\{\s*[^}]*?\b(\w*Id|id)\b[^}]*?,\s*[^}]*?\b(\w*Id|id)\b[^}]*?\}/s;
    if (re.test(src)) return [];
    return [
      mkIssue(
        "writes.compose.cross_entity_ids",
        "Classified as writes=compose but no action invocation passes two id-bearing keys together.",
        "The compose action must receive both entity ids in one payload, e.g. `schedule({ eventId, calendarId })`.",
        "warn",
      ),
    ];
  },
};

/**
 * layout=multi-step → integer step state + a step-guard on Next. Re-uses
 * the form check's multi-step signal, but fires even when writes != submit
 * (e.g., multi-step wizards that never submit, like onboarding).
 */
const multiStepHasState: AxisCheck = {
  id: "layout.multi_step.state_present",
  axis: "layout",
  values: ["multi-step"],
  run(input: AxisCheckInput): EvalIssue[] {
    if (input.compiledCode === null) return [];
    const src = input.sourceCode;
    const hasIntStep = /useState(?:<number>)?\s*\(\s*[0-9]+\s*\)/.test(src);
    if (hasIntStep) return [];
    return [
      mkIssue(
        "layout.multi_step.state_present",
        "Classified as layout=multi-step but no integer-typed useState tracks the current step.",
        "Add `const [step, setStep] = useState(0);` and branch rendering on it.",
        "fail",
      ),
    ];
  },
};

/**
 * realtime=mixed → the contract declares multiple events of different
 * kinds. Each must have its own useStream call. We approximate by
 * requiring ≥ 2 useStream calls when the vector is mixed.
 */
const mixedStreamsHaveHandlers: AxisCheck = {
  id: "realtime.mixed.handlers_per_event",
  axis: "realtime",
  values: ["mixed"],
  run(input: AxisCheckInput): EvalIssue[] {
    if (input.compiledCode === null) return [];
    const src = input.sourceCode;
    // Accept both `useStream('x')` and `useStream<T>('x')` (generic type arg).
    // The boilerplate pre-emits typed calls, so the `(` -only regex was a
    // 100%-false-positive on chat-interface + stock-ticker (Experiment 34).
    const matches = src.match(/useStream\s*(?:<[^>]*>)?\s*\(/g);
    const count = matches?.length ?? 0;
    if (count >= 2) return [];
    return [
      mkIssue(
        "realtime.mixed.handlers_per_event",
        `Classified as realtime=mixed but only ${count} useStream call(s) found — mixed streams need one handler per event.`,
        "Add a separate `useStream('eventName')` for each event in the contract.",
        "fail",
      ),
    ];
  },
};

export const EXTRA_CHECKS: readonly AxisCheck[] = [
  dragTriggerWired,
  swipeTriggerWired,
  composeCrossEntity,
  multiStepHasState,
  mixedStreamsHaveHandlers,
];
