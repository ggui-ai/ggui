// core/src/benchmarks/multi-sdk/fixtures/retrofit.ts
//
// Helper for retrofitting existing BenchmarkCommit entries in commits.ts
// to the BenchmarkFixture shape — without duplicating contract / prompt /
// props literals. Fixtures for existing commits pass only the new fields
// (expected, evalGoals, whyNotReducible) and inherit the rest.

import { getBenchmarkCommit } from "../commits";
import type { BenchmarkFixture } from "./types";

export function retrofit(
  id: string,
  extra: Pick<BenchmarkFixture, "expected" | "evalGoals" | "whyNotReducible"> & {
    blueprint?: BenchmarkFixture["blueprint"];
  },
): BenchmarkFixture {
  const base = getBenchmarkCommit(id);
  if (!base) {
    throw new Error(`[fixtures/retrofit] commit "${id}" not found in commits.ts`);
  }
  return {
    id: base.id,
    name: base.name,
    description: base.description,
    complexity: base.complexity,
    expectedMinScore: base.expectedMinScore ?? 60,
    shellType: (base.shellType as BenchmarkFixture["shellType"]) ?? "fullscreen",
    screen: (base.screen as BenchmarkFixture["screen"]) ?? "universal",
    prompt: base.prompt,
    contract: base.contract,
    props: (base.props ?? {}) as Record<string, unknown>,
    blueprint: extra.blueprint,
    expected: extra.expected,
    evalGoals: extra.evalGoals,
    whyNotReducible: extra.whyNotReducible,
  };
}
