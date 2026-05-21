// packages/ui-gen/src/adapters/tool-bridge.ts
//
// Converts Zod schemas to JSON Schema for SDKs that don't support Zod natively.
// Uses Zod v4's built-in toJSONSchema() for accurate conversion.

import { z } from 'zod';
import type { JsonObject } from '@ggui-ai/protocol';

/**
 * Convert a Zod object schema to JSON Schema.
 * Uses Zod v4's built-in toJSONSchema() function.
 */
export function zodToJsonSchema(schema: z.ZodType): JsonObject {
  return z.toJSONSchema(schema) as JsonObject;
}
