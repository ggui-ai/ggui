// Axis-keyed dispatcher. Iterates the flat REGISTRY, runs each check
// whose gate matches the classification's axis vector, and accumulates
// issues.

import type { DataContract } from "@ggui-ai/protocol";
import type { Classification } from "../../classifier/index.js";
import type { EvalIssue } from "../types-public.js";
import { REGISTRY } from "./registry.js";
import { matches, type AxisCheck, type AxisCheckInput } from "./types.js";
import { axisCheckTraceEnabled } from "./helpers.js";
import { createHash } from "node:crypto";
import type { CanvasClass, DesignMode } from "../../design-mode.js";

export interface RunAxisChecksInput {
  sourceCode: string;
  compiledCode: string | null;
  contract?: DataContract;
  originalPrompt: string;
  /** Which triad produced the source — see `AxisCheckInput.designMode`. */
  designMode?: DesignMode;
  /** The canvas the source is judged for — see `AxisCheckInput.canvas` (ggui#1117); absent = no rendering context. */
  canvas?: CanvasClass;
}

export function runAxisChecks(
  classification: Classification,
  input: RunAxisChecksInput,
): EvalIssue[] {
  const facts: AxisTraceFacts = {
    sourceCode: input.sourceCode,
    ...(input.contract !== undefined ? { contract: input.contract } : {}),
    originalPrompt: input.originalPrompt,
    classification,
    ...(input.designMode !== undefined ? { designMode: input.designMode } : {}),
    ...(input.canvas !== undefined ? { canvas: input.canvas } : {}),
  };
  if (input.compiledCode === null) {
    traceAxisChecksSkipped(facts, "compiledCode null — no check ran");
    return [];
  }
  const axisInput: AxisCheckInput = { ...facts, compiledCode: input.compiledCode };
  return runGatedAxisChecks(
    REGISTRY.filter((check) => matches(classification.vector, check)),
    axisInput,
  ).issues;
}

export interface AxisRunResult {
  readonly issues: EvalIssue[];
  /** Check ids run, in registry order, each once. */
  readonly firedIds: string[];
}

/**
 * Run a PRE-GATED list of checks once each — the one runner the served
 * loop (`run-check.ts`, over the harness's pre-filtered `axisChecks`) and
 * `runAxisChecks` (gate + run) share, so the ggui#1046 trace line prints on
 * both paths.
 */
export function runGatedAxisChecks(checks: readonly AxisCheck[], input: AxisCheckInput): AxisRunResult {
  const issues: EvalIssue[] = [];
  const firedIds: string[] = [];
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.id)) continue;
    seen.add(check.id);
    firedIds.push(check.id);
    issues.push(...check.run(input));
  }
  if (axisCheckTraceEnabled()) {
    const line: AxisCheckTrace = {
      ...traceFacts(input),
      matched: [...firedIds],
      issues: issues.map((i) => ({ id: i.subcategory ?? i.category, result: i.result })),
    };
    console.log(JSON.stringify({ axisCheckTrace: line }));
  }
  return { issues, firedIds };
}

/** The dispatcher's line for a round where no check could run (a null compile), flag-gated like the rest. */
export function traceAxisChecksSkipped(facts: AxisTraceFacts, note: string): void {
  if (!axisCheckTraceEnabled()) return;
  const line: AxisCheckTrace = { ...traceFacts(facts), matched: [], issues: [], note };
  console.log(JSON.stringify({ axisCheckTrace: line }));
}

/** The input facts a round's verdict is built from — `AxisCheckInput` minus the compile. */
export type AxisTraceFacts = Omit<AxisCheckInput, "compiledCode">;

/** One trace line per round (ggui#1046): the input facts a verdict was built from, the gates that matched, the issues that came out. */
export interface AxisCheckTrace {
  readonly sourceSha256: string;
  readonly originalPrompt: string;
  readonly designMode: string;
  readonly classification: Classification["vector"];
  readonly propsSpecKeys: readonly string[];
  readonly propsSpecPropertyKeys: readonly string[];
  /** The canvas the verdict was built for (ggui#1117) — present only when the input carried one. */
  readonly canvas?: CanvasClass;
  readonly matched: readonly string[];
  readonly issues: ReadonlyArray<{ readonly id: string; readonly result: EvalIssue["result"] }>;
  readonly note?: string;
}

function traceFacts(input: AxisTraceFacts): Omit<AxisCheckTrace, "matched" | "issues"> {
  const propsSpec = input.contract?.propsSpec;
  return {
    sourceSha256: createHash("sha256").update(input.sourceCode, "utf8").digest("hex"),
    originalPrompt: input.originalPrompt,
    designMode: input.designMode ?? "constrained",
    classification: input.classification.vector,
    propsSpecKeys: Object.keys(propsSpec ?? {}),
    propsSpecPropertyKeys: Object.keys(propsSpec?.properties ?? {}),
    // No default here, unlike designMode: an absent canvas is a fact about the caller, not a guess to paper over.
    ...(input.canvas !== undefined ? { canvas: input.canvas } : {}),
  };
}
