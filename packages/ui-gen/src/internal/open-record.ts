// packages/ui-gen/src/internal/open-record.ts
//
// Single documented narrowing seam for "object used as an open
// string-keyed property bag" — the host global object and happy-dom's
// `Window` both genuinely ARE open records at runtime (we install /
// restore named globals like `window` / `document` on them by key),
// but TypeScript cannot express that without polluting the global type
// space via declaration merging. Centralizing the one structural
// widening here keeps every call site cast-free.

/**
 * View an object as an open string-keyed record.
 *
 * Single structural widening (`Record<string, unknown>` is assignable
 * to `object`, so the cast is checked in one direction by tsc — no
 * `unknown` erasure). Returns the SAME reference: property writes land
 * on the live object.
 */
export function openRecord(o: object): Record<string, unknown> {
  return o as Record<string, unknown>;
}

/**
 * The host global object viewed as an open property bag.
 *
 * Used by the render-check pipeline (and its subprocess worker) to
 * install and restore DOM globals by name.
 */
export function hostGlobals(): Record<string, unknown> {
  return openRecord(globalThis);
}
