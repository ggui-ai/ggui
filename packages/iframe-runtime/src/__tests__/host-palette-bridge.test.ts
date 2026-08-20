/**
 * Spec→ggui token bridge — the mapping half of ggui#572.
 *
 * MCP Apps hosts announce their palette as spec `--color-*` custom
 * properties (`hostContext.styles.variables`). ggui-generated UI
 * consumes exclusively `--ggui-*` tokens, so without a mapping the
 * host palette repaints nothing (receipted twice: beauty/001 F2,
 * beauty/002 arm H). `mapHostPaletteToGguiVars` translates the spec
 * vocabulary onto the ggui token ladder so the renderer can merge it
 * into the scoped token block as the fallback layer beneath the
 * slice's own theme (#573 ruling: slice wins, host fallback).
 */
import { describe, expect, it } from 'vitest';
import { mapHostPaletteToGguiVars } from '../host-palette-bridge.js';

describe('mapHostPaletteToGguiVars — spec key mapping', () => {
  it('maps the core surface/text/border spec keys onto their ggui tokens', () => {
    const mapped = mapHostPaletteToGguiVars({
      '--color-background-primary': '#101014',
      '--color-background-secondary': '#1b1b22',
      '--color-text-primary': '#f4f4f5',
      '--color-text-secondary': '#a1a1aa',
      '--color-border-primary': '#3f3f46',
    });
    expect(mapped).toEqual({
      '--ggui-color-surface': '#101014',
      '--ggui-color-surfaceVariant': '#1b1b22',
      '--ggui-color-onSurface': '#f4f4f5',
      '--ggui-color-onSurfaceVariant': '#a1a1aa',
      '--ggui-color-outline': '#3f3f46',
    });
  });

  it('maps the semantic status text keys onto the live -500 ladder stops', () => {
    // The `-500` stop is what tone slots + Alert read (see
    // design/color-slots.ts `resolveToneCss`) — a flat
    // `--ggui-color-error` target would repaint nothing.
    const mapped = mapHostPaletteToGguiVars({
      '--color-text-danger': '#ef4444',
      '--color-text-success': '#22c55e',
      '--color-text-warning': '#f59e0b',
      '--color-text-info': '#38bdf8',
    });
    expect(mapped).toEqual({
      '--ggui-color-error-500': '#ef4444',
      '--ggui-color-success-500': '#22c55e',
      '--ggui-color-warning-500': '#f59e0b',
      '--ggui-color-info-500': '#38bdf8',
    });
  });

  it('drops spec keys with no ggui counterpart instead of inventing tokens', () => {
    // Partial coverage is by design: the spec has slots the ggui
    // ladder does not express 1:1 (ghost/disabled/inverse); those
    // keys keep applying only via the ext-apps inline-DOM path.
    const mapped = mapHostPaletteToGguiVars({
      '--color-background-ghost': '#00000000',
      '--color-text-disabled': '#52525b',
      '--color-ring-primary': '#6366f1',
      '--color-background-primary': '#ffffff',
    });
    expect(mapped).toEqual({ '--ggui-color-surface': '#ffffff' });
  });

  it('drops undefined and blank values', () => {
    const mapped = mapHostPaletteToGguiVars({
      '--color-background-primary': undefined,
      '--color-text-primary': '   ',
      '--color-border-primary': '#e4e4e7',
    });
    expect(mapped).toEqual({ '--ggui-color-outline': '#e4e4e7' });
  });

  it('drops values that could break out of a CSS declaration', () => {
    // Host palette values arrive over postMessage and are string-joined
    // into a <style> tag by the renderer — unlike App.theme they are
    // NOT pre-validated by our wire parser, so the bridge is the
    // sanitization gate. Anything that could close the declaration,
    // the rule, or the style element — or trigger a fetch — is dropped.
    const mapped = mapHostPaletteToGguiVars({
      '--color-background-primary': 'red;}body{background:url(https://evil.example/x)',
      '--color-text-primary': '</style><script>1</script>',
      '--color-text-secondary': 'url("https://evil.example/beacon")',
      '--color-border-primary': 'rgb(63, 63, 70)',
    });
    expect(mapped).toEqual({ '--ggui-color-outline': 'rgb(63, 63, 70)' });
  });

  it('returns undefined when no key survives (or input is undefined)', () => {
    expect(mapHostPaletteToGguiVars(undefined)).toBeUndefined();
    expect(mapHostPaletteToGguiVars({})).toBeUndefined();
    expect(
      mapHostPaletteToGguiVars({ '--color-background-ghost': '#fff' }),
    ).toBeUndefined();
  });
});
