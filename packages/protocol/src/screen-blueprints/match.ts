/**
 * Blueprint matcher — pure algorithm.
 *
 * Given a list of candidate `McpScreenBlueprint` rows (retrieved from DDB
 * via `byPrimaryDataTool` GSI) and the agent's `sourceTools`, return the
 * best matching blueprint.
 *
 * I/O-free. The DDB query layer lives in `core/src/blueprint-matcher.ts`;
 * that module's only job is fetching candidates and calling this function.
 */
import type { BlueprintSource, BlueprintSourceKind } from "../types/blueprint-source.js";

/** Subset of `McpScreenBlueprintRow` the matcher needs. Keeps tests isolated. */
export interface MatchableBlueprint {
  blueprintId: string;
  serverId: string;
  dataTools: string[];
  status: "active" | "stale" | "retired";
  /**
   * Provenance ({@link BlueprintSource}). Required — rows reach the
   * matcher through a validating narrower at the storage boundary, so
   * an unlabeled candidate is dropped there, never defaulted here.
   */
  source: BlueprintSource;
  /** Engagement / selection rate populated by the ranker. Undefined = 0. */
  score?: number;
}

/** Match score. Higher is better. */
interface ScoredMatch<T> {
  blueprint: T;
  overlap: number;
  rankScore: number;
}

/**
 * Source weights — hand-authored designs outrank generated ones when
 * everything else ties. Matches the spec: "curated generally wins when
 * everything else ties — because a human made a design call." `user`
 * (developer-registered) is the same trust class: a human made the
 * design call there too.
 */
const SOURCE_WEIGHT: Record<BlueprintSourceKind, number> = {
  curated: 3,
  user: 3,
  llm: 2,
};

/**
 * Select the best-matching blueprint from `candidates` given the agent's
 * `sourceTools`. Returns `null` if no candidate's `dataTools` is a subset
 * of `sourceTools`.
 *
 * Subset match semantics: the agent can bring extra tools. A blueprint
 * matches if every one of its `dataTools` appears in `sourceTools`.
 *
 * Ranking: `overlap × source_weight × (score || 1)`. Overlap is the blueprint's
 * dataTools count (all must match to be a candidate, so higher counts signal
 * more-specific blueprints). Ties broken by stable input order.
 */
export function matchBlueprint<T extends MatchableBlueprint>(
  candidates: readonly T[],
  sourceTools: readonly string[],
): T | null {
  if (sourceTools.length === 0 || candidates.length === 0) return null;
  const available = new Set(sourceTools);

  const scored: ScoredMatch<T>[] = [];
  for (const bp of candidates) {
    if (bp.status !== "active") continue;
    if (!isSubset(bp.dataTools, available)) continue;
    const overlap = bp.dataTools.length;
    const weight = SOURCE_WEIGHT[bp.source.kind];
    const score = bp.score ?? 1;
    scored.push({ blueprint: bp, overlap, rankScore: overlap * weight * score });
  }

  if (scored.length === 0) return null;

  // Stable sort: highest rankScore first, preserving input order on ties.
  scored.sort((a, b) => b.rankScore - a.rankScore);
  return scored[0].blueprint;
}

/** `needles ⊆ haystack` — every element of `needles` appears in `haystack`. */
function isSubset(needles: readonly string[], haystack: ReadonlySet<string>): boolean {
  for (const n of needles) {
    if (!haystack.has(n)) return false;
  }
  return true;
}
