/**
 * Structural property test — the registry-core barrel (`index.ts`)
 * must never statically load either of its native-binding
 * dependencies, `oxc-parser` (used by `ops/conformance.ts`) and
 * `esbuild` (used by `ops/compile.ts`). Both are lazily loaded on
 * first actual use — a memoized dynamic `import()` for `oxc-parser`
 * (ESM-only, no synchronous load path) and a memoized `require()` via
 * `createRequire` for `esbuild` (plain CommonJS, so the synchronous
 * path stays available). A caller that only needs an unrelated
 * operation (e.g. search) must never pay either dependency's init
 * cost, or risk a platform-specific native-binding resolution
 * failure, just by importing this package's entry point.
 *
 * Mechanism — static analysis over the TypeScript import/export
 * graph, not runtime introspection. Two reasons runtime introspection
 * doesn't fit here:
 *
 *   1. Node has no stable public API for "was module X loaded" after
 *      the fact — only experimental loader hooks (`module.register`
 *      + a custom resolve/load interceptor), which would tie this
 *      test to a specific Node version and add real complexity for a
 *      property that's fundamentally about source structure.
 *   2. Vitest runs every test file in this package inside one shared
 *      worker/module registry by default. `conformance.test.ts` and
 *      `compile.test.ts` legitimately trigger the lazy loaders
 *      directly — by the time a runtime "is it loaded" check ran, a
 *      sibling test file would already have contaminated the shared
 *      module cache, making the check meaningless.
 *
 * Walking the STATIC import/export graph from the barrel sidesteps
 * both problems: it's deterministic, fast, and directly verifies the
 * property that broke in production — a top-level
 * `import ... from 'oxc-parser'` (or `'esbuild'`) DECLARATION
 * reachable from `index.ts`. A lazy `import('oxc-parser')` CALL
 * EXPRESSION inside a function body is invisible to this walk by
 * design: it's not a declaration, so it can never cause a transitive
 * load at module-evaluation time — which is exactly the distinction
 * this test exists to enforce.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));
const BARREL_PATH = resolve(SRC_ROOT, 'index.ts');
const NATIVE_DEPS: readonly string[] = ['oxc-parser', 'esbuild'];

/**
 * One source file's import/export specifiers, split by what the graph
 * walk needs them for: `relativeSpecifiers` are edges to keep walking
 * (this repo's convention is `./foo.js`-suffixed relative specifiers
 * resolving to `./foo.ts` on disk); `valueSpecifiers` are bare
 * (package-name) specifiers referenced by a VALUE-level import or
 * re-export — type-only imports (`import type {...}`, `export type
 * {...} from '...'`) are excluded because they're erased at compile
 * time and never cause a runtime module load.
 */
interface FileEdges {
  readonly relativeSpecifiers: readonly string[];
  readonly valueSpecifiers: readonly string[];
}

/**
 * Pure classifier — parses TypeScript source text (not a file) into
 * its import/export edges. Split out from {@link parseEdges} so the
 * classification rules (relative vs. bare specifier, type-only vs.
 * value) are independently unit-testable against synthetic snippets,
 * not just observable indirectly through the whole-package walk.
 */
function parseSourceEdges(fileName: string, source: string): FileEdges {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const relativeSpecifiers: string[] = [];
  const valueSpecifiers: string[] = [];

  const record = (specifier: string, isTypeOnly: boolean): void => {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      relativeSpecifiers.push(specifier);
      return;
    }
    if (!isTypeOnly) valueSpecifiers.push(specifier);
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      record(stmt.moduleSpecifier.text, stmt.importClause?.isTypeOnly === true);
      continue;
    }
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      record(stmt.moduleSpecifier.text, stmt.isTypeOnly);
    }
  }

  return { relativeSpecifiers, valueSpecifiers };
}

function parseEdges(filePath: string): FileEdges {
  return parseSourceEdges(filePath, readFileSync(filePath, 'utf-8'));
}

/**
 * Resolve a relative `./foo.js` specifier (this repo's ESM-with-`.js`-
 * suffix convention, even though the source is `.ts`) to the on-disk
 * `.ts` file it maps to.
 */
function resolveRelative(fromFile: string, specifier: string): string {
  const withoutExt = specifier.replace(/\.js$/, '');
  return resolve(dirname(fromFile), `${withoutExt}.ts`);
}

/**
 * Breadth-first walk of the static import/export graph starting from
 * `entry`, following only relative specifiers (intra-package edges).
 * Returns every reachable file's absolute path, including `entry`
 * itself.
 */
function walkGraph(entry: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const specifier of parseEdges(current).relativeSpecifiers) {
      queue.push(resolveRelative(current, specifier));
    }
  }
  return visited;
}

describe('registry-core barrel — lazy native-dependency load (structural property)', () => {
  it('never statically imports oxc-parser or esbuild anywhere in the graph reachable from index.ts', () => {
    const reachable = walkGraph(BARREL_PATH);

    // Sanity check — the walk must actually traverse the two files
    // whose lazy-load pattern this property protects. A walker bug
    // that silently stopped short of them would make the assertion
    // below pass vacuously.
    const conformancePath = resolve(SRC_ROOT, 'ops/conformance.ts');
    const compilePath = resolve(SRC_ROOT, 'ops/compile.ts');
    expect(reachable.has(conformancePath)).toBe(true);
    expect(reachable.has(compilePath)).toBe(true);

    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const file of reachable) {
      for (const specifier of parseEdges(file).valueSpecifiers) {
        if (NATIVE_DEPS.includes(specifier)) {
          offenders.push({ file, specifier });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('negative control — the lazy import()/require() call expressions ARE present (proves the walk distinguishes lazy from eager)', () => {
    // If this control ever fails, the positive assertion above would
    // be trivially satisfied by deleting the lazy-load pattern
    // entirely rather than by keeping it lazy — this pins that the
    // deferred-load calls still exist, not just that no eager
    // declaration does.
    const conformanceSource = readFileSync(resolve(SRC_ROOT, 'ops/conformance.ts'), 'utf-8');
    const compileSource = readFileSync(resolve(SRC_ROOT, 'ops/compile.ts'), 'utf-8');
    expect(conformanceSource).toContain("import('oxc-parser')");
    expect(compileSource).toContain("nodeRequire('esbuild')");
  });
});

describe('parseSourceEdges — classification correctness (unit)', () => {
  // These exercise the classifier directly against synthetic snippets,
  // rather than only indirectly through the real files it happens to
  // walk correctly today — a wrong `isTypeOnly` or specifier-bucketing
  // rule could still pass the whole-package test above by coincidence
  // (e.g. if the real files never exercised the buggy branch).

  it('classifies a value-level bare-specifier import as a value specifier', () => {
    const edges = parseSourceEdges('synthetic.ts', "import { parseSync } from 'oxc-parser';");
    expect(edges.valueSpecifiers).toEqual(['oxc-parser']);
    expect(edges.relativeSpecifiers).toEqual([]);
  });

  it('excludes a fully type-only import from value specifiers', () => {
    const edges = parseSourceEdges('synthetic.ts', "import type { Foo } from 'oxc-parser';");
    expect(edges.valueSpecifiers).toEqual([]);
  });

  it('excludes a type-only re-export from value specifiers', () => {
    const edges = parseSourceEdges('synthetic.ts', "export type { Foo } from 'oxc-parser';");
    expect(edges.valueSpecifiers).toEqual([]);
  });

  it('classifies a value-level re-export as a value specifier', () => {
    const edges = parseSourceEdges('synthetic.ts', "export { foo } from 'esbuild';");
    expect(edges.valueSpecifiers).toEqual(['esbuild']);
  });

  it('produces no declaration-level edges for a dynamic import() call expression', () => {
    const edges = parseSourceEdges(
      'synthetic.ts',
      "async function load() { const m = await import('oxc-parser'); return m; }",
    );
    expect(edges.valueSpecifiers).toEqual([]);
    expect(edges.relativeSpecifiers).toEqual([]);
  });

  it('buckets relative specifiers separately from value (bare) specifiers', () => {
    const edges = parseSourceEdges(
      'synthetic.ts',
      "import { x } from './helper.js';\nimport { y } from 'esbuild';",
    );
    expect(edges.relativeSpecifiers).toEqual(['./helper.js']);
    expect(edges.valueSpecifiers).toEqual(['esbuild']);
  });
});
