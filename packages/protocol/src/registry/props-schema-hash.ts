/**
 * `computePropsSchemaHash` — sha256 over the RFC 8785 (JCS) canonical
 * bytes of an enforced props schema (P3 pin 3, frozen 2026-08-19,
 * guuey#271). Lowercase hex, full 64 characters, no prefix.
 *
 * Server-only — depends on `node:crypto`, so it lives behind its own
 * subpath (`@ggui-ai/protocol/props-schema-hash`) per the
 * `blueprint-key` convention; browsers never bundle it. The pure
 * canonicalization half (`canonicalPropsSchemaBytes`) is browser-safe
 * in `validation/enforced-props-schema.ts`.
 *
 * Consumer verification rule (frozen): re-canonicalize the received
 * `propsSchema` value per RFC 8785 (any JCS library), hash, compare —
 * raw received bytes are equivalent whenever the transport preserves
 * key order.
 */
import { createHash } from 'node:crypto';
import type { JsonSchema } from '../types/data-contract.js';
import { canonicalPropsSchemaBytes } from '../validation/enforced-props-schema.js';

export function computePropsSchemaHash(schema: JsonSchema): string {
  return createHash('sha256')
    .update(canonicalPropsSchemaBytes(schema))
    .digest('hex');
}
