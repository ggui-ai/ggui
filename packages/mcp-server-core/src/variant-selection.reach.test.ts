/**
 * ggui#1611 — reach pin for the operator-default descriptions.
 *
 * The ops schemas, the ops tools and the console say the operator-default mark
 * "does not decide which blueprint serves a render". That is true only while no
 * production code calls the variant selector (`selectVariantWithLlm`, or a
 * selector's `.selectVariant(`), which is where the mark would be read to choose
 * what serves. **If this goes red, #1611's descriptions become false: update
 * them in the same change** (the decision to wire or delete the selector is
 * ggui#1607's).
 *
 * The scan covers every non-test source under `packages/`, found relative to
 * this file, so it runs the same in this repository and in the published
 * subtree.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The selector's own modules: its internal calls are the definition, not a caller. */
const SELECTOR_MODULES = new Set([
  'mcp-server-core/src/variant-selector-with-llm.ts',
  'mcp-server-core/src/blueprint-selector.ts',
]);
const CALL = /\bselectVariantWithLlm\(|\.selectVariant\(/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('dist.staging')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.(test|spec)\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const callers = sourceFiles(PACKAGES)
  .filter((path) => CALL.test(readFileSync(path, 'utf8')))
  .map((path) => relative(PACKAGES, path).split('\\').join('/'));

describe('the variant selector has no production caller (ggui#1611 reach pin)', () => {
  it('control: the scan reads the packages tree (it finds the selector module\'s own internal call)', () => {
    expect(callers).toContain('mcp-server-core/src/variant-selector-with-llm.ts');
  });

  it('no source outside the selector\'s own modules calls it: if this fails, #1611\'s descriptions are false', () => {
    expect(callers.filter((path) => !SELECTOR_MODULES.has(path))).toEqual([]);
  });
});
