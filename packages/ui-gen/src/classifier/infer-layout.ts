// packages/ui-gen/src/classifier/infer-layout.ts

import type { AxisSource, LayoutShape } from "./axes";
import type { ContractSignals } from "./inspect";

interface BlueprintHint {
  mechanic?: string;
  layoutHint?: string;
}

const OVERLAY_RX =
  /\b(overlay|overlaid|on\s*top|positioned\s*over|floating\s*action)\b/i;
const MODAL_RX = /\b(modal|dialog|sheet|drawer|card\s*stack)\b/i;
const MULTI_STEP_RX = /\b(multi[- ]step|wizard|step\s*\d+|step\s*\d+\s*:)/i;
const MASTER_DETAIL_RX =
  /\b(left\s*pane|right\s*pane|left\s*sidebar|right\s*main|split\s*view|two[- ]pane|master[- ]detail)\b/i;

export function inferLayout(
  s: ContractSignals,
  prompt: string,
  blueprint: BlueprintHint | undefined,
): { value: LayoutShape; source: AxisSource } {
  if (blueprint?.layoutHint) {
    const hint = blueprint.layoutHint.toLowerCase();
    if (hint.includes("master-detail") || hint.includes("split"))
      return { value: "master-detail", source: "blueprint" };
    if (hint.includes("modal") || hint.includes("card-stack") || hint.includes("deck"))
      return { value: "modal", source: "blueprint" };
    if (hint.includes("overlay")) return { value: "overlay", source: "blueprint" };
    if (hint.includes("multi-step") || hint.includes("wizard"))
      return { value: "multi-step", source: "blueprint" };
  }

  if (MULTI_STEP_RX.test(prompt)) return { value: "multi-step", source: "prompt" };
  if (OVERLAY_RX.test(prompt)) return { value: "overlay", source: "prompt" };
  if (MODAL_RX.test(prompt)) return { value: "modal", source: "prompt" };
  if (MASTER_DETAIL_RX.test(prompt))
    return { value: "master-detail", source: "prompt" };

  // Don't bother using s for now — layout is mostly prompt/blueprint driven.
  void s;

  return { value: "single", source: "default" };
}
