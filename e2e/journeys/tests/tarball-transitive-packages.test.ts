/**
 * Drift check — `TRANSITIVE_PACKAGES` in the tarball-install harness
 * must stay in lockstep with the real workspace dep graph of
 * `@ggui-ai/cli`.
 *
 * Fast vitest (no pack, no npm install). Shares the diff helper with
 * the harness's own `packAndInstall()` preflight so both call sites
 * agree on what "drift" means.
 *
 * ## Why this test exists
 *
 * The tarball-install harness maintains a hand-curated list of every
 * `@ggui-ai/*` workspace package the CLI pulls in transitively. When
 * that list drifts — a new package lands in the graph but the list
 * isn't updated — tarball smoke breaks with an opaque
 * `npm error 404 @ggui-ai/<missing>` deep inside `npm install`. The
 * most recent reproducer was `@ggui-ai/ui-gen` (Slice 7 generation
 * wiring) — smoke was red for ~a release cycle before anyone noticed.
 *
 * This test asserts the list matches the computed closure (reachable
 * via `dependencies` / `peerDependencies` / `optionalDependencies`
 * — NOT devDependencies, which npm doesn't install from a tarball).
 * A missing entry OR an extra entry both fail the test with a
 * one-line delta pointing at the exact gap.
 *
 * Runs under `vitest run` (Lane 3-style), not Playwright — it doesn't
 * boot a server. Sub-second end-to-end: one readdir + ~15 package.json
 * parses. Anchored under `tests/` so it ships with the sibling Lane-3
 * fixture contract tests in one runner config.
 */
import { describe, expect, it } from 'vitest';
import {
  computeExpectedTarballTransitives,
  diffTarballTransitiveGraph,
  TARBALL_CLI_PACKAGE,
  TARBALL_TRANSITIVE_PACKAGES,
} from './tarball-install-harness';

describe('TARBALL_TRANSITIVE_PACKAGES — workspace graph drift check', () => {
  it('contains exactly the runtime-transitive @ggui-ai/* packages reachable from @ggui-ai/cli', () => {
    const { missing, extra } = diffTarballTransitiveGraph();
    // Missing entries break the smoke `npm install` with a 404.
    // Extra entries are less acute (the tarball is produced but goes
    // unused), but we still flag them so the list doesn't accumulate
    // dead references that could mask a real drift later.
    expect(missing, formatMissing(missing)).toEqual([]);
    expect(extra, formatExtra(extra)).toEqual([]);
  });

  it('each declared entry resolves to a real packages/<dir> on disk', () => {
    const expected = computeExpectedTarballTransitives();
    const byName = new Map(expected.map((e) => [e.pkgName, e.dir] as const));
    for (const { dir, pkgName } of TARBALL_TRANSITIVE_PACKAGES) {
      expect(
        byName.has(pkgName),
        `declared entry '${pkgName}' is not reachable from ${TARBALL_CLI_PACKAGE.pkgName} in the workspace dep graph`,
      ).toBe(true);
      expect(
        byName.get(pkgName),
        `declared dir for '${pkgName}' does not match the packages/<dir> on disk`,
      ).toBe(dir);
    }
  });

  it('every reachable @ggui-ai/* package that ggui-cli pulls in has a tarball override', () => {
    // Symmetric of the prior test — guards against future packages
    // being added that the declared list silently misses.
    const expected = computeExpectedTarballTransitives();
    const declaredNames = new Set(
      TARBALL_TRANSITIVE_PACKAGES.map((e) => e.pkgName),
    );
    for (const { pkgName } of expected) {
      expect(
        declaredNames.has(pkgName),
        `reachable package '${pkgName}' is not in TRANSITIVE_PACKAGES — add { dir:'<packages/<dir>>', pkgName:'${pkgName}' } or tarball-install will 404 against the public registry`,
      ).toBe(true);
    }
  });
});

function formatMissing(
  missing: ReadonlyArray<{ dir: string; pkgName: string }>,
): string {
  if (missing.length === 0) return '';
  return (
    `TRANSITIVE_PACKAGES is missing ${missing.length} entry(ies) the CLI graph requires:\n` +
    missing.map((m) => `  - { dir: '${m.dir}', pkgName: '${m.pkgName}' }`).join('\n')
  );
}

function formatExtra(
  extra: ReadonlyArray<{ dir: string; pkgName: string }>,
): string {
  if (extra.length === 0) return '';
  return (
    `TRANSITIVE_PACKAGES has ${extra.length} entry(ies) NOT reachable from the CLI via runtime deps (dead refs):\n` +
    extra.map((m) => `  - '${m.pkgName}'`).join('\n')
  );
}
