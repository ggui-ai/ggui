// packages/ui-gen/src/classifier/infer-state.ts

import type { AxisSource, StateShape } from "./axes";
import type { ContractSignals } from "./inspect";

// Intentionally excludes 'current' (false-matches "Current temperature").
// Each keyword should imply meaningful local state.
const AFFORDANCE_KEYWORDS =
  /\b(search\b|filter\b|sort\b|select\b|tabs?\b|quantity\b|paginat|expand(ed|able)?|collaps|click(?:s|ing|ed)?\s+(an|a|the)\s+\w+\s*→?\s*detail|click\s+to\s+(select|open|view))/i;

export function inferState(
  s: ContractSignals,
  prompt: string,
): { value: StateShape; source: AxisSource } {
  // Payload assembly: single action with multi-scalar payload, no entity ref
  if (
    s.actions.length === 1 &&
    s.multiFieldSubmit &&
    !s.entityListIdInPayload &&
    !s.singletonIdInPayload
  ) {
    return { value: "payload", source: "contract" };
  }

  // Live merge: streams exist
  if (s.streams.length > 0) {
    return { value: "merge", source: "contract" };
  }

  // Live merge: entity list with mutating action (optimistic update)
  if (s.entityLists.length > 0 && s.entityListIdInPayload) {
    return { value: "merge", source: "contract" };
  }

  // UI affordance: prompt signals search / filter / select / tab / quantity
  if (AFFORDANCE_KEYWORDS.test(prompt)) {
    return { value: "ui-affordance", source: "prompt" };
  }

  // Single action without explicit affordance signal — assume some small
  // state (e.g., disabled flag, commit draft) via heuristic.
  if (s.actions.length >= 1) {
    return { value: "ui-affordance", source: "heuristic" };
  }

  return { value: "none", source: "contract" };
}
