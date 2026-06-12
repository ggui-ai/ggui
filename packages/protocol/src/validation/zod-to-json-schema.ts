/**
 * zod → {@link JsonSchema} conversion, normalized to the shape our
 * {@link isSchemaSubset} algorithm accepts.
 *
 * **Why zod's built-in vs. the `zod-to-json-schema` package.** That
 * library only understands zod v3 internals — passing a zod v4 schema
 * yields an empty `{$schema}` document. The protocol package is on
 * zod v4, which ships its own built-in `z.toJSONSchema()` helper that
 * produces correct JSON Schema output for every construct we care
 * about. The wrapper below normalizes the v4 output — draft-2020-12
 * by default, plus a small handful of zod-specific quirks — onto the
 * {@link JsonSchema} shape the subset algorithm consumes.
 *
 * **Normalizations applied.**
 *
 *   1. Strip the top-level `$schema` URI. Our {@link JsonSchema} does
 *      not carry it, and the subset algorithm's "unsupported
 *      constructs" flagging would treat unknown top-level keys as
 *      surprises. `$schema` is metadata, not structure.
 *   2. Preserve draft-2020-12 `additionalProperties: {}` (zod emits
 *      this for `.passthrough()`) as `additionalProperties: {}` —
 *      the subset algorithm treats the empty-schema case as a
 *      structured-but-unconstrained extras slot. Callers that want
 *      "strictly true" must convert explicitly.
 *   3. Leave `anyOf` / `const` / `enum` shapes intact. The subset
 *      algorithm flags them as P1/P2 deferred constructs — the
 *      caller receives an honest `unsupported` violation rather
 *      than a silent pass.
 *   4. `z.any()` / `z.unknown()` produce an empty schema (no keys).
 *      The subset algorithm treats an empty schema as a wildcard
 *      (matches `isSchemaSubset(..., {type: 'string'})` as
 *      compatible), which mirrors JSON Schema semantics.
 *
 * **Intended call sites.**
 *
 *   - render-time + blueprint-registration schema-compat checks in
 *     `@ggui-ai/mcp-server`: a mount-registered tool handler exposes
 *     its `inputSchema` as a {@link ZodRawShape}; wrapping it in
 *     `z.object(shape)` and converting gives the JsonSchema that
 *     pairs against the declared `actionSpec[name].schema`.
 *   - Ad-hoc authoring tools (e.g. console panels) that need a
 *     human-readable JSON shape for a zod definition.
 *
 * @see ./schema-subset.ts
 */
import { z, type ZodRawShape, type ZodType } from 'zod';
import type { JsonSchema } from '../types/data-contract.js';
import { isRecord } from './is-record.js';

/**
 * Convert a zod schema (or raw shape) to a {@link JsonSchema} suitable
 * for the subset algorithm.
 *
 * - Pass a `ZodType` to convert it directly.
 * - Pass a {@link ZodRawShape} (the raw `{ key: ZodType, ... }` map
 *   shape {@link SharedHandler.inputSchema} carries) to have it
 *   wrapped in `z.object(...)` before conversion.
 *
 * Never throws on legitimate input. If zod's native emitter returns
 * a non-object (it shouldn't for any supported construct), we coerce
 * to an empty schema `{}` so downstream comparison treats it as
 * unconstrained.
 */
export function zodToJsonSchema(input: ZodType | ZodRawShape): JsonSchema {
  const schema = isZodType(input) ? input : z.object(input);
  // zod v4's native emitter returns a plain JSON-Schema-shaped object.
  // `z.toJSONSchema` is typed as `unknown` when narrowed by our
  // JsonSchema; cast + normalize.
  const raw = z.toJSONSchema(schema) as unknown as Record<string, unknown>;
  if (raw === null || typeof raw !== 'object') return {};
  return normalize(raw) as JsonSchema;
}

/**
 * Strip zod / draft-2020-12 quirks the subset algorithm doesn't
 * consume, recursively. Does NOT strip unsupported constructs
 * (oneOf/anyOf/enum/const/$ref/allOf) — those surface as explicit
 * `unsupported` violations from the subset algorithm, which is what
 * we want.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === '$schema') continue;
    if (key === 'properties' && isRecord(v)) {
      const props: Record<string, unknown> = {};
      for (const [pkey, pval] of Object.entries(v)) {
        props[pkey] = normalize(pval);
      }
      out[key] = props;
      continue;
    }
    if (key === 'additionalProperties') {
      if (typeof v === 'boolean') {
        out[key] = v;
      } else {
        out[key] = normalize(v);
      }
      continue;
    }
    if (key === 'items') {
      out[key] = normalize(v);
      continue;
    }
    out[key] = normalize(v);
  }
  return out;
}

/**
 * Discriminator between `ZodType` and `ZodRawShape`. Zod v4 schemas
 * carry a `_def` field (via the internal def bag). A raw shape is a
 * plain object with string keys mapping to ZodType instances. We
 * check for the presence of a ZodType marker to distinguish; absence
 * means treat as raw shape.
 */
function isZodType(value: ZodType | ZodRawShape): value is ZodType {
  if (value === null || typeof value !== 'object') return false;
  // Every zod v4 schema has `parse` and `_def`. A raw shape — a plain
  // object of ZodType values — does not.
  const bag = value as unknown as Record<string, unknown>;
  return typeof bag['parse'] === 'function' && '_def' in bag;
}
