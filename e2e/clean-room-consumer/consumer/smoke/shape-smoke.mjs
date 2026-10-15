#!/usr/bin/env node
/**
 * Clean-room shape smoke.
 *
 * Runs INSIDE the consumer project, whose node_modules came entirely
 * from Verdaccio. For every installed @ggui-ai/* package it checks the
 * published SHAPE, without loading anything — so it also covers the
 * packages plain Node cannot load (a React Native host helper):
 *
 *   1. entry targets — `main`, `module` and every non-`types` target in
 *      `exports` is a shipped JavaScript file, never TypeScript source
 *      (`.ts`, `.tsx`, `.mts`, `.cts`). A bundler that is not configured
 *      for TypeScript in node_modules cannot compile one.
 *   2. type targets — `types` / `typings` and every `types` condition is
 *      a declaration file (`.d.ts`, `.d.mts`, `.d.cts`) that exists.
 *   3. relative specifiers — every relative `import … from`, `export …
 *      from`, `import()` and `require()` in a shipped JavaScript file
 *      resolves to a shipped file. Files are parsed (acorn), so a
 *      specifier-shaped string in a comment or a template literal is
 *      not mistaken for an import. A specifier with an extension must
 *      name an existing file exactly: Metro does not map `./x.js` to
 *      `./x.ts`, and Node does not either. One without an extension
 *      must resolve as a bundler would (`.js`, `.mjs`, `.cjs`, `.json`,
 *      or a directory's `index.js`).
 *
 * Usage: SHAPE_TOOLS=<dir> node smoke/shape-smoke.mjs [<dir holding @ggui-ai package dirs>]
 * SHAPE_TOOLS is an npm prefix holding acorn and acorn-walk, installed
 * apart from the consumer so the consumer's dependency tree stays exactly
 * what the packages declare. With no argument it reads the consumer's own
 * node_modules/@ggui-ai.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative, resolve } from 'node:path';

const toolsDir = process.env.SHAPE_TOOLS;
if (!toolsDir) {
  console.error('  shape smoke: set SHAPE_TOOLS to an npm prefix holding acorn and acorn-walk');
  process.exit(1);
}
const toolsRequire = createRequire(join(resolve(toolsDir), 'package.json'));
const acorn = toolsRequire('acorn');
const walk = toolsRequire('acorn-walk');

const here = dirname(fileURLToPath(import.meta.url));
const scopeDir = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(here), 'node_modules', '@ggui-ai');

const TS_SOURCE = /\.(ts|tsx|mts|cts)$/;
const DECLARATION = /\.d\.(ts|mts|cts)$/;
const JS_FILE = /\.(js|mjs|cjs)$/;
const BUNDLER_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json'];

const RELATIVE = /^\.{1,2}\//;

/** Parse a shipped file as a module, falling back to a script (CommonJS). */
function parse(source) {
  const options = { ecmaVersion: 'latest', allowHashBang: true };
  try {
    return acorn.parse(source, { ...options, sourceType: 'module' });
  } catch {
    return acorn.parse(source, { ...options, sourceType: 'script', allowReturnOutsideFunction: true });
  }
}

/** Every literal relative specifier the file imports, re-exports or requires. */
function relativeSpecifiers(ast) {
  const found = [];
  const take = (node) => {
    if (node && node.type === 'Literal' && typeof node.value === 'string' && RELATIVE.test(node.value)) {
      found.push(node.value);
    }
  };
  walk.simple(ast, {
    ImportDeclaration: (n) => take(n.source),
    ExportNamedDeclaration: (n) => take(n.source),
    ExportAllDeclaration: (n) => take(n.source),
    ImportExpression: (n) => take(n.source),
    CallExpression: (n) => {
      if (n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments.length === 1) {
        take(n.arguments[0]);
      }
    },
  });
  return found;
}

/** Every `[condition path, target]` leaf of an `exports` value. */
function exportLeaves(value, path = []) {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => exportLeaves(v, [...path, String(i)]));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => exportLeaves(v, [...path, k]));
  }
  return [];
}

/** Every shipped JavaScript file under a package, outside nested node_modules. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (JS_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

function isFile(p) {
  return existsSync(p) && statSync(p).isFile();
}

function resolvesAsWritten(fromFile, specifier) {
  const target = resolve(dirname(fromFile), specifier);
  if (extname(specifier) !== '') return isFile(target);
  if (BUNDLER_EXTENSIONS.some((ext) => isFile(target + ext))) return true;
  return isFile(join(target, 'index.js'));
}

function checkPackage(pkgDir) {
  const problems = [];
  const meta = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const name = meta.name;

  const runtimeTargets = [];
  const typeTargets = [];
  for (const field of ['main', 'module']) {
    if (typeof meta[field] === 'string') runtimeTargets.push([field, meta[field]]);
  }
  for (const field of ['types', 'typings']) {
    if (typeof meta[field] === 'string') typeTargets.push([field, meta[field]]);
  }
  for (const [path, target] of exportLeaves(meta.exports)) {
    const where = `exports${path.map((k) => `[${JSON.stringify(k)}]`).join('')}`;
    if (path[path.length - 1] === 'types') typeTargets.push([where, target]);
    else runtimeTargets.push([where, target]);
  }

  for (const [where, target] of runtimeTargets) {
    if (TS_SOURCE.test(target) && !DECLARATION.test(target)) {
      problems.push(`${where} → ${target} is TypeScript source, not shipped JavaScript`);
    } else if (!target.includes('*') && !isFile(join(pkgDir, target))) {
      problems.push(`${where} → ${target} is not in the package`);
    }
  }
  for (const [where, target] of typeTargets) {
    if (!DECLARATION.test(target)) {
      problems.push(`${where} → ${target} is not a declaration file`);
    } else if (!target.includes('*') && !isFile(join(pkgDir, target))) {
      problems.push(`${where} → ${target} is not in the package`);
    }
  }

  let specifiers = 0;
  for (const file of jsFiles(pkgDir)) {
    let ast;
    try {
      ast = parse(readFileSync(file, 'utf8'));
    } catch (err) {
      problems.push(`${relative(pkgDir, file)}: not parseable as JavaScript (${String(err && err.message)})`);
      continue;
    }
    for (const specifier of relativeSpecifiers(ast)) {
      specifiers++;
      if (!resolvesAsWritten(file, specifier)) {
        problems.push(`${relative(pkgDir, file)}: '${specifier}' does not resolve to a shipped file`);
      }
    }
  }
  return { name, problems, specifiers };
}

const pkgDirs = readdirSync(scopeDir)
  .map((d) => join(scopeDir, d))
  .filter((d) => isFile(join(d, 'package.json')))
  .sort();

let failed = 0;
let specifierTotal = 0;
for (const dir of pkgDirs) {
  const { name, problems, specifiers } = checkPackage(dir);
  specifierTotal += specifiers;
  if (problems.length === 0) {
    console.log(`  ok    ${name}  (${specifiers} relative specifiers)`);
    continue;
  }
  failed++;
  console.error(`  FAIL  ${name}`);
  for (const p of problems.slice(0, 10)) console.error(`          ${p}`);
  if (problems.length > 10) console.error(`          … and ${problems.length - 10} more`);
}

console.log('');
console.log(
  `  ${pkgDirs.length - failed}/${pkgDirs.length} packages have a clean published shape` +
    ` (${specifierTotal} relative specifiers checked)`,
);
if (pkgDirs.length === 0) {
  console.error('\n  shape smoke FAILED — no @ggui-ai packages found to check');
  process.exit(1);
}
if (failed > 0) {
  console.error(`\n  shape smoke FAILED — ${failed} package(s)`);
  process.exit(1);
}
console.log('  shape smoke passed');
