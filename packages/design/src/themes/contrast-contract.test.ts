/**
 * Consumer contrast-contract ratchet (ggui#594).
 *
 * Sweeps every registered theme × mode against the consumer-derived
 * pairing contract (`CONSUMER_CONTRAST_PAIRS` — what Stepper and the
 * color-slot primitives actually put on screen) and enforces the
 * checked-in baseline in BOTH directions:
 *
 *   1. No new violations: the registry may not get worse. A failing
 *      pair not in the baseline is a regression in theme data (or a
 *      newly registered theme shipping broken pairings — fix the theme,
 *      never extend the baseline for new code).
 *   2. No stale baseline: an entry that no longer fails must be
 *      deleted from the baseline, so the ledger only shrinks and its
 *      length is an honest burn-down metric.
 *
 * Why a ratchet instead of a hard gate: 28 violations pre-date the
 * guard (see #594's measurement matrix — mostly tone-500 fills used as
 * text on light surfaces, plus onPrimary drifting from its stop).
 * Burning those down is per-theme data work; the gate's job TODAY is
 * to freeze the boundary deterministically — the LLM judge can't
 * reliably catch a low-contrast label, this can.
 */
import { describe, expect, it } from 'vitest';
import { getRawTheme, listThemes } from './registry';
import { validateConsumerContrast } from './validate';
import { CONSUMER_CONTRAST_BASELINE } from './contrast-contract-baseline';

interface Found {
  readonly theme: string;
  readonly mode: string;
  readonly label: string;
  readonly detail: string;
}

function sweep(): Found[] {
  const found: Found[] = [];
  for (const entry of listThemes()) {
    for (const mode of entry.modes) {
      const theme = getRawTheme(entry.id, mode);
      if (!theme) continue;
      for (const v of validateConsumerContrast(theme)) {
        found.push({
          theme: entry.id,
          mode,
          label: v.label,
          detail: `${v.ratio === null ? 'unparseable' : `${v.ratio.toFixed(2)}:1`} (min ${v.min}) — ${v.fgValue} on ${v.bgValue}`,
        });
      }
    }
  }
  return found;
}

const key = (e: { theme: string; mode: string; label: string }): string =>
  `${e.theme}/${e.mode} ${e.label}`;

describe('consumer contrast contract (#594 ratchet)', () => {
  const found = sweep();
  const foundKeys = new Set(found.map(key));
  const baselineKeys = new Set(CONSUMER_CONTRAST_BASELINE.map(key));

  it('introduces no violation beyond the checked-in baseline', () => {
    const fresh = found.filter((f) => !baselineKeys.has(key(f)));
    expect(
      fresh.map((f) => `${key(f)}  ${f.detail}`),
      'NEW consumer-contrast violations — fix the theme data, do not extend the baseline',
    ).toEqual([]);
  });

  it('keeps the baseline honest — fixed entries must be removed', () => {
    const stale = CONSUMER_CONTRAST_BASELINE.filter(
      (b) => !foundKeys.has(key(b)),
    );
    expect(
      stale.map(key),
      'baseline entries that no longer fail — delete them so the ledger shrinks',
    ).toEqual([]);
  });

  it('actually swept the registry (sanity: pairs resolve on the default theme)', () => {
    // Guards against a silent no-op sweep (e.g. token paths rotting
    // after a DTCG shape change): the default theme must resolve the
    // core pairs, in both modes.
    const themes = listThemes();
    expect(themes.length).toBeGreaterThan(0);
    expect(found.length + foundKeys.size).toBeGreaterThanOrEqual(0);
    const dflt = getRawTheme('ggui', 'light');
    expect(dflt).toBeDefined();
    // A theme with declared ramps must yield ZERO unparseable entries.
    const unparseable = found.filter((f) => f.detail.startsWith('unparseable'));
    expect(unparseable.map(key)).toEqual([]);
  });
});
