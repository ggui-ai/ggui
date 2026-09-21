/**
 * ggui#1221 — the evaluation dist must not inline the bundled-chromium
 * fallback. `@sparticuz/chromium` was a devDependency absent from tsup's
 * `external`, so tsup inlined its tree (tar-fs → bare-fs → bare-stream →
 * streamx → events-universal) into `dist/evaluation`, and esbuild's ESM
 * `__require("events")` stub threw `Dynamic require of "events" is not
 * supported` in every ESM consumer that reached `resolveLaunchOptions`'
 * fallback — the serving runtime and every self-hoster without
 * `PUPPETEER_EXECUTABLE_PATH`. Same posture as `puppeteer-core`: external
 * to the bundle, declared as an OPTIONAL peer so a consumer who wants the
 * fallback installs it. RED before the entries existed, GREEN after.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkgDir = resolve(__dirname, '../..');

describe('evaluation dist externals — ggui#1221', () => {
  it("tsup keeps '@sparticuz/chromium' external, beside 'puppeteer-core'", () => {
    const tsup = readFileSync(resolve(pkgDir, 'tsup.config.ts'), 'utf8');
    const external = tsup.slice(tsup.indexOf('external: ['), tsup.indexOf('],', tsup.indexOf('external: [')));
    expect(external).toContain("'puppeteer-core'");
    expect(external).toContain("'@sparticuz/chromium'");
  });

  it('package.json declares @sparticuz/chromium as an optional peer (the puppeteer-core posture)', () => {
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(pkg.peerDependencies?.['@sparticuz/chromium']).toMatch(/^\^\d+/);
    expect(pkg.peerDependenciesMeta?.['@sparticuz/chromium']?.optional).toBe(true);
    expect(pkg.peerDependenciesMeta?.['puppeteer-core']?.optional).toBe(true);
  });
});
