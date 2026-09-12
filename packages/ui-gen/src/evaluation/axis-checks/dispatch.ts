// Axis-keyed dispatcher. Iterates the flat REGISTRY, runs each check
// whose gate matches the classification's axis vector, and accumulates
// issues.

import type { DataContract } from "@ggui-ai/protocol";
import type { Classification } from "../../classifier/index.js";
import type { EvalIssue } from "../types-public.js";
import { REGISTRY } from "./registry.js";
import { matches, type AxisCheckInput } from "./types.js";
import { axisCheckTraceEnabled } from "./helpers.js";
import { createHash } from "node:crypto";
import type { DesignMode } from "../../design-mode.js";

export interface RunAxisChecksInput {
  sourceCode: string;
  compiledCode: string | null;
  contract?: DataContract;
  originalPrompt: string;
  /** Which triad produced the source — see `AxisCheckInput.designMode`. */
  designMode?: DesignMode;
}

export function runAxisChecks(
  classification: Classification,
  input: RunAxisChecksInput,
): EvalIssue[] {
  if (input.compiledCode === null) {
    if (axisCheckTraceEnabled()) {
      const line: AxisCheckTrace = { ...traceFacts(classification, input), matched: [], issues: [], note: "compiledCode null — no check ran" };
      console.log(JSON.stringify({ axisCheckTrace: line }));
    }
    return [];
  }

  const axisInput: AxisCheckInput = {
    sourceCode: input.sourceCode,
    compiledCode: input.compiledCode,
    ...(input.contract !== undefined ? { contract: input.contract } : {}),
    originalPrompt: input.originalPrompt,
    classification,
    ...(input.designMode !== undefined ? { designMode: input.designMode } : {}),
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
  if (axisCheckTraceEnabled()) {
    const line: AxisCheckTrace = {
      ...traceFacts(classification, input),
      matched: [...firedIds],
      issues: issues.map((i) => ({ id: i.subcategory ?? i.category, result: i.result })),
    };
    console.log(JSON.stringify({ axisCheckTrace: line }));
  }
  return issues;
}

/** One trace line per round (ggui#1046): the input facts a verdict was built from, the gates that matched, the issues that came out. */
export interface AxisCheckTrace {
  readonly sourceSha256: string;
  readonly originalPrompt: string;
  readonly designMode: string;
  readonly classification: Classification["vector"];
  readonly propsSpecKeys: readonly string[];
  readonly propsSpecPropertyKeys: readonly string[];
  readonly matched: readonly string[];
  readonly issues: ReadonlyArray<{ readonly id: string; readonly result: EvalIssue["result"] }>;
  readonly note?: string;
}

function traceFacts(classification: Classification, input: RunAxisChecksInput): Omit<AxisCheckTrace, "matched" | "issues"> {
  const propsSpec = input.contract?.propsSpec;
  return {
    sourceSha256: createHash("sha256").update(input.sourceCode, "utf8").digest("hex"),
    originalPrompt: input.originalPrompt,
    designMode: input.designMode ?? "constrained",
    classification: classification.vector,
    propsSpecKeys: Object.keys(propsSpec ?? {}),
    propsSpecPropertyKeys: Object.keys(propsSpec?.properties ?? {}),
  };
}
