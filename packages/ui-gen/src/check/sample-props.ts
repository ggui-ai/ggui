// Sample props from a PropsSpec — `example` first, then `default`, then a type-driven fill from the JSON
// Schema. Pure: protocol types only, no sandbox, no node modules, so `@ggui-ai/ui-gen/check` can export it and a
// caller outside the harness (an experiment's judge input, ggui#1386) synthesizes the SAME props the coding
// agent's own render check falls back to. Moved verbatim out of `tools/render-check.ts` (2026-09-26).
import type { JsonObject, JsonSchema, JsonValue, PropsSpec } from '@ggui-ai/protocol';

/**
 * Generate sample props from a PropsSpec contract.
 * Uses `example` values from each PropEntry when available,
 * otherwise synthesizes plausible defaults from the JSON Schema.
 */
export function generateSampleProps(spec: PropsSpec): JsonObject {
  const props: JsonObject = {};

  for (const [name, entry] of Object.entries(spec.properties)) {
    // Prefer explicit example value
    if (entry.example !== undefined) {
      props[name] = entry.example;
      continue;
    }

    // Prefer explicit default value
    if (entry.default !== undefined) {
      props[name] = entry.default;
      continue;
    }

    // Synthesize from JSON Schema
    props[name] = synthesizeFromSchema(entry.schema);
  }

  return props;
}

function synthesizeFromSchema(schema: JsonSchema): JsonValue | undefined {
  // Draft-07 type arrays (`['string','null']`) synthesize from the
  // first non-null member — the canonical nullability form the
  // enforced-props-schema emission produces.
  const declared = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== 'null')
    : schema.type;
  switch (declared) {
    case 'string': return 'sample';
    case 'number':
    case 'integer': return 0;
    case 'boolean': return false;
    case 'null': return null;
    case 'array': {
      if (schema.items) return [synthesizeFromSchema(schema.items) ?? null];
      return [];
    }
    case 'object': {
      const obj: JsonObject = {};
      if (schema.properties) {
        for (const [k, v] of Object.entries(schema.properties)) {
          obj[k] = synthesizeFromSchema(v);
        }
      }
      return obj;
    }
    default: return undefined;
  }
}
