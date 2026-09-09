import { describe, expect, it } from 'vitest';

import { APP_THEME_CASES, THEME_MODE_CASES, runThemeBindingConformance } from './index.js';

/**
 * The kit grades `@ggui-ai/protocol`'s theme binding directly. Every case
 * here PASSES at the version it was promoted from; a change that fails one
 * is breaking by VERSION-POLICY §1.1 — that is the receipt ggui#987 uses.
 */
describe('theme-binding conformance (pure-function catalog)', () => {
  it('ships the promoted cases', () => {
    expect(THEME_MODE_CASES.map((c) => c.name)).toEqual(['theme-mode-order', 'theme-mode-absence']);
    expect(APP_THEME_CASES.map((c) => c.name)).toEqual(['app-theme-v1-one-palette', 'app-theme-v1-base']);
  });

  it('every case passes against the protocol as shipped', () => {
    const failing = runThemeBindingConformance().filter((r) => !r.pass);
    expect(failing.map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
  });
});
