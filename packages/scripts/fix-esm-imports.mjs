#!/usr/bin/env node
/**
 * Fix extensionless ESM imports in tsc output.
 *
 * tsc with moduleResolution:"bundler" emits `from './foo'` instead of `from './foo.js'`.
 * Node's ESM loader requires explicit extensions, and so does a TypeScript
 * consumer under `moduleResolution: NodeNext` — for DECLARATIONS as much as
 * for runtime modules: a `dist/index.d.ts` that re-exports `from './x'`
 * resolves to nothing there (TS2835 / TS2305; ggui#846, found by a NodeNext
 * consumer of @ggui-ai/protocol 0.14.0). This script adds `.js` to every
 * relative specifier — `from '…'` and `import('…')` — in every .js and
 * .d.ts file under the given directory. Pinned by fix-esm-imports.test.mjs.
 *
 * Usage: node scripts/fix-esm-imports.mjs dist/
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: fix-esm-imports.mjs <dist-dir>");
  process.exit(1);
}

// Match: from './path' or from '../path' (imports, re-exports, export *) and
// the type-position form declarations use, import('./path').T.
// Captures the quote style and path, skips already-extensioned paths
// A bare '.' or '..' (a directory, no slash) is matched too — tsc emits
// import('..').T in declarations for types referenced from the barrel.
const IMPORT_RE = /((?:from\s+|import\()\s*['"])(\.\.?(?:\/[^'"]*?)?)(['"])/g;

function needsExtension(importPath, fromFile) {
  // Already has an extension
  if (/\.\w+$/.test(importPath)) return null;

  const base = resolve(dirname(fromFile), importPath);

  // Check if it's a directory with index.js
  if (existsSync(base) && statSync(base).isDirectory()) {
    if (existsSync(join(base, "index.js"))) return importPath + "/index.js";
    if (existsSync(join(base, "index.d.ts"))) return importPath + "/index.js";
  }

  // Add .js extension
  if (existsSync(base + ".js") || existsSync(base + ".d.ts")) {
    return importPath + ".js";
  }

  return null;
}

function fixFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  let changed = false;

  const fixed = content.replace(IMPORT_RE, (match, prefix, importPath, suffix) => {
    const resolved = needsExtension(importPath, filePath);
    if (resolved) {
      changed = true;
      return prefix + resolved + suffix;
    }
    return match;
  });

  if (changed) {
    writeFileSync(filePath, fixed);
    return true;
  }
  return false;
}

function walk(dirPath) {
  let fixedCount = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      fixedCount += walk(fullPath);
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      // Declarations too — the .js pass alone leaves every .d.ts unresolvable
      // for a NodeNext consumer (ggui#846).
      if (fixFile(fullPath)) fixedCount++;
    }
  }
  return fixedCount;
}

const count = walk(resolve(dir));
if (count > 0) {
  console.log(`Fixed ${count} files in ${dir}`);
}
