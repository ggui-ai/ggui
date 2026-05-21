/**
 * Persona-tag normalization + near-duplicate detection.
 *
 * The operator-facing generate path accepts free-form persona tags
 * (`"Minimalist"`, `"data-dense"`, `"Mobile First"`). We normalize
 * on the way in so reads can compare structurally and so two
 * operators authoring on different days agree on which variants
 * share a persona:
 *
 *   - lowercase
 *   - trim leading/trailing whitespace
 *   - collapse internal whitespace runs into single `-` (optional;
 *     not done here — operators may legitimately want spaces in
 *     a persona like `"weekly digest"`. We preserve internal
 *     whitespace verbatim after the trim+lower step.)
 *
 * Near-duplicate detection runs Levenshtein distance against every
 * persisted tag in the same `(appId, *)` scope and emits a warning
 * (via the handler's telemetry sink, when bound) when the new tag
 * is within distance < 2 of any existing tag. The new tag is still
 * persisted — operators retain authorial control; the warning is
 * an early-detection signal, not a hard gate.
 *
 * Why distance < 2 specifically:
 *
 *   - distance 0 = identical (we surface that as "already present"
 *     in the warning so the operator can choose to deduplicate).
 *   - distance 1 = a typo / casing-difference that survived
 *     `.toLowerCase()` (`"data dense"` vs `"data-dense"`,
 *     `"minimalist"` vs `"minimalst"`). Almost certainly meant
 *     the same tag.
 *   - distance 2 = legitimate cousins (`"chart"` vs `"chat"` —
 *     three letters in common but semantically distinct). Don't
 *     warn.
 */

/**
 * Normalize a persona tag for persistence. Pure, deterministic.
 * Returns `undefined` when the input is `undefined` or whitespace-
 * only — the handler treats this as "no persona supplied" rather
 * than "explicit empty tag", matching the `variance.persona?` typed
 * shape.
 */
export function normalizePersona(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') return undefined;
  return trimmed;
}

/**
 * Iterative Levenshtein distance — the classic edit-distance algo
 * with a single row of integer state. O(n*m) time, O(min(n,m))
 * space. Pure helper exposed so the conformance suite (and any
 * future operator dashboard "did you mean…" UX) can re-use it
 * without importing the persona-near-dup machinery.
 *
 * Returns `0` when the strings are identical, `max(a.length,
 * b.length)` when they're maximally distinct.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Ensure `a` is the shorter — minor optimization for the single-
  // row buffer.
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  const m = a.length;
  const n = b.length;
  // `prev[j]` = distance between a[0..i-1] and b[0..j-1] for the
  // previous row i-1. We update in place to compute the current
  // row.
  const prev = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    let prevDiag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a.charAt(j - 1) === b.charAt(i - 1) ? 0 : 1;
      const above = prev[j] ?? 0;
      const left = prev[j - 1] ?? 0;
      const next = Math.min(
        above + 1, // deletion
        left + 1, // insertion
        prevDiag + cost, // substitution
      );
      prevDiag = above;
      prev[j] = next;
    }
  }
  return prev[m] ?? 0;
}

/**
 * Result of a near-duplicate persona check. When `nearestDistance`
 * is `< 2`, the handler emits a `near-duplicate-persona` warning
 * carrying this struct as the payload — operators can render the
 * existing tag and the new tag side-by-side and decide whether to
 * reconcile.
 */
export interface NearDuplicatePersonaCheck {
  readonly newPersona: string;
  /** The persisted persona closest to `newPersona`, or `null` when no
   *  existing persona has distance < 2. */
  readonly nearestExisting: string | null;
  /** Distance to {@link nearestExisting}, or `Infinity` when null. */
  readonly nearestDistance: number;
}

/**
 * Scan `existingPersonas` for the closest match (by Levenshtein) to
 * `newPersona`. Returns `null` when no existing persona is within
 * distance < 2 — the handler interprets that as "not a
 * near-duplicate; persist quietly".
 *
 * Both inputs SHOULD be pre-normalized via {@link normalizePersona}.
 * The handler folds normalization in before calling.
 *
 * Identical matches (distance 0) ARE flagged — they surface as
 * "already present" in the warning so the operator can decide
 * whether to deduplicate. Many ops UX flows want to know "this
 * variant already exists under this persona" before authoring.
 */
export function findNearDuplicatePersona(
  newPersona: string,
  existingPersonas: Iterable<string>,
): NearDuplicatePersonaCheck | null {
  let nearestExisting: string | null = null;
  let nearestDistance = Infinity;
  for (const existing of existingPersonas) {
    if (existing === newPersona) {
      return {
        newPersona,
        nearestExisting: existing,
        nearestDistance: 0,
      };
    }
    const d = levenshtein(newPersona, existing);
    if (d < nearestDistance) {
      nearestDistance = d;
      nearestExisting = existing;
    }
  }
  if (nearestDistance < 2 && nearestExisting !== null) {
    return { newPersona, nearestExisting, nearestDistance };
  }
  return null;
}
