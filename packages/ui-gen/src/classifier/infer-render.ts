// packages/ui-gen/src/classifier/infer-render.ts

import type { AxisSource, RenderShape } from "./axes";
import type { ContractSignals } from "./inspect";

interface BlueprintHint {
  mechanic?: string;
  layoutHint?: string;
}

const CHART_RX = /\b(chart|graph|trend|bar\s*graph|line\s*graph|pie)\b/i;
const TIMELINE_RX = /\b(timeline|chronolog|activity\s*feed|event\s*feed)\b/i;
// Tightened: require explicit grid/tile/column-count terminology.
// Includes bare 'grid' word (matches "grid of cards", "CSS grid", etc.)
// but is bounded to avoid matching "grid" as a substring of "background".
const GRID_RX = /\bgrid\b|\btile\s*layout\b|\b\d+\s*columns\b|\bkanban\b|\bcolumns?\s*:/i;
const MAP_RX = /\b(on\s*a\s*map|on\s*the\s*map|geo|gps|lat\/lng)\b/i;
const MASTER_DETAIL_RX =
  /\b(left\s*pane|right\s*pane|sidebar|master[- ]detail|split\s*view|two[- ]pane)\b/i;
// Tightened: 'card' and 'profile' are too generic (match weather-card,
// product-page, etc. false-positively). Only explicit card-stack phrases.
const STATIC_RX =
  /\b(card\s*stack|card\s*deck|one\s*(card|email|message|item)\s*at\s*a\s*time|full[- ]screen\s*card)\b/i;

export function inferRender(
  s: ContractSignals,
  prompt: string,
  blueprint: BlueprintHint | undefined,
): { value: RenderShape; source: AxisSource } {
  // Blueprint layoutHint — most specific
  if (blueprint?.layoutHint) {
    const hint = blueprint.layoutHint.toLowerCase();
    if (hint.includes("master-detail") || hint.includes("split"))
      return { value: "master-detail", source: "blueprint" };
    if (hint.includes("card-stack") || hint.includes("deck") || hint.includes("modal"))
      return { value: "static", source: "blueprint" };
    if (hint.includes("spatial") || hint.includes("map"))
      return { value: "spatial", source: "blueprint" };
    if (hint.includes("timeline")) return { value: "timeline", source: "blueprint" };
    if (hint.includes("chart")) return { value: "chart", source: "blueprint" };
    if (hint.includes("grid")) return { value: "grid", source: "blueprint" };
  }

  // Contract: multiple geo-coord sources → spatial
  if (s.hasGeoCoords) {
    return { value: "spatial", source: "contract" };
  }

  // Contract: entity items carry 2D grid positions → grid
  if (s.entitiesHaveGridPositions) {
    return { value: "grid", source: "contract" };
  }

  // Prompt: explicit render keywords (before structural fallback)
  if (CHART_RX.test(prompt)) return { value: "chart", source: "prompt" };
  if (TIMELINE_RX.test(prompt)) return { value: "timeline", source: "prompt" };
  if (MASTER_DETAIL_RX.test(prompt))
    return { value: "master-detail", source: "prompt" };
  if (GRID_RX.test(prompt)) return { value: "grid", source: "prompt" };
  if (MAP_RX.test(prompt) && !s.hasGeoCoords)
    return { value: "spatial", source: "prompt" };
  if (STATIC_RX.test(prompt)) return { value: "static", source: "prompt" };

  // Contract fallbacks
  if (s.entityLists.length === 0) {
    return { value: "static", source: "contract" };
  }
  // Weather-card-like: scalars dominate the single arr<obj> sub-list.
  if (s.entityLists.length === 1 && s.topLevelScalarCount >= 4) {
    return { value: "static", source: "contract" };
  }
  if (s.entityLists.length >= 2) {
    return { value: "master-detail", source: "contract" };
  }
  return { value: "list", source: "contract" };
}
