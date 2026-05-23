// Tiny ESM resolver hook that re-resolves extensionless relative imports
// (`./foo`, `../bar`) to their on-disk `.ts` siblings. Used only by the
// `audit:wcag` script so it can import the package source directly
// (which uses bundler-style extensionless paths).
//
// No runtime behavior beyond resolution — `--experimental-strip-types`
// still does the TS→JS transform on load.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

export function resolve(specifier, context, nextResolve) {
  // Only intervene for relative specifiers that are missing an extension.
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.[a-zA-Z0-9]+$/.test(specifier)
  ) {
    const parentDir = context.parentURL
      ? dirname(fileURLToPath(context.parentURL))
      : process.cwd();
    const base = resolvePath(parentDir, specifier);

    const candidates = [
      `${base}.ts`,
      `${base}.mts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.mjs`,
      `${base}/index.ts`,
      `${base}/index.js`,
    ];

    for (const c of candidates) {
      if (existsSync(c)) {
        return nextResolve(pathToFileURL(c).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
