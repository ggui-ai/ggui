import { describe, expect, it } from 'vitest';

import { APP_THEME_CASES, OVERLAY_HASH_CASES, THEME_MODE_CASES, runThemeBindingConformance } from './index.js';

/**
 * The kit grades `@ggui-ai/protocol`'s theme binding directly (ggui#987).
 * Three of these cases were promoted at the version BEFORE the revision,
 * passed there, and failed when it landed — VERSION-POLICY §1.1's receipt
 * that named the revision breaking; they now pin the new contract.
 */
describe('theme-binding conformance (pure-function catalog)', () => {
  it('ships the catalog', () => {
    expect(THEME_MODE_CASES.map((c) => c.name)).toEqual(['theme-mode-order', 'theme-mode-absence', 'theme-mode-default-when-silent-host']);
    expect(APP_THEME_CASES.map((c) => c.name)).toEqual(['app-theme-v1-one-palette', 'app-theme-v1-base', 'app-theme-v2-accepted', 'app-theme-v2-missing-dark', 'app-theme-v2-no-hash', 'app-theme-v2-platform-pin', 'app-theme-v2-label-too-long']);
    expect(OVERLAY_HASH_CASES.map((c) => c.name)).toEqual(['overlay-hash-canonical']);
  });

  it('every case passes against the protocol as shipped', async () => {
    const failing = (await runThemeBindingConformance()).filter((r) => !r.pass);
    expect(failing.map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
  });
});
