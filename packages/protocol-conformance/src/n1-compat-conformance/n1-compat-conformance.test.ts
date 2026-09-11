import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as root from '../index.js';
import { N1_COMPAT_CASES, runN1CompatConformance } from './index.js';

// ggui#1014 §3.6 — the N−1 catalog: previous-release payloads, tagged with the
// release's sha, accepted by today's parsers. A case failing = a receiver broke N−1.
describe('n1-compat conformance (ggui#1014 §3.6)', () => {
  it('ships the catalog — every case names its release sha and expects acceptance', () => {
    expect(N1_COMPAT_CASES.map((c) => c.name)).toEqual(['release-2-app-theme-v2', 'release-2-render-meta']);
    for (const c of N1_COMPAT_CASES) {
      expect(c.release.sha).toMatch(/^[0-9a-f]{9,40}$/);
      expect(c.expect).toBe('accepted');
    }
  });

  it("every previous-release payload passes today's parser", () => {
    const failing = runN1CompatConformance().filter((r) => !r.pass);
    expect(failing.map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
  });

  it('is on the package surface — root barrel and its own exports subpath', () => {
    expect(typeof root.runN1CompatConformance).toBe('function');
    expect(root.N1_COMPAT_CASES.length).toBe(2);
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
      exports: Record<string, { types?: string; import?: string; default?: string }>;
    };
    expect(pkg.exports['./n1-compat-conformance']).toEqual({
      types: './dist/n1-compat-conformance/index.d.ts',
      import: './dist/n1-compat-conformance/index.js',
      default: './dist/n1-compat-conformance/index.js',
    });
  });
});
