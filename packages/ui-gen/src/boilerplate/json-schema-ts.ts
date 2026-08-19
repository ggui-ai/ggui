// packages/ui-gen/src/boilerplate/json-schema-ts.ts
//
// JSON Schema → TypeScript type string converter.
//
// Pure, self-contained, no env reads, no framework deps. Exposed
// publicly on `@ggui-ai/ui-gen/boilerplate` because it's the primitive
// that turns a contract's JSON Schema into the `interface Props { ... }`
// block the boilerplate generator writes.

import type { JsonSchema } from '@ggui-ai/protocol';

/**
 * Convert a JsonSchema to a TypeScript type string — recursive.
 *
 * Handles: string, number, integer, boolean, null, array (+ tuples), object,
 * enum, oneOf/anyOf (unions), nullable, const, additionalProperties.
 */
export function jsonSchemaTypeToTs(schema: JsonSchema): string {
  // ── Union types (oneOf / anyOf) ──
  const unionMembers = schema.oneOf ?? schema.anyOf;
  if (unionMembers?.length) {
    const types = [...new Set(unionMembers.map(s => jsonSchemaTypeToTs(s)))];
    return types.length === 1 ? types[0] : types.join(' | ');
  }

  // ── Const (literal type) ──
  if (schema.const !== undefined) {
    return typeof schema.const === 'string' ? `'${schema.const}'` : String(schema.const);
  }

  // ── Enum (union of literals) ──
  if (schema.enum?.length) {
    return schema.enum
      .map(v => typeof v === 'string' ? `'${v}'` : String(v))
      .join(' | ');
  }

  // ── Draft-07 type array (`['string','null']` — the canonical
  // nullable form since draft-2026-08-19): members' TS union. Each
  // member re-enters with the single type so object/array members
  // keep their properties/items; `nullable` is folded in here (not in
  // the recursion) so it can't double-append. ──
  if (Array.isArray(schema.type)) {
    const { nullable: _nullable, ...rest } = schema;
    const members = [...new Set(schema.type)].map((member) =>
      jsonSchemaTypeToTs({ ...rest, type: member }),
    );
    const unique = [...new Set(members)];
    if (schema.nullable && !unique.includes('null')) unique.push('null');
    return unique.join(' | ');
  }

  let result: string;

  switch (schema.type) {
    case 'string':
      result = 'string';
      break;
    case 'number':
    case 'integer':
      result = 'number';
      break;
    case 'boolean':
      result = 'boolean';
      break;
    case 'null':
      return 'null';

    case 'array': {
      if (schema.items) {
        const itemType = jsonSchemaTypeToTs(schema.items);
        // Use Array<T> for complex object types, T[] for simple.
        // `items.type` may be a type SET — treat any set containing
        // 'object' like the single-string form.
        const itemsDeclareObject = Array.isArray(schema.items.type)
          ? schema.items.type.includes('object')
          : schema.items.type === 'object';
        result = (itemsDeclareObject && schema.items.properties)
          ? `Array<${itemType}>`
          : (itemType.includes('|') ? `(${itemType})[]` : `${itemType}[]`);
      } else {
        result = 'unknown[]';
      }
      break;
    }

    case 'object': {
      if (schema.properties) {
        const required = schema.required ?? [];
        const fields = Object.entries(schema.properties)
          .map(([key, prop]) => {
            const opt = !required.includes(key);
            return `${key}${opt ? '?' : ''}: ${jsonSchemaTypeToTs(prop)}`;
          })
          .join('; ');
        result = `{ ${fields} }`;
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        result = `Record<string, ${jsonSchemaTypeToTs(schema.additionalProperties)}>`;
      } else {
        result = 'Record<string, unknown>';
      }
      break;
    }

    default:
      result = 'unknown';
  }

  // Apply nullable (OpenAPI 3.0 shorthand)
  if (schema.nullable && result !== 'unknown') {
    return `${result} | null`;
  }

  return result;
}
