/**
 * A single (non-splat) route param / query value is a string at runtime, but
 * @types/express@5 widens `req.params[name]` to `string | string[]` (path-to-
 * regexp v8 supports repeatable params). Narrow to the single-string case;
 * an array (multi-value) collapses to undefined so callers' existing
 * missing-param guards handle it.
 */
export function singleParam(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
