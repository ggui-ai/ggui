#!/usr/bin/env node
/**
 * Fix extensionless ESM imports in tsc output.
 *
 * tsc with moduleResolution:"bundler" emits `from './foo'` instead of `from './foo.js'`.
 * Node's ESM loader requires explicit extensions. This script adds `.js` to all
 * relative imports/exports in .js and .d.ts files under the given directory.
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

// Match: from './path' or from '../path' or export * from './path'
// Also handles re-exports: export { X } from './path'
// Captures the quote style and path, skips already-extensioned paths
const IMPORT_RE = /(from\s+['"])(\.\.?\/[^'"]*?)(['"])/g;

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
    } else if (entry.name.endsWith(".js")) {
      if (fixFile(fullPath)) fixedCount++;
    }
  }
  return fixedCount;
}

const count = walk(resolve(dir));
if (count > 0) {
  console.log(`Fixed ${count} files in ${dir}`);
}
