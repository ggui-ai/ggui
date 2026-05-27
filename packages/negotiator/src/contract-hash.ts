/**
 * Contract Hashing — deterministic cache key from data contract.
 *
 * Uses RFC 8785 (JSON Canonicalization Scheme) for deterministic
 * serialization, then SHA-256 for the hash.
 *
 * What's in the hash: intent only (the semantic identity).
 * What's NOT in the hash: props, actions, stream (including per-channel source), adaptations.
 *
 * Why intent-only: The LLM generates slightly different prop descriptions
 * each call, but the INTENT is deterministic (provided by the agent or
 * generated once). Same intent = same component = same cached code.
 * Props are passed at render time, not baked into the component.
 *
 * The `interaction` field was removed from `DataContract` in pre-launch
 * cleanup (the four-spec surface — props/action/context/stream —
 * describes the wire exhaustively); this function used to factor it in
 * but no longer does. Old goldens were rotated when the field went away.
 */

import { createHash } from 'node:crypto';
import type { DataContract } from '@ggui-ai/protocol';

/**
 * RFC 8785 JSON Canonicalization Scheme.
 *
 * Produces deterministic JSON by:
 * - Sorting object keys lexicographically (recursive)
 * - Normalizing numbers (no trailing zeros, no +0)
 * - Removing undefined values
 * - No whitespace
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!isFinite(value)) return 'null';
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]));
    return '{' + entries.join(',') + '}';
  }
  return 'null';
}

/**
 * Hash a data contract to a deterministic cache key.
 *
 * Hashes intent only — the semantic identity of the UI. Props,
 * actions, stream specs are for code generation, not caching.
 *
 * `intent` is passed separately because `DataContract` itself does
 * not carry an `intent` field — the outer pipeline owns intent
 * (`story.intent` on `ggui_render`, the operator prompt for harness
 * benchmarks). Threading intent into the hash keeps cache identity
 * stable across negotiations: different intents produce different
 * generated code (labels, copy, layout) even when the wire surface is
 * identical.
 *
 * The `contract` argument is retained on the signature for forward
 * compatibility — future cache-key fields (e.g., a structural
 * fingerprint of the four specs) can be folded in without breaking
 * call sites — but is not consulted by the current implementation.
 *
 * @param contract - The data contract from negotiation (unused today)
 * @param intent - The outer pipeline's intent (story.intent on
 *   ggui_render). Empty/falsy values are dropped from the hash input.
 * @returns Contract hash prefixed with `ch_` (e.g., `ch_a3f8b2c1e9d04567`)
 */
export function hashContract(
  _contract: DataContract,
  intent: string,
): string {
  const input: Record<string, unknown> = {};
  if (intent) input.intent = intent;
  const canonical = canonicalize(input);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return `ch_${hash.slice(0, 16)}`;
}

/**
 * Build a variant key from shell type and device category.
 *
 * @param shellType - Shell type (default: 'universal')
 * @param deviceCategory - Device category (default: 'universal')
 * @returns Variant string (e.g., 'fullscreen:mobile', 'universal:universal')
 */
export function buildVariant(
  shellType = 'universal',
  deviceCategory = 'universal',
): string {
  return `${shellType}:${deviceCategory}`;
}
