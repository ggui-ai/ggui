/**
 * Pin (ggui#1570): `Blueprint.clonedFrom` is provenance about the ROW, and
 * nothing that serves reads it.
 *
 * A copied row carries its original's bytes, `source` and `build`, which are
 * true about the bytes; `clonedFrom` is what says the row is not a production.
 * The contract says matching, serving and variance ignore it. That is an
 * absence of behaviour, which running a render and watching nothing happen
 * cannot show (it would pass as well if the path were broken). So the guard is
 * reach: the open packages' non-test sources that name `clonedFrom` are exactly
 * the modules below, each one a carrier or a grader, none a serving path. A
 * matcher, the handshake decision, the render handler or a store's lookup that
 * starts reading it adds a file and fails here, which is the review this pin
 * exists to force.
 *
 * Scope stated honestly: this walks `oss/packages/<pkg>/src` for every open
 * package, `.ts`/`.tsx` sources outside tests. It reads names, not behaviour: a
 * serving module that reached the field by a computed key would pass. And it
 * does not see code outside the open packages: a deployment's own serving code
 * needs a pin of its own.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `oss/packages`: this file is `oss/packages/mcp-server-handlers/src/<this>`. */
const PACKAGES = join(HERE, '..', '..');

/** Every open-package source that may name the field, and why. */
const ALLOWED: Readonly<Record<string, string>> = {
  'protocol/src/types/blueprint.ts': 'declares the field',
  'protocol/src/schemas/blueprint.ts': "the strict row schema's member",
  'protocol/src/version.ts': 'the wire ledger entry (prose)',
  'mcp-server-core/src/contract-tests/blueprint-store.conformance.ts': 'the store kit: a store persists it verbatim',
  'protocol-conformance/src/n1-compat-conformance/index.ts': "the N−1 grader: kept as sent across the list's parse",
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function openPackageSources(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, 'src');
    // A package without `src/` (a config-only or assets package) has no sources to walk.
    if (!existsSync(src) || !statSync(src).isDirectory()) continue;
    out.push(...sources(src));
  }
  return out;
}

describe('Blueprint.clonedFrom reaches no serving path (ggui#1570)', () => {
  it('the open sources that name clonedFrom are exactly the carriers and graders', () => {
    const naming = openPackageSources()
      .filter((file) => readFileSync(file, 'utf8').includes('clonedFrom'))
      .map((file) => relative(PACKAGES, file).split('\\').join('/'))
      .sort();
    expect(naming).toEqual(Object.keys(ALLOWED).sort());
  });

  it('the walk sees the open packages (control: a file known to exist is in it)', () => {
    const all = openPackageSources().map((file) => relative(PACKAGES, file).split('\\').join('/'));
    expect(all).toContain('mcp-server-handlers/src/renders/render.ts');
    expect(all).toContain('protocol/src/schemas/blueprint.ts');
    expect(all.length).toBeGreaterThan(500);
  });
});
