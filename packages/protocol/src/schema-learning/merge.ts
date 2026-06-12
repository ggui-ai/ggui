/**
 * Incremental JSON Schema learning — type union over observed samples.
 *
 * Used by the Screen Designer to build `generatedOutputSchema` from real MCP tool
 * responses when the server doesn't ship a native `outputSchema`. Each captured
 * response is merged into the running schema via {@link mergeSchema}; the result
 * converges as more samples arrive.
 *
 * Algorithm:
 * - Object properties: union of keys. A property present in one sample but missing
 *   from another is marked optional (dropped from `required`).
 * - Array items: recursive merge across element schemas from all samples.
 * - Primitives of the same type: identity.
 * - `null` + any type: sets `nullable: true` on that type.
 * - Type conflicts (e.g. string + number): collapsed into `anyOf`.
 *
 * Pure — no I/O, no DB, no clock. Safe to call from Lambda, edge, or tests.
 */
import type { JsonObject, JsonSchema, JsonValue } from "../types/data-contract.js";
import { isRecord } from "../validation/is-record.js";

/** Infer a JSON Schema from a single JSON value. */
export function inferSchema(value: JsonValue): JsonSchema {
  if (value === null) return { type: "null" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number" };
  }
  if (typeof value === "string") return { type: "string" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array" };
    // Fold all elements into a single item schema.
    let items = inferSchema(value[0]);
    for (let i = 1; i < value.length; i++) {
      items = mergeTwoSchemas(items, inferSchema(value[i]));
    }
    return { type: "array", items };
  }
  // Object
  const obj = value as JsonObject;
  const keys = Object.keys(obj);
  const properties: Record<string, JsonSchema> = {};
  for (const k of keys) {
    properties[k] = inferSchema(obj[k] as JsonValue);
  }
  return {
    type: "object",
    properties,
    required: keys.slice().sort(),
  };
}

/**
 * Merge a new observed sample into an existing schema. If `existing` is null,
 * returns the schema inferred from `sample` alone.
 */
export function mergeSchema(existing: JsonSchema | null | undefined, sample: JsonValue): JsonSchema {
  const inferred = inferSchema(sample);
  if (!existing) return inferred;
  return mergeTwoSchemas(existing, inferred);
}

/**
 * Merge two schemas into one that accepts values satisfying either. Exported
 * for the seeder path (combining two known schemas without sampling).
 */
export function mergeTwoSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  // null + X → X nullable
  if (a.type === "null" && b.type !== "null") return withNullable(b);
  if (b.type === "null" && a.type !== "null") return withNullable(a);
  if (a.type === "null" && b.type === "null") return { type: "null" };

  // Same type — structural merge.
  if (a.type === b.type) {
    if (a.type === "object") return mergeObjects(a, b);
    if (a.type === "array") return mergeArrays(a, b);
    // Primitives — keep a's metadata as the canonical one; carry nullability forward.
    const merged: JsonSchema = { type: a.type };
    if (a.nullable || b.nullable) merged.nullable = true;
    if (a.format && b.format && a.format === b.format) merged.format = a.format;
    return merged;
  }

  // integer + number → number (widen)
  if ((a.type === "integer" && b.type === "number") || (a.type === "number" && b.type === "integer")) {
    const merged: JsonSchema = { type: "number" };
    if (a.nullable || b.nullable) merged.nullable = true;
    return merged;
  }

  // Conflicting types — union via anyOf.
  return { anyOf: dedupeAnyOf([...flattenAnyOf(a), ...flattenAnyOf(b)]) };
}

function mergeObjects(a: JsonSchema, b: JsonSchema): JsonSchema {
  const aProps = a.properties ?? {};
  const bProps = b.properties ?? {};
  const allKeys = new Set<string>([...Object.keys(aProps), ...Object.keys(bProps)]);
  const merged: Record<string, JsonSchema> = {};
  for (const k of allKeys) {
    const pa = aProps[k];
    const pb = bProps[k];
    if (pa && pb) merged[k] = mergeTwoSchemas(pa, pb);
    else merged[k] = (pa ?? pb)!;
  }
  // Required = intersection. A field missing from either sample cannot be required.
  const aReq = new Set(a.required ?? []);
  const bReq = b.required ?? [];
  const requiredSet = new Set<string>();
  for (const k of bReq) if (aReq.has(k)) requiredSet.add(k);
  const required = Array.from(requiredSet).sort();

  const out: JsonSchema = { type: "object", properties: merged };
  if (required.length > 0) out.required = required;
  if (a.nullable || b.nullable) out.nullable = true;
  return out;
}

function mergeArrays(a: JsonSchema, b: JsonSchema): JsonSchema {
  const items = a.items && b.items ? mergeTwoSchemas(a.items, b.items) : (a.items ?? b.items);
  const out: JsonSchema = { type: "array" };
  if (items) out.items = items;
  if (a.nullable || b.nullable) out.nullable = true;
  return out;
}

function withNullable(s: JsonSchema): JsonSchema {
  if (s.nullable) return s;
  return { ...s, nullable: true };
}

function flattenAnyOf(s: JsonSchema): JsonSchema[] {
  if (s.anyOf && s.anyOf.length > 0) return s.anyOf.slice();
  return [s];
}

function dedupeAnyOf(list: JsonSchema[]): JsonSchema[] {
  const seen = new Map<string, JsonSchema>();
  for (const s of list) {
    const key = canonicalKey(s);
    if (!seen.has(key)) seen.set(key, s);
  }
  return Array.from(seen.values());
}

/** Deterministic stable key — recursive, sorts object keys at every depth. */
function canonicalKey(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalKey).join(",") + "]";
  if (!isRecord(v)) return JSON.stringify(v);
  const obj = v;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalKey(obj[k])).join(",") + "}";
}
