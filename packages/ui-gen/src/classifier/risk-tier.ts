// packages/ui-gen/src/classifier/risk-tier.ts

import type { AxisVector, RiskTier } from "./axes";

/**
 * Derive risk tier from an AxisVector. Policy, not description — drives the
 * eval loop's depth and repair budget. Kept coarse and easy to revise.
 *
 * See AXIS_VECTOR_SKETCH.md §riskTier.
 */
export function deriveRiskTier(v: AxisVector): RiskTier {
  // High auto-promotions: ggui's moat scenarios
  if (v.writes === "compose") return "high";
  if (v.writeTrigger === "drag" || v.writeTrigger === "swipe") return "high";
  if (v.realtime === "mixed") return "high";
  if (v.render === "spatial" && v.realtime !== "none") return "high";
  if (v.state === "merge" && v.writes === "per-item") return "high";

  // The tooling axis is intentionally NOT a tier-promotion input.
  // Combos like tooling=both + state=merge might deserve "high", but
  // tier promotion costs staged-process turns on every affected
  // generation — premature without a concrete observed regression.
  // Revisit if a tooling-heavy fixture underperforms on the medium tier.

  // Low: tightened pure-passive rule (matches display bypass)
  if (
    (v.state === "none" || v.state === "ui-affordance") &&
    v.writes === "none" &&
    v.realtime === "none" &&
    v.fetch === "none"
  ) {
    return "low";
  }

  return "medium";
}
