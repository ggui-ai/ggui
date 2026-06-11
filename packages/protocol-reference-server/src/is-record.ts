/**
 * Validating narrower shared across the reference server: is `value`
 * a non-null, non-array object — the JSON-object shape every inbound
 * wire frame and payload must satisfy before keyed access?
 *
 * One definition for the whole package so every frame parser narrows
 * with the SAME predicate — no per-module drift, no per-site casts.
 * Internal module; not part of the package's public API.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
