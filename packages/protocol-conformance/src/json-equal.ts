/**
 * Structural equality over plain JSON data — the one comparator every
 * pure-function catalog grades with (key order ignored, arrays ordered).
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  const left = a as { readonly [key: string]: unknown };
  const right = b as { readonly [key: string]: unknown };
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!jsonEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => jsonEqual(left[key], right[key]));
}
