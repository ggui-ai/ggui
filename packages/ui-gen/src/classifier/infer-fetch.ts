// packages/ui-gen/src/classifier/infer-fetch.ts

import type { AxisSource, FetchShape } from "./axes";
import type { ContractSignals } from "./inspect";

const PAGINATION_KEYS = new Set([
  "cursor",
  "offset",
  "page",
  "before",
  "after",
  "limit",
  "pageSize",
]);
const SEARCH_KEYS = new Set(["query", "q", "search", "keyword"]);

export function inferFetch(
  s: ContractSignals,
): { value: FetchShape; source: AxisSource } {
  // clientCapabilities are browser-capability hooks, not data-fetch.
  // Only agentTools participate in fetch classification.
  if (s.agentTools.length === 0) {
    return { value: "none", source: "contract" };
  }

  const tools = s.agentTools;

  for (const tool of tools) {
    for (const key of tool.requestKeys) {
      if (PAGINATION_KEYS.has(key)) return { value: "pagination", source: "contract" };
    }
  }

  for (const tool of tools) {
    for (const key of tool.requestKeys) {
      if (SEARCH_KEYS.has(key)) return { value: "search", source: "contract" };
    }
  }

  // Drill-down: any `id` key, any `*Id` suffix key, or any key matching
  // an entity's idField (e.g., `symbol` for stocks). Loose on purpose so
  // fetch tools targeting a specific entity are caught regardless of
  // whether the entity is in top-level props.
  const entityIdFields = new Set(s.entityLists.map((e) => e.idField));
  for (const tool of tools) {
    for (const key of tool.requestKeys) {
      if (key === "id") return { value: "drill-down", source: "contract" };
      if (/Id$/.test(key) && key.length > 2) {
        return { value: "drill-down", source: "contract" };
      }
      if (entityIdFields.has(key)) {
        return { value: "drill-down", source: "contract" };
      }
    }
  }

  return { value: "refresh", source: "contract" };
}
