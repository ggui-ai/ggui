/**
 * Consumer contrast-contract baseline — remaining KNOWN violations.
 *
 * 2026-08-22 burn-down (ggui#594): the founder reviewed all 28 original
 * entries in one sitting (swatch pack, two independent WCAG
 * verifications) and APPROVED 24 value fixes — those entries are gone
 * and the ratchet now enforces their pairs forever. The 4 rows below
 * are the `loud` class, EXCLUDED from value fixes by the same verdict:
 * `primary-500`-as-text is sub-AA across themes by construction, and
 * darkening the accent far enough to pass would change CTA identity.
 * Their fix is slot re-adjudication (the `loud` text slot resolving a
 * text-safe stop in light ramps) — tracked in ggui#573's vocabulary
 * lane; these rows leave the baseline when THAT lands, not via palette
 * edits.
 *
 * Burn-down rules (enforced by `contrast-contract.test.ts`, both
 * directions):
 *   - A NEW violation (any theme×mode×pair not listed here) fails the
 *     suite — the registry may not get worse.
 *   - A listed entry that STOPS failing also fails the suite until it
 *     is deleted here — fixes must claim their ground.
 */
export interface ContrastBaselineEntry {
  readonly theme: string;
  readonly mode: 'light' | 'dark';
  readonly label: string;
}

export const CONSUMER_CONTRAST_BASELINE: readonly ContrastBaselineEntry[] = [
  // loud class — founder-excluded 2026-08-22; fix rides ggui#573.
  { theme: 'claudic', mode: 'light', label: 'slots.loud p500/surface' },
  { theme: 'premium-zen', mode: 'light', label: 'slots.loud p500/surface' },
  { theme: 'premium-botanical', mode: 'light', label: 'slots.loud p500/surface' },
  { theme: 'guuey-brand-v1', mode: 'light', label: 'slots.loud p500/surface' },
];
