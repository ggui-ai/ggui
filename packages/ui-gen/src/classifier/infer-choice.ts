// packages/ui-gen/src/classifier/infer-choice.ts
//
// choice axis (ggui#2010) — does the contract offer items to choose among? Derived purely from the contract: see
// `ChoiceShape` for the rule and `ContractSignals.offeredItemChoice` for where it is read.

import type { AxisSource, ChoiceShape } from "./axes";
import type { ContractSignals } from "./inspect";

export function inferChoice(s: ContractSignals): { value: ChoiceShape; source: AxisSource } {
  if (s.offeredItemChoice) return { value: "offered-items", source: "contract" };
  return { value: "none", source: s.actions.length === 0 ? "default" : "contract" };
}
