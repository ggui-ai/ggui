/**
 * The write-door check over a PROJECTION (ggui#987 §3.4).
 *
 * A projection is the overlay a write door receives — a `--ggui-*` map
 * produced by {@link deriveThemeVariables} or by an embedding host's
 * composer. It is judged against the consumed-token manifest, the
 * contract of what a card will read (§6):
 *
 *   - `uncovered` — manifest names the overlay does not carry (minus the
 *     exclusion floor): a card would read an unset variable.
 *   - `unknown`   — overlay names nothing reads (minus the floor): the
 *     dead-key class; refused pre-launch.
 *   - `warnings`  — a ramp whose lightness is not monotone from 50 to
 *     900 (§2.3: the state ladder depends on the ramp's direction).
 *
 * Coverage, `unknown` and the attestation hash are WRITE-door checks;
 * read doors validate shape only.
 */
import { consumedTokenManifest } from './consumed-tokens';
import { hexToOklch } from './derive-theme-variables';

/**
 * Manifest names no projection is obliged to carry — consumption-site
 * names with no emission slot:
 *
 * - `--ggui-color-primary`: a bare family name read as a doc-example
 *   fallback; the family is the `primary-*` ramp.
 * - `--ggui-color-ground-gradient` / `--ggui-color-ground-subtle`:
 *   derived `color-mix()` compositions built by the renderer from the
 *   ground role and the primary ramp — computed, never projected.
 * - `--ggui-flash-color`: an element-level opt-in variable set by
 *   component code at runtime, not a ladder token.
 */
export const NON_THEME_DEFINABLE_TOKENS: readonly string[] = [
  '--ggui-color-primary',
  '--ggui-color-ground-gradient',
  '--ggui-color-ground-subtle',
  '--ggui-flash-color',
];

export interface OverlayCoverageReport {
  readonly uncovered: readonly string[];
  readonly unknown: readonly string[];
  readonly warnings: readonly string[];
}

const RAMP_STOPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;

function rampWarnings(overlay: Readonly<Record<string, string>>): string[] {
  const families = new Set<string>();
  for (const name of Object.keys(overlay)) {
    const m = /^--ggui-color-([a-zA-Z]+)-(50|[1-9]00)$/.exec(name);
    if (m) families.add(m[1]!);
  }
  const out: string[] = [];
  for (const family of [...families].sort()) {
    const ls: number[] = [];
    for (const stop of RAMP_STOPS) {
      const v = overlay[`--ggui-color-${family}-${stop}`];
      if (v === undefined || !/^#[0-9a-fA-F]{3,6}$/.test(v)) {
        ls.length = 0;
        break;
      }
      ls.push(hexToOklch(v).l);
    }
    if (ls.length !== RAMP_STOPS.length) continue;
    const monotone = ls.every((l, i) => i === 0 || l < ls[i - 1]!);
    if (!monotone) out.push(`${family}: lightness is not monotone from 50 to 900 — the state ladder (hover/pressed) reads the ramp's direction`);
  }
  return out;
}

/**
 * Judge an overlay against the manifest. See the module header.
 */
export function validateOverlayCoverage(
  overlay: Readonly<Record<string, string>>,
  manifestTokens: readonly string[] = consumedTokenManifest,
  excluded: readonly string[] = NON_THEME_DEFINABLE_TOKENS,
): OverlayCoverageReport {
  const floor = new Set(excluded);
  const manifest = new Set(manifestTokens.filter((t) => !floor.has(t)));
  const keys = new Set(Object.keys(overlay));
  const uncovered = [...manifest].filter((t) => !keys.has(t)).sort();
  const unknown = [...keys].filter((k) => !manifest.has(k) && !floor.has(k)).sort();
  return { uncovered, unknown, warnings: rampWarnings(overlay) };
}
