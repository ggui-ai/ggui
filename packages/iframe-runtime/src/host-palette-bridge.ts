/**
 * Spec→ggui token bridge (ggui#572).
 *
 * MCP Apps hosts announce their palette as spec `--color-*` custom
 * properties in `hostContext.styles.variables`. The canonical
 * `@modelcontextprotocol/ext-apps` helper applies them as inline
 * custom properties on the iframe `<html>` — which is correct spec
 * behavior but repaints nothing ggui renders: generated UI, the
 * design system, and the shell chrome consume exclusively `--ggui-*`
 * tokens, and the renderer's scoped in-body token block shadows
 * root-level inheritance for every token it defines anyway.
 *
 * This module translates the spec vocabulary onto the ggui token
 * ladder so the renderer can merge the host's palette INTO the scoped
 * block — as the fallback layer beneath the app's own theme (#573
 * ruling: the slice's stamped theme wins; the host palette fills the
 * slots no operator repainted).
 *
 * Coverage is deliberately PARTIAL in both directions:
 *
 *   - Spec keys with no faithful ggui counterpart (ghost/disabled/
 *     inverse variants, ring colors, fonts, radii, shadows) are
 *     dropped — they keep applying via the ext-apps inline-DOM path
 *     for any non-ggui content, and inventing a mapping would repaint
 *     tokens with the WRONG semantic role.
 *   - ggui tokens the spec doesn't express (the primary accent scale,
 *     containers beyond error, the neutral ladder) keep their
 *     mode-resolved base values — the host-announced color MODE
 *     (ggui#551) already selects the coherent light/dark ladder these
 *     slots resolve from.
 */

/**
 * Spec `--color-*` key → ggui token, one entry per slot whose semantic
 * role matches 1:1. Semantic status text maps to the ladder's `-500`
 * stop — the "live" stop tone slots and Alert actually read; a flat
 * `--ggui-color-error` target would repaint nothing (no theme emits
 * flat semantic tokens).
 */
const SPEC_TO_GGUI: Readonly<Record<string, string>> = {
  '--color-background-primary': '--ggui-color-surface',
  '--color-background-secondary': '--ggui-color-surfaceVariant',
  '--color-background-tertiary': '--ggui-color-container',
  '--color-background-danger': '--ggui-color-errorContainer',
  '--color-text-primary': '--ggui-color-onSurface',
  '--color-text-secondary': '--ggui-color-onSurfaceVariant',
  '--color-text-tertiary': '--ggui-color-neutral-500',
  '--color-text-danger': '--ggui-color-error-500',
  '--color-text-success': '--ggui-color-success-500',
  '--color-text-warning': '--ggui-color-warning-500',
  '--color-text-info': '--ggui-color-info-500',
  '--color-border-primary': '--ggui-color-outline',
  '--color-border-secondary': '--ggui-color-outlineVariant',
};

/**
 * Host palette values arrive over postMessage and are string-joined
 * into a `<style>` element by the renderer — unlike the app's own
 * theme overlay they are NOT pre-validated by the wire parser, so
 * this is the sanitization gate. Conservative deny-list: anything
 * that could close the declaration (`;`), the rule (`{`/`}`), or the
 * style element (`<`/`>`), smuggle strings/escapes, comment out the
 * rest of the sheet (`/*`), or trigger a fetch (`url(`) drops the
 * value. Plain color syntax — hex, rgb()/hsl()/oklch()/color-mix(),
 * named colors — passes untouched.
 */
function isSafeCssValue(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  if (/[;{}<>"'`\\]/.test(value)) return false;
  if (/\/\*/.test(value)) return false;
  if (/url\s*\(/i.test(value)) return false;
  // Control characters (incl. newlines) have no place in a color value.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/**
 * Map a host-announced `styles.variables` record onto `--ggui-*`
 * declarations ready for the renderer's scoped token block.
 *
 * Unknown keys and unsafe/blank values are dropped silently (the same
 * tolerant posture as the rest of host-context handling — a partial
 * palette is a partial repaint, never an error). Returns `undefined`
 * when nothing survives so callers can spread-skip the option.
 *
 * @public
 */
export function mapHostPaletteToGguiVars(
  variables: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (variables === undefined) return undefined;
  const mapped: Record<string, string> = {};
  let count = 0;
  for (const [specKey, gguiKey] of Object.entries(SPEC_TO_GGUI)) {
    const raw = variables[specKey];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!isSafeCssValue(value)) continue;
    mapped[gguiKey] = value;
    count += 1;
  }
  return count > 0 ? mapped : undefined;
}
