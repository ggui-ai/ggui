// Axis-keyed dispatcher. Iterates the flat REGISTRY, runs each check
// whose gate matches the classification's axis vector, and accumulates
// issues.

import type { DataContract } from "@ggui-ai/protocol";
import type { Classification } from "../../classifier/index.js";
import type { EvalIssue } from "../types-public.js";
import { REGISTRY } from "./registry.js";
import { matches, type AxisCheckInput } from "./types.js";

export interface RunAxisChecksInput {
  sourceCode: string;
  compiledCode: string | null;
  contract?: DataContract;
  originalPrompt: string;
}

export function runAxisChecks(
  classification: Classification,
  input: RunAxisChecksInput,
): EvalIssue[] {
  if (input.compiledCode === null) return [];

  const axisInput: AxisCheckInput = {
    sourceCode: input.sourceCode,
    compiledCode: input.compiledCode,
    ...(input.contract !== undefined ? { contract: input.contract } : {}),
    originalPrompt: input.originalPrompt,
    classification,
  };

  const issues: EvalIssue[] = [];
  const firedIds = new Set<string>();
  for (const check of REGISTRY) {
    if (!matches(classification.vector, check)) continue;
    // Dedup by id — a check may be registered under multiple gates.
    if (firedIds.has(check.id)) continue;
    firedIds.add(check.id);
    issues.push(...check.run(axisInput));
  }
  return issues;
}
