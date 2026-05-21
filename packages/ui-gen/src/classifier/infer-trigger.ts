// packages/ui-gen/src/classifier/infer-trigger.ts

import type { AxisSource, WriteTrigger } from "./axes";
import type { ContractSignals } from "./inspect";

interface BlueprintHint {
  mechanic?: string;
  layoutHint?: string;
}

const DRAG_RX = /\b(drag|drop|dragging|draggable)\b/i;
const SWIPE_RX = /\b(swipe|swipes|gesture\s*stack)\b/i;
const KEYBOARD_RX = /\b(keyboard\s*shortcut|hotkey|keystroke|kbd)\b/i;

export function inferWriteTrigger(
  s: ContractSignals,
  prompt: string,
  blueprint: BlueprintHint | undefined,
): { value: WriteTrigger; source: AxisSource } {
  // If there are no actions at all, trigger is irrelevant — default to 'click'
  // but mark source as 'default' to convey that the value isn't load-bearing.
  if (s.actions.length === 0) {
    return { value: "click", source: "default" };
  }

  // Blueprint mechanic — explicit authored hint
  if (blueprint?.mechanic === "drag")
    return { value: "drag", source: "blueprint" };
  if (blueprint?.mechanic === "swipe")
    return { value: "swipe", source: "blueprint" };

  // Prompt signals
  if (DRAG_RX.test(prompt)) return { value: "drag", source: "prompt" };
  if (SWIPE_RX.test(prompt)) return { value: "swipe", source: "prompt" };
  if (KEYBOARD_RX.test(prompt)) return { value: "keystroke", source: "prompt" };

  return { value: "click", source: "default" };
}
