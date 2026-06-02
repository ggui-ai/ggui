/**
 * Deterministic repair of the invalid JSON Schema `type` spellings an
 * LLM occasionally emits in a synthesized contract. Runs inside
 * `buildContract` (before the `dataContractSchema` validation gate) so
 * the dominant synth-decline class — a `type` value outside the seven
 * JSON Schema primitives — is structurally eliminated rather than left
 * to a repair retry.
 *
 * Pure, recursive, total: a schema that is already valid passes
 * through unchanged — every mapping fires only on a value NOT in the
 * valid set. Recursion descends only into sub-schema positions, so
 * data-value positions (`default`, `const`, `enum`, `examples`) are
 * left verbatim — a `default` of `{type: "list"}` is user data, not a
 * schema, and must not be rewritten.
 */

/** The seven JSON Schema primitive type names. */
const VALID_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
]);

/** Unambiguous non-canonical type spellings → canonical primitive. */
const TYPE_ALIASES: Record<string, string> = {
  list: 'array',
  tuple: 'array',
  sequence: 'array',
  dict: 'object',
  map: 'object',
  record: 'object',
  hash: 'object',
  str: 'string',
  text: 'string',
  char: 'string',
  int: 'integer',
  long: 'integer',
  short: 'integer',
  float: 'number',
  double: 'number',
  decimal: 'number',
  num: 'number',
  numeric: 'number',
  bool: 'boolean',
};

/** Type words that mean "no constraint" — the `type` key is dropped. */
const DROP_TYPES = new Set(['any', 'unknown', 'mixed', 'void']);

/** Object keys whose value is itself a single schema. */
const SCHEMA_VALUED_KEYS = new Set([
  'items',
  'additionalProperties',
  'not',
  'contains',
  'propertyNames',
]);

/** Object keys whose value is a map of name → schema. */
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
]);

/** Object keys whose value is an array of schemas. */
const SCHEMA_ARRAY_KEYS = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);

/**
 * Infer the base type of an `enum`-constrained field from its value
 * list. Mixed / empty / non-array → `string` (the safe default, and
 * the overwhelmingly common enum shape).
 */
function inferEnumBaseType(enumSibling: unknown): string {
  if (!Array.isArray(enumSibling) || enumSibling.length === 0) {
    return 'string';
  }
  if (enumSibling.every((v) => typeof v === 'string')) return 'string';
  if (enumSibling.every((v) => typeof v === 'number')) return 'number';
  if (enumSibling.every((v) => typeof v === 'boolean')) return 'boolean';
  return 'string';
}

/**
 * Map one `type` value to a canonical primitive, or `undefined` when
 * the `type` key should be dropped entirely (an absent `type` is valid
 * JSON Schema — it simply imposes no constraint).
 *
 * `enumSibling` is the schema's `enum` array, used to pick the base
 * type when the LLM wrote the (invalid) `type: "enum"`.
 */
function normalizeTypeValue(
  value: unknown,
  enumSibling: unknown,
): string | undefined {
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (VALID_TYPES.has(lower)) return lower;
    if (lower === 'enum') return inferEnumBaseType(enumSibling);
    if (DROP_TYPES.has(lower)) return undefined;
    const alias = TYPE_ALIASES[lower];
    if (alias !== undefined) return alias;
    if (lower.includes('|')) {
      // Pipe-union string (`"STRING|null"`). Some models emit the union
      // as one pipe-delimited string rather than the JSON Schema array
      // form; recover the first valid non-null member, mirroring the
      // array branch below (drops the nullable arm).
      for (const member of lower.split('|')) {
        const norm = normalizeTypeValue(member, enumSibling);
        if (norm !== undefined && norm !== 'null') return norm;
      }
      return undefined;
    }
    // Unrecognized garbage — drop the constraint rather than guess.
    return undefined;
  }
  if (Array.isArray(value)) {
    // Union type (`["string", "null"]`). The protocol contract schema
    // accepts only a single string; recover the first valid non-null
    // member, dropping the nullable arm.
    for (const member of value) {
      if (typeof member === 'string') {
        const norm = normalizeTypeValue(member, enumSibling);
        if (norm !== undefined && norm !== 'null') return norm;
      }
    }
    return 'string';
  }
  // `type` was a number / object / boolean — meaningless; drop it.
  return undefined;
}

/** Normalize a map of name → schema (e.g. `properties`). */
function normalizeSchemaMap(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
    out[name] = coerceToSchema(sub);
  }
  return out;
}

/**
 * Coerce a value found in a schema-expecting position into a schema
 * object. An LLM sometimes writes the shorthand `items: "number"`
 * where JSON Schema requires `items: {type: "number"}` — expand it
 * (`"number"` → `{type: "number"}`, an unrecognized string → `{}`,
 * the unconstrained schema). A boolean (`additionalProperties: false`)
 * is a valid schema-position value and passes through; anything else
 * recurses through {@link normalizeSchema}.
 */
function coerceToSchema(value: unknown): unknown {
  if (typeof value === 'string') {
    const t = normalizeTypeValue(value, undefined);
    return t === undefined ? {} : { type: t };
  }
  return normalizeSchema(value);
}

/**
 * Recursively normalize a JSON Schema, repairing invalid `type`
 * values. Non-object input (booleans, primitives) passes through —
 * `additionalProperties: false` and the like are valid as-is.
 */
export function normalizeSchema(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return schema;
  }
  const obj = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'type') {
      const fixed = normalizeTypeValue(value, obj['enum']);
      if (fixed !== undefined) out[key] = fixed;
      continue;
    }
    if (SCHEMA_VALUED_KEYS.has(key)) {
      out[key] = coerceToSchema(value);
    } else if (SCHEMA_MAP_KEYS.has(key)) {
      out[key] = normalizeSchemaMap(value);
    } else if (SCHEMA_ARRAY_KEYS.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map((s) => coerceToSchema(s))
        : value;
    } else {
      // Data-value position (`default`, `const`, `enum`, `examples`,
      // `required`, `description`, …) — leave verbatim.
      out[key] = value;
    }
  }
  return out;
}
