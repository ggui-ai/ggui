import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as root from '../index.js';

// ggui#987 packaging pin: the theme-binding catalog is the wave's arbiter
// (guuey 1.3 judges its `-v2` composer against it), so it MUST be reachable
// through the package surface — the `exports` map subpath and the root
// barrel — not by a path into dist. Found by guuey-main's whole-set receipt
// on 5c2e9dc82 (reached by file path).
describe('theme-binding conformance is on the package surface (ggui#987)', () => {
  it('is exported from the root barrel', () => {
    expect(typeof root.runThemeBindingConformance).toBe('function');
    expect(root.THEME_MODE_CASES.map((c) => c.name)).toContain('theme-mode-order');
    expect(root.APP_THEME_CASES.map((c) => c.name)).toContain('app-theme-v2-platform-pin');
    expect(root.OVERLAY_HASH_CASES.map((c) => c.name)).toEqual(['overlay-hash-canonical']);
  });

  it('has its own subpath in the exports map, shaped like every other catalog', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { exports: Record<string, { types?: string; import?: string; default?: string }> };
    expect(pkg.exports['./theme-binding-conformance']).toEqual({
      types: './dist/theme-binding-conformance/index.d.ts',
      import: './dist/theme-binding-conformance/index.js',
      default: './dist/theme-binding-conformance/index.js',
    });
  });
});
