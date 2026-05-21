// Harness-level hash helpers. The three Harness-type-free helpers
// (`hashClassification`, `computeHarnessId`, `computeHarnessName`) live
// in `@ggui-ai/ui-gen/hash`; this file re-exports them so `./hash.js`
// imports within the harness module keep working.
//
// `hashHarness` lives here because it reads the `Harness` type.

import type { Harness } from "./types-public.js";

export {
  hashClassification,
  computeHarnessId,
  computeHarnessName,
} from "../hash.js";

/**
 * Fingerprint a materialized Harness. `h.id` is already a deterministic
 * hash of the load-bearing construction inputs (classification +
 * leg versions + fragments + overrides), so equality of `hashHarness(a)`
 * and `hashHarness(b)` is equivalent to equality of `a.id` and `b.id`.
 */
export function hashHarness(h: Harness): string {
  return h.id;
}
