/**
 * ENFORCED PROPS SCHEMA — the wire artifact of the schema-precise
 * render arc (P1, docs/plans/2026-08-19-schema-precise-render.md;
 * shape frozen 2026-08-19 per the P3 consumer review, guuey#271).
 *
 * `buildEnforcedPropsSchema(propsSpec)` produces the EXACT JSON Schema
 * the paired `ggui_render` enforces for a handshake — the same
 * synthesis (`buildPropsWrapperSchema`) and the same closed-shape
 * injection (`injectClosedShape`) the render-time validator compiles,
 * with the emission normalizations applied IN the bytes:
 *
 *   - `additionalProperties: false` materialized at every object node
 *     (render injects it at Ajv compile; the wire artifact carries it
 *     explicitly so a consumer reading the schema sees the enforced
 *     closed shape, not a pre-injection approximation).
 *   - `nullable: true` rewritten to the canonical `type: [X, 'null']`
 *     union (the validating engine type-widens on `nullable`; a strict
 *     reader of the emitted schema must see the same acceptance).
 *   - Metadata keywords that are no-ops at the emission layer
 *     (`example`, `nullable`) stripped — they are non-standard at this
 *     layer and can fail a strict downstream compiler.
 *   - Constructed in canonical key order (sorted at every schema
 *     node), so the serialized value is byte-stable across authors'
 *     key ordering and across handshakes of the same contract —
 *     load-bearing for consumer compile caches keyed on the bytes.
 *
 * Canonical bytes are RFC 8785 (JCS) — the SAME standard the
 * `contractHash` pipeline pins (`registry/canonicalize-contract.ts`),
 * so an external implementation reproduces them with any JCS library.
 * The hash over those bytes lives server-side at
 * `@ggui-ai/protocol/props-schema-hash` (node:crypto — the
 * `blueprint-key` subpath convention).
 *
 * `classifyPropsSchemaProfile` implements the frozen profile rule
 * (pins 4+5): purely SYNTACTIC membership — a schema is
 * `'grammar-safe'` iff every keyword appearing at any schema node is
 * in {@link GRAMMAR_SAFE_KEYWORDS}, every `format` value is in
 * {@link GRAMMAR_SAFE_FORMATS}, and every `additionalProperties` is
 * the literal `false`. Anything else is `'full'` — the consumer falls
 * back to schema-as-context instead of grammar compilation. Consumers
 * MUST treat unknown profile values as `'full'` (new profiles are
 * additive minors).
 */
import canonicalize from 'canonicalize';
import type { JsonSchema, PropsSpec } from '../types/data-contract.js';
import { buildPropsWrapperSchema } from './contract-validator.js';
import { injectClosedShape } from './ajv-runtime.js';

/** Frozen wire values for the handshake's `propsSchemaProfile` field. */
export type PropsSchemaProfile = 'grammar-safe' | 'full';

/**
 * The grammar-safe core — the closed keyword set a `'grammar-safe'`
 * schema may use (P3 pin 4; purely syntactic). `aliases` is enumerated
 * now (it is the P4 in-contract alias keyword) so arming P4 needs no
 * grammar change; until P4 ships it simply never appears in emitted
 * bytes.
 */
export const GRAMMAR_SAFE_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'oneOf',
  'anyOf',
  'format',
  'description',
  'title',
  'aliases',
]);

/**
 * The restricted `format` vocabulary admitted to the grammar-safe core
 * (P3 pin 5). A consumer grammar MAY enforce any subset its engine
 * supports; unenforced formats remain server-validated — AUTHORITY is
 * one-directional, so an under-enforcing grammar is safe. A schema
 * carrying a format outside this list classifies `'full'`.
 */
export const GRAMMAR_SAFE_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/**
 * RFC 8785 (JCS) serialization of a props schema — the canonical
 * bytes `propsSchemaHash` is computed over, and the byte form the
 * emitted `propsSchema` value is constructed to match. Consumers
 * verify by re-canonicalizing the received value with any JCS
 * library and hashing — raw received bytes are equivalent whenever
 * the transport preserves key order (JS enumeration reorders
 * integer-like property names, so re-canonicalization is the
 * guaranteed path).
 */
export function canonicalPropsSchemaBytes(schema: JsonSchema): string {
  return canonicalize(schema) ?? '{}';
}

/**
 * Schema-position-aware canonical rebuild of one node: strips
 * emission-layer metadata keywords, rewrites `nullable`, recurses into
 * the schema-valued positions (`properties` values, `items`,
 * schema-valued `additionalProperties`, `oneOf`/`anyOf` branches), and
 * inserts keys in sorted order. Data-valued positions (`enum` members,
 * `const`, `default`) pass through verbatim — they are values, not
 * schemas, and JCS canonicalizes their serialization regardless of
 * construction order.
 */
function canonicalizeSchemaNode(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  const nullableWidens =
    node.nullable === true && typeof node.type === 'string';
  for (const key of Object.keys(node).sort()) {
    if (key === 'example' || key === 'nullable') continue;
    const value = node[key];
    if (key === 'type') {
      const t = node.type;
      if (nullableWidens && typeof t === 'string') {
        out.type = [t, 'null'];
      } else if (node.nullable === true && Array.isArray(t)) {
        out.type = t.includes('null') ? [...t] : [...t, 'null'];
      } else {
        out.type = t;
      }
      continue;
    }
    if (key === 'properties' && isSchemaMap(value)) {
      const props: Record<string, JsonSchema> = {};
      for (const name of Object.keys(value).sort()) {
        props[name] = canonicalizeSchemaNode(value[name]!);
      }
      out.properties = props;
      continue;
    }
    if (key === 'items' && isSchemaValue(value)) {
      out.items = canonicalizeSchemaNode(value);
      continue;
    }
    if (key === 'additionalProperties' && isSchemaValue(value)) {
      out.additionalProperties = canonicalizeSchemaNode(value);
      continue;
    }
    if (key === 'oneOf' || key === 'anyOf') {
      const branches = key === 'oneOf' ? node.oneOf : node.anyOf;
      if (branches !== undefined) {
        out[key] = branches.map(canonicalizeSchemaNode);
        continue;
      }
    }
    if (key === 'required' && Array.isArray(node.required)) {
      // `required` is SET-semantics in JSON Schema — member order never
      // affects validation — but it is an ARRAY on the wire, and JCS
      // rightly preserves array order while sorting only object keys.
      // The wrapper's `required` is derived from properties ITERATION
      // order, an order-unstable source (a DynamoDB Map round-trip
      // legally reorders object keys), so without this sort one
      // contract stored under two representations rebuilt to two
      // different propsSchemaHashes (production incident 2026-08-20:
      // ca204076… vs d130e5b9… for the same Deskly contract). Sorting
      // here — for derived AND authored arrays at every depth — makes
      // the canonical bytes (and therefore the hash) canonical over the
      // keyword's actual semantics.
      out.required = [...node.required].sort();
      continue;
    }
    out[key] = value;
  }
  return out;
}

function isSchemaValue(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchemaMap(value: unknown): value is Record<string, JsonSchema> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isSchemaValue)
  );
}

/**
 * Build the enforced props schema for a {@link PropsSpec} — the exact
 * schema `ggui_render` compiles and validates against for the paired
 * handshake, in emission form (closed shape materialized, `nullable`
 * rewritten, metadata keywords stripped, canonical key order).
 *
 * An empty / degenerate spec yields the empty closed wrapper
 * `{additionalProperties:false, properties:{}, required:[], type:'object'}`
 * — never omitted for a non-declined handshake: under it, any
 * non-empty props are invalid, which makes the props-without-propsSpec
 * rejection schema-derivable and the accept-path drop documented
 * leniency (one-directional AUTHORITY).
 *
 * `injectClosedShape` is idempotent, so compiling this pre-injected
 * tree (`compileForValidation`) enforces byte-identical semantics to
 * `validatePropsData` over the source spec — the AUTHORITY property
 * the conformance kit's drift fixture pins.
 */
export function buildEnforcedPropsSchema(spec: PropsSpec): JsonSchema {
  return canonicalizeSchemaNode(
    injectClosedShape(buildPropsWrapperSchema(spec)),
  );
}

/**
 * Classify an (emission-form) props schema against the grammar-safe
 * core — P3 pins 4+5. Purely syntactic; the conformance kit's profile
 * fixture asserts the wire flag agrees with this reference checker.
 */
export function classifyPropsSchemaProfile(
  schema: JsonSchema,
): PropsSchemaProfile {
  for (const key of Object.keys(schema)) {
    if (!GRAMMAR_SAFE_KEYWORDS.has(key)) return 'full';
    const value = schema[key];
    if (key === 'format') {
      if (typeof value !== 'string' || !GRAMMAR_SAFE_FORMATS.has(value)) {
        return 'full';
      }
      continue;
    }
    if (key === 'additionalProperties') {
      if (value !== false) return 'full';
      continue;
    }
    if (key === 'properties' && isSchemaMap(value)) {
      for (const nested of Object.values(value)) {
        if (classifyPropsSchemaProfile(nested) === 'full') return 'full';
      }
      continue;
    }
    if (key === 'items' && isSchemaValue(value)) {
      if (classifyPropsSchemaProfile(value) === 'full') return 'full';
      continue;
    }
    if ((key === 'oneOf' || key === 'anyOf') && Array.isArray(value)) {
      for (const branch of value) {
        if (!isSchemaValue(branch)) return 'full';
        if (classifyPropsSchemaProfile(branch) === 'full') return 'full';
      }
      continue;
    }
  }
  return 'grammar-safe';
}
