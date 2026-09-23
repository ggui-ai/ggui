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
 *   - `unknown`   — overlay names this manifest does not list (minus the
 *     floor). The projector's OWN release gate treats them as the dead-key
 *     class (its derived overlays must report none). A WRITE door admits
 *     and names them instead (ggui#1286): it cannot tell a newer
 *     projector's name from a bug, and refusing breaks N−1 (new → old).
 *   - `warnings`  — a ramp whose lightness is not monotone from 50 to
 *     900 (§2.3: the state ladder depends on the ramp's direction).
 *
 * Coverage (refused) and the attestation hash are WRITE-door checks and
 * `unknown` is a write-door annotation; read doors validate shape only.
 */
import { consumedTokenManifest } from './consumed-tokens';
import { completeThemeVariables, hexToOklch } from './derive-theme-variables';

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

/**
 * ggui#1106 — manifest names the :root LADDER always declares (every
 * `deriveThemeVariables` projection of a layer-1 document emits them), that a
 * document MAY state, and that an overlay may OMIT: the card then animates at
 * the shipped tempo, exactly as under a release that had no motion names
 * (N−1, ggui#1184). Not the floor — a stated one is consumed, never
 * `unknown` — and not a completion: an overlay never restates the ladder
 * (`completeThemeVariables` fills only what the overlay itself implies).
 */
export const LADDER_COVERED_TOKENS: readonly string[] = [
  '--ggui-motion-duration-fast',
  '--ggui-motion-duration-base',
  '--ggui-motion-duration-slow',
  '--ggui-motion-easing-standard',
  '--ggui-motion-easing-emphasized',
  '--ggui-motion-easing-exit',
  // ggui#1083 — the scrim's opacity: a constant (0.45) every projection declares, that a
  // document MAY state, and that an overlay may omit; its tint is NOT here — it completes
  // from the overlay's own ground (`completeThemeVariables`).
  '--ggui-scrim-opacity',
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
  // Coverage is judged AFTER completion: a manifest name the renderer
  // derives from this overlay (`completeThemeVariables` — the same
  // completion `composeThemeCss` runs before painting) is covered, so a
  // payload the renderer paints in full is never refused for not
  // carrying what the renderer would have derived. The derivable SET is
  // the same in both modes (only the values differ), so one completion
  // answers the question of names. `unknown` stays a judgement on the
  // RAW keys — a projected name nothing reads is still the projector's bug.
  const covered = new Set(Object.keys(completeThemeVariables(overlay, 'light')));
  const ladderCovered = new Set(LADDER_COVERED_TOKENS);
  const uncovered = [...manifest].filter((t) => !covered.has(t) && !ladderCovered.has(t)).sort();
  const unknown = [...keys].filter((k) => !manifest.has(k) && !floor.has(k)).sort();
  return { uncovered, unknown, warnings: rampWarnings(overlay) };
}
