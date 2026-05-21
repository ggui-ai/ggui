/**
 * Runtime loader for the fixture catalog.
 *
 * Thin wrapper over `./fixtures/index.ts`'s static-imported arrays:
 * look up a fixture by name, list all names, get every fixture flat.
 * The JSON data is inlined into `dist/fixtures/` at build time by tsc's
 * `resolveJsonModule` pass — no filesystem reads, no async, no path
 * resolution concerns.
 *
 * Third-party consumers parsing the raw `.json` files (Python, Go,
 * Rust) skip this module entirely; it exists for in-process TS
 * consumers that want the authored JSON without reimplementing name
 * lookup.
 */
import { allFixtures } from './fixtures/index.js';
import type { TestCase } from './types.js';

const FIXTURES_BY_NAME: ReadonlyMap<string, TestCase> = new Map(
  allFixtures.map((fixture) => [fixture.name, fixture]),
);

/**
 * Look up one fixture by name. Throws `Error` if the name is not in
 * the catalog, so callers don't silently drop typos.
 */
export function loadFixture(name: string): TestCase {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('protocol-conformance: loadFixture requires a non-empty name');
  }
  const found = FIXTURES_BY_NAME.get(name);
  if (found === undefined) {
    throw new Error(
      `protocol-conformance: fixture '${name}' not found — list available names via listFixtures()`,
    );
  }
  return found;
}

/**
 * List every fixture name in the catalog, sorted lexicographically.
 * Deterministic output across filesystems / imports.
 */
export function listFixtures(): readonly string[] {
  return allFixtures.map((fixture) => fixture.name);
}

/**
 * Every fixture in the catalog, flat, in deterministic order.
 * Convenience wrapper — equivalent to `import { allFixtures } from
 * '@ggui-ai/protocol-conformance/fixtures'` but available through the
 * package root.
 */
export function loadAllFixtures(): readonly TestCase[] {
  return allFixtures;
}
