// packages/ui-gen/src/evaluation/axis-checks/registry.ts
//
// Flat list of all axis-gated checks. The dispatcher iterates this and
// runs every entry whose gate matches the classification's axis vector.

import type { AxisCheck } from "./types.js";
import { UNIVERSAL_CHECKS } from "./checks/universal.js";
import { STATE_MERGE_CHECKS } from "./checks/state-merge.js";
import { REALTIME_CHECKS } from "./checks/realtime.js";
import { WRITES_CHECKS } from "./checks/writes.js";
import { STATE_PAYLOAD_CHECKS } from "./checks/state-payload.js";
import { TOOLING_CHECKS } from "./checks/tooling.js";
import { EXTRA_CHECKS } from "./extras.js";

export const REGISTRY: readonly AxisCheck[] = [
  ...UNIVERSAL_CHECKS,
  ...STATE_MERGE_CHECKS,
  ...REALTIME_CHECKS,
  ...WRITES_CHECKS,
  ...STATE_PAYLOAD_CHECKS,
  ...TOOLING_CHECKS,
  ...EXTRA_CHECKS,
];
