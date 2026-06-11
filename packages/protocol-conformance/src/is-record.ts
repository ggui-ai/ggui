/**
 * Validating narrower shared across the kit: is `value` a non-null,
 * non-array object — the JSON-object shape every wire frame, fixture
 * body, and envelope must satisfy before keyed access?
 *
 * One definition for the whole package so the matcher, the runner,
 * and the transport narrow with the SAME predicate — no per-module
 * drift, no per-site casts. Internal module; not part of the
 * package's public API.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
