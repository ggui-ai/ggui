// packages/ui-gen/src/classifier/infer-writes.ts

import type { AxisSource, WriteShape } from "./axes";
import type { ContractSignals } from "./inspect";

export function inferWrites(
  s: ContractSignals,
): { value: WriteShape; source: AxisSource } {
  if (s.actions.length === 0) {
    return { value: "none", source: "contract" };
  }

  // Compose: one action payload references ≥ 2 different entity collections
  if (s.crossEntityAction) {
    return { value: "compose", source: "contract" };
  }

  // Per-item: actions target an entity LIST via id. Singleton id refs don't
  // count (that's just "commit on a detail view" like product-page's addToCart).
  if (s.entityListIdInPayload) {
    return { value: "per-item", source: "contract" };
  }

  // Submit: single action with multi-field payload
  if (s.actions.length === 1 && s.multiFieldSubmit) {
    return { value: "submit", source: "contract" };
  }

  // Multi-commit: multiple independent actions
  if (s.actions.length >= 2) {
    return { value: "multi-commit", source: "contract" };
  }

  return { value: "commit", source: "contract" };
}
