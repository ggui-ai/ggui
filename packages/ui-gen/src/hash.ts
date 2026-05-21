// packages/ui-gen/src/hash.ts
//
// Deterministic fingerprint helpers for harness composition. Two inputs
// that are structurally equivalent hash to the same 12-char prefix; two
// different inputs hash to different prefixes.
//
// Used for:
//  - Harness id attribution (log + benchmark cell tagging)
//  - Prompt-cache key reuse
//  - Comparison-validity checks when benchmarking harness variants
//
// The `stableStringify` + `shortHash` primitives are private
// implementation detail of this module.

import { createHash } from "node:crypto";
import type { Classification } from "./classifier/axes.js";

// ─── Private primitives ────────────────────────────────────────────────────
// Not exported — these are implementation detail. If an external consumer
// needs a stable hash of arbitrary data, they should do it themselves.

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${parts.join(",")}}`;
  }
  return "null";
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

// ─── Public surface ────────────────────────────────────────────────────────

/** Hash a classification — used as a sub-component of the harness id. */
export function hashClassification(c: Classification): string {
  return shortHash(stableStringify({ vector: c.vector, riskTier: c.riskTier }));
}

/**
 * Compute a harness id from the materialized pieces. Called by `createHarness`
 * after all legs are built.
 *
 * Hashes only the stable content — not function references (applyPatch,
 * planner, etc.) because function identity isn't serializable. Instead,
 * version tags bump when semantics change.
 */
export function computeHarnessId(input: {
  classificationHash: string;
  howVersion: string;
  whatVersion: string;
  checkVersion: string;
  processVersion: string;
  workflowId: string;
  fragmentIds: readonly string[];
  overrides: readonly string[];
}): string {
  return shortHash(stableStringify(input));
}

/**
 * Human-readable harness name. Deterministic but informative — derives from
 * classification + workflow without needing to look up the id.
 */
export function computeHarnessName(input: {
  classification: Classification;
  workflowName: string;
  version: string;
}): string {
  const v = input.classification.vector;
  const dominantAxes: string[] = [];
  if (v.state !== "none") dominantAxes.push(`state=${v.state}`);
  if (v.writes !== "none") dominantAxes.push(`writes=${v.writes}`);
  if (v.realtime !== "none") dominantAxes.push(`realtime=${v.realtime}`);
  if (v.tooling !== "none") dominantAxes.push(`tooling=${v.tooling}`);
  const axesPart = dominantAxes.length > 0 ? dominantAxes.join("+") : "passive";
  return `${input.version}/${axesPart}/${input.workflowName}`;
}
