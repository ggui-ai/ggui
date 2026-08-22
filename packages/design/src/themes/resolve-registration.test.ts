/**
 * resolveRegistrationVariables (ggui#598-C delivery, leg-3 seam) — the
 * design-package resolver the pod's hash-keyed LRU wraps: registration
 * documents in, emit-ready per-mode variable maps out. Parser-grounded
 * like the coverage validator: the values are exactly what parseTheme
 * emits, so delivered ladders can never drift from compiled ones.
 */
import { describe, expect, it } from 'vitest';
import { lightTheme } from './defaults/light.js';
import { darkTheme } from './defaults/dark.js';
import { resolveRegistrationVariables } from './resolve-registration.js';

describe('resolveRegistrationVariables', () => {
  it('resolves both modes to emit-ready variable maps with parser-exact values', () => {
    const resolved = resolveRegistrationVariables({
      light: lightTheme,
      dark: darkTheme,
    });
    expect(resolved.light['--ggui-color-surface']).toBeDefined();
    expect(resolved.dark['--ggui-color-surface']).toBeDefined();
    expect(resolved.light['--ggui-color-surface']).not.toBe(
      resolved.dark['--ggui-color-surface'],
    );
    // The numeric spacing grid (the s2 gate's first catch) rides too.
    expect(resolved.light['--ggui-spacing-4']).toBe('1rem');
    // Every key is namespace-legal; every value is declaration-safe
    // (no breakout chars — the wire schema re-validates, this pins the
    // producer side).
    for (const mode of ['light', 'dark'] as const) {
      for (const [k, v] of Object.entries(resolved[mode])) {
        expect(k).toMatch(/^--ggui-[a-zA-Z0-9-]+$/);
        expect(v).not.toMatch(/[;{}<>@]/);
      }
    }
  });

  it('is deterministic: same documents → deeply equal maps', () => {
    const a = resolveRegistrationVariables({ light: lightTheme, dark: darkTheme });
    const b = resolveRegistrationVariables({ light: lightTheme, dark: darkTheme });
    expect(a).toEqual(b);
  });
});
