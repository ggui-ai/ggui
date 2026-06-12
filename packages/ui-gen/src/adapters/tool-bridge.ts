// packages/ui-gen/src/adapters/tool-bridge.ts
//
// Bridges between SDK tool wire formats and ggui's JSON types:
// Zod → JSON Schema for tool declarations, and validated narrowing of
// decoded tool-call arguments to `JsonObject`.

import { z } from 'zod';
import type { JsonObject, JsonValue } from '@ggui-ai/protocol';

/**
 * Convert a Zod object schema to JSON Schema.
 * Uses Zod v4's built-in toJSONSchema() function.
 */
export function zodToJsonSchema(schema: z.ZodType): JsonObject {
  return z.toJSONSchema(schema) as JsonObject;
}

/**
 * Validate that a decoded tool-call `arguments` object is plain JSON data
 * and narrow it to {@link JsonObject}. Provider SDKs type tool-call
 * arguments as `{ [key: string]: unknown }`; values decoded from a JSON
 * wire payload are JSON by construction, so a failure here means the SDK
 * handed us something that never came from JSON — a bug worth surfacing,
 * not erasing with a cast.
 */
export function toolArgsToJsonObject(args: { [key: string]: unknown }): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    // `JsonObject` keys admit `undefined` (TS optional properties);
    // JSON.stringify omits them, so pass-through is JSON-safe.
    out[key] = value === undefined ? undefined : toJsonValue(value, key);
  }
  return out;
}

function toJsonValue(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => toJsonValue(item, `${path}[${i}]`));
  }
  if (typeof value === 'object') {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = entry === undefined ? undefined : toJsonValue(entry, `${path}.${key}`);
    }
    return out;
  }
  throw new Error(
    `Tool-call arguments contain a non-JSON value at '${path}' (${typeof value})`,
  );
}
