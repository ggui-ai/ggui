/**
 * Validating narrower for the JSON-object shape: is `value` a
 * non-null, non-array object — the shape every wire frame, request
 * body, and envelope must satisfy before keyed access?
 *
 * One definition for the whole protocol family so every trust
 * boundary narrows with the SAME predicate — no per-package
 * duplicates, no per-site `as Record<string, unknown>` casts. Use it
 * wherever untrusted input (HTTP bodies, wire frames, parsed JSON)
 * needs to become a `Record<string, unknown>` before field reads:
 *
 * ```ts
 * const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};
 * ```
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
