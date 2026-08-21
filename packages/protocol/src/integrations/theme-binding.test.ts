/**
 * Theme-binding resolution — THE one normative total order for
 * `themeId` / `themeMode` across the wire (ggui#598 leg 4).
 *
 * Before this module, the ladder existed only piecewise: the server
 * stamped via `resolveSliceTheme` (consolePick ?? static ?? sidecar)
 * and the client resolved via `resolveMountThemeMode` (stamped ??
 * sidecar ?? host) — the sidecar occupied a DIFFERENT rank position in
 * each local ladder, and total-order coherence silently depended on
 * every transport threading every layer. Nothing pinned the
 * composition. This suite pins it: the two projections MUST compose to
 * the single normative total order for every input combination.
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveThemeId,
  effectiveThemeMode,
  stampThemeId,
  stampThemeMode,
} from './theme-binding.js';

type Mode = 'light' | 'dark' | undefined;
const MODES: readonly Mode[] = ['light', 'dark', undefined];

describe('stampThemeMode — server projection', () => {
  it('ranks consolePick > staticConfig > sessionSidecar', () => {
    expect(
      stampThemeMode({ consolePick: 'dark', staticConfig: 'light', sessionSidecar: 'light' }),
    ).toBe('dark');
    expect(
      stampThemeMode({ staticConfig: 'dark', sessionSidecar: 'light' }),
    ).toBe('dark');
    expect(stampThemeMode({ sessionSidecar: 'dark' })).toBe('dark');
  });

  it('returns undefined — never a light default — when no layer resolves', () => {
    expect(stampThemeMode({})).toBeUndefined();
  });
});

describe('effectiveThemeMode — client projection', () => {
  it('ranks stamped > sessionSidecar > hostAnnounced', () => {
    expect(
      effectiveThemeMode({ stamped: 'light', sessionSidecar: 'dark', hostAnnounced: 'dark' }),
    ).toBe('light');
    expect(
      effectiveThemeMode({ sessionSidecar: 'dark', hostAnnounced: 'light' }),
    ).toBe('dark');
    expect(effectiveThemeMode({ hostAnnounced: 'dark' })).toBe('dark');
  });

  it('returns undefined — never a light default — when no layer resolves', () => {
    expect(effectiveThemeMode({})).toBeUndefined();
  });
});

describe('COMPOSITION LAW — the cross-side pin (ggui#595 finding: two resolvers, two ranks)', () => {
  it('client(server(...)) equals the normative total order consolePick > staticConfig > sessionSidecar > hostAnnounced, for ALL 81 combinations', () => {
    for (const consolePick of MODES) {
      for (const staticConfig of MODES) {
        for (const sessionSidecar of MODES) {
          for (const hostAnnounced of MODES) {
            const composed = effectiveThemeMode({
              stamped: stampThemeMode({ consolePick, staticConfig, sessionSidecar }),
              sessionSidecar,
              hostAnnounced,
            });
            const normative =
              consolePick ?? staticConfig ?? sessionSidecar ?? hostAnnounced;
            expect(composed).toBe(normative);
          }
        }
      }
    }
  });

  it('themeId composes to consolePick > renderOverride > staticConfig > sidecarName, for ALL 81 combinations', () => {
    // Distinct sentinel per layer so any rank swap is detectable.
    const LAYERS = {
      consolePick: 'id-pick',
      renderOverride: 'id-override',
      staticConfig: 'id-static',
      sidecarName: 'id-sidecar',
    } as const;
    const on = (v: string | undefined): string | undefined => v;
    for (const pick of [LAYERS.consolePick, undefined]) {
      for (const override of [LAYERS.renderOverride, undefined]) {
        for (const stat of [LAYERS.staticConfig, undefined]) {
          for (const sidecar of [LAYERS.sidecarName, undefined]) {
            const composed = effectiveThemeId({
              stamped: stampThemeId({
                consolePick: on(pick),
                renderOverride: on(override),
                staticConfig: on(stat),
              }),
              sidecarName: on(sidecar),
            });
            expect(composed).toBe(pick ?? override ?? stat ?? sidecar);
          }
        }
      }
    }
  });
});
