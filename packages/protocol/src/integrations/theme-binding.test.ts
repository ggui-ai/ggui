/**
 * Theme-binding resolution — THE one normative total order for
 * `themeId` / `themeMode` across the wire (ggui#598 leg 4; flipped by
 * ggui#987 D4: the embedding host owns runtime mode).
 *
 * The server stamps (`consolePick ?? staticConfig ?? sessionSidecar`,
 * blind to the host) and the client resolves (`hostAnnounced ?? stamped
 * ?? sessionSidecar`). This suite pins that the two projections compose
 * to the single normative total order for every input combination, and
 * that the sidecar's `name` is no longer a `themeId` layer (D2 = B).
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

describe('stampThemeMode — server projection (unchanged by ggui#987)', () => {
  it('ranks consolePick > staticConfig > sessionSidecar', () => {
    expect(stampThemeMode({ consolePick: 'dark', staticConfig: 'light', sessionSidecar: 'light' })).toBe('dark');
    expect(stampThemeMode({ staticConfig: 'light', sessionSidecar: 'dark' })).toBe('light');
    expect(stampThemeMode({ sessionSidecar: 'dark' })).toBe('dark');
  });
  it('returns undefined — never a light default — when no layer resolves', () => {
    expect(stampThemeMode({})).toBeUndefined();
  });
});

describe('effectiveThemeMode — client projection (ggui#987 D4: the host owns runtime mode)', () => {
  it('ranks hostAnnounced > stamped > sessionSidecar', () => {
    expect(effectiveThemeMode({ stamped: 'light', sessionSidecar: 'light', hostAnnounced: 'dark' })).toBe('dark');
    expect(effectiveThemeMode({ stamped: 'light', sessionSidecar: 'dark' })).toBe('light');
    expect(effectiveThemeMode({ sessionSidecar: 'dark' })).toBe('dark');
  });
  it('returns undefined — never a light default — when no layer resolves', () => {
    expect(effectiveThemeMode({})).toBeUndefined();
  });
});

describe('COMPOSITION LAW — the cross-side pin', () => {
  it('client(server(...)) equals the normative order hostAnnounced > consolePick > staticConfig > sessionSidecar, for ALL 81 combinations', () => {
    for (const consolePick of MODES) {
      for (const staticConfig of MODES) {
        for (const sessionSidecar of MODES) {
          for (const hostAnnounced of MODES) {
            const composed = effectiveThemeMode({
              stamped: stampThemeMode({ consolePick, staticConfig, sessionSidecar }),
              sessionSidecar,
              hostAnnounced,
            });
            expect(composed).toBe(hostAnnounced ?? consolePick ?? staticConfig ?? sessionSidecar);
          }
        }
      }
    }
  });

  it('themeId composes to consolePick > renderOverride > staticConfig, for ALL 8 combinations — no sidecar leg', () => {
    const LAYERS = { consolePick: 'id-pick', renderOverride: 'id-override', staticConfig: 'id-static' } as const;
    for (const pick of [LAYERS.consolePick, undefined]) {
      for (const override of [LAYERS.renderOverride, undefined]) {
        for (const stat of [LAYERS.staticConfig, undefined]) {
          const composed = effectiveThemeId({
            stamped: stampThemeId({ consolePick: pick, renderOverride: override, staticConfig: stat }),
          });
          expect(composed).toBe(pick ?? override ?? stat);
        }
      }
    }
  });
});
