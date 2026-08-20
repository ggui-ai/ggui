/**
 * guuey-brand-v1 registration pins (ggui#589 ask 3 — the store-frame
 * gate). The theme's id is EXACTLY the `AppTheme.name` guuey's widget
 * already stamps on every render envelope, so the runtime's
 * name→registry binding selects it as the BASE ladder with no wire
 * change on the sender side. The slice overlay still wins above it
 * (#573 order unchanged).
 */
import { describe, expect, it } from 'vitest';
import { getTheme, getThemeIds } from './registry';

const RAMP_STOPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
const SEMANTIC_STOPS = ['50', '100', '200', '500', '600', '700', '800'];

function darkVars(): string {
  const theme = getTheme('guuey-brand-v1', 'dark');
  if (!theme) throw new Error('guuey-brand-v1 dark not registered');
  return theme.cssVariables;
}

describe('guuey-brand-v1 — registration', () => {
  it('is registered and resolves BOTH modes without fallback aliasing', () => {
    expect(getThemeIds()).toContain('guuey-brand-v1');
    const dark = getTheme('guuey-brand-v1', 'dark');
    const light = getTheme('guuey-brand-v1', 'light');
    expect(dark).toBeDefined();
    expect(light).toBeDefined();
    // Dark is the gating variant — it must be its own definition, not
    // the light-fallback the registry serves for single-mode themes.
    expect(dark?.cssVariables).not.toBe(light?.cssVariables);
  });

  it('dark pins the brand anchors: slime primary, slime SUCCESS (never green), portal surfaces', () => {
    const vars = darkVars();
    expect(vars).toContain('--ggui-color-primary-500: #B8FF3A');
    // The founder-rejected pixel: "Available" pills rendered our stock
    // green. guuey brand rule — success IS slime.
    expect(vars).toContain('--ggui-color-success-500: #B8FF3A');
    expect(vars).toContain('--ggui-color-surface: #1A1D24');
    expect(vars).toContain('--ggui-color-onSurface: #F6F5EE');
    expect(vars).toContain('--ggui-color-surfaceVariant: #242938');
    expect(vars).toContain('--ggui-color-onSurfaceVariant: #B7BAC4');
    expect(vars).toContain('--ggui-color-onPrimary: #0E1014');
    expect(vars).toContain('--ggui-color-onPrimaryContainer: #CCFF66');
  });

  it('dark fills the FULL consumer ramps — the -500/-600/-700 slots are the real consumers (census: 107 uses on -600)', () => {
    const vars = darkVars();
    for (const stop of RAMP_STOPS) {
      expect(vars, `primary-${stop} missing`).toContain(`--ggui-color-primary-${stop}:`);
      expect(vars, `neutral-${stop} missing`).toContain(`--ggui-color-neutral-${stop}:`);
    }
    for (const family of ['success', 'warning', 'error', 'info']) {
      for (const stop of SEMANTIC_STOPS) {
        expect(vars, `${family}-${stop} missing`).toContain(`--ggui-color-${family}-${stop}:`);
      }
    }
    // Hover stop carries the brand's lifted slime, not a derived grey.
    expect(vars).toContain('--ggui-color-primary-600: #CCFF66');
  });

  it('dark carries the brand chrome: DM Sans, slime focus ring, 12px card radius', () => {
    const vars = darkVars();
    expect(vars).toContain('DM Sans');
    expect(vars).toContain('--ggui-accessibility-focusRing-color: #B8FF3A');
    expect(vars).toContain('--ggui-shape-radius-lg: 0.75rem');
  });
});
