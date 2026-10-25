// The `@modelcontextprotocol/ext-apps` zod shim for the iframe-runtime bundle
// (ggui#2032).
//
// ext-apps' published `dist/src/app.js` reaches zod three ways:
// `import { z as … } from "zod/v4"` (twice) and `await import("zod/v4")`. zod's
// `z` is a re-exported namespace OBJECT, and esbuild cannot shake members off
// one; a dynamic import materialises the whole module. Either form keeps all
// of zod in the bundle — its 64 locale tables included, 265 KB raw that no
// card ever selects. Our own packages import zod as a namespace
// (`import * as z`), which esbuild shakes; this plugin gives ext-apps' three
// imports the same outcome without touching its source.
//
// How: an esbuild `onResolve` scoped to importers inside
// `/@modelcontextprotocol/ext-apps/` and the specifier `zod/v4` redirects to a
// virtual module that re-exports every name of the REAL `zod/v4` (and of
// `zod/v4/core`, as `core`) through named imports — the shakable form — and
// builds `z` and `core` as plain object literals of those names. The names are
// enumerated from the installed zod at build time, so a zod upgrade that adds
// an export needs no edit here. Two names are withheld, on purpose: `locales`
// (the tables themselves) on both `z` and `core` is a getter that throws, so a
// consumer reaching for a table fails at the access with the reason, instead
// of reading `undefined`.
//
// Three conditions hold, each checked at build time over the files esbuild
// actually resolved through the shim, so the adaptation cannot outlive what it
// adapts to or silently change meaning:
//   1. one zod instance — the shim re-exports from the same resolved `zod/v4`
//      the rest of the bundle uses (the bundle-size gate separately reads one
//      install location and one `zod/v4/core` entry);
//   2. member-only use — every use of a zod binding in the importing files is
//      a member access (`Q.object(…)`); a spread, `Object.*(Q)` or a bare pass
//      would reach the throwing getter or copy a partial object, so it fails
//      the build and names the site;
//   3. still needed — if no file under ext-apps imports `zod/v4` any more, the
//      build fails with "remove the ggui#2032 shim": a shim for a form that is
//      gone is dead code.
import { readFileSync } from 'node:fs';

export const SHIM_NAMESPACE = 'ggui-zod-shim';
export const SHIM_PATH = 'ext-apps-zod';
const EXT_APPS_IMPORTER = /\/@modelcontextprotocol\/ext-apps\//;
const ZOD_V4 = /^zod\/v4$/;
const LOCALES_MESSAGE =
  "zod's locale tables are not bundled in the ggui iframe runtime (ggui#2032); configure a locale in the host, not in the frame";

/**
 * The virtual module's source, from the export names of the installed
 * `zod/v4` and `zod/v4/core`. Every name goes through an aliased binding
 * (`as __z0`), so reserved-word exports (`enum`, `function`, `null`, `void`,
 * `instanceof`) are legal in the import list, the export list and the object
 * literals alike.
 */
export function zodShimSource({ zodNames, coreNames }) {
  const z = zodNames.filter((n) => !['default', 'z', 'core', 'locales'].includes(n));
  const core = coreNames.filter((n) => !['default', 'locales'].includes(n));
  if (z.length === 0 || core.length === 0) {
    throw new Error(`ggui#2032 zod shim: zod/v4 enumerated ${z.length} names and zod/v4/core ${core.length} — refusing to emit an empty shim`);
  }
  const zIn = z.map((n, i) => `${n} as __z${i}`).join(', ');
  const zOut = z.map((n, i) => `__z${i} as ${n}`).join(', ');
  const zObj = z.map((n, i) => `${n}: __z${i}`).join(', ');
  const cIn = core.map((n, i) => `${n} as __c${i}`).join(', ');
  const cObj = core.map((n, i) => `${n}: __c${i}`).join(', ');
  const locales = `get locales() { throw new Error(${JSON.stringify(LOCALES_MESSAGE)}); }`;
  return [
    `import { ${zIn} } from 'zod/v4';`,
    `import { ${cIn} } from 'zod/v4/core';`,
    `export { ${zOut} };`,
    `export const core = { ${cObj}, ${locales} };`,
    `export const z = { ${zObj}, core, ${locales} };`,
    `export default z;`,
    '',
  ].join('\n');
}

const STATIC_IMPORT = /import\s*\{\s*z(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}\s*from\s*["']zod\/v4["']/g;
const STAR_IMPORT = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*["']zod\/v4["']/g;
const DYNAMIC_IMPORT = /(?:(?:let|const|var)\s*\{\s*z\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*)?await\s+import\s*\(\s*["']zod\/v4["']\s*\)/g;

/** The ways one source text reaches `zod/v4`, with the bindings it creates. */
export function zodImportSites(source) {
  const statics = [...source.matchAll(STATIC_IMPORT)].map((m) => ({ kind: 'alias', name: m[1] ?? 'z', index: m.index, end: m.index + m[0].length }));
  const stars = [...source.matchAll(STAR_IMPORT)].map((m) => ({ kind: 'namespace', name: m[1], index: m.index, end: m.index + m[0].length }));
  const dynamics = [...source.matchAll(DYNAMIC_IMPORT)].map((m) => ({ kind: 'dynamic', name: m[1] ?? null, index: m.index, end: m.index + m[0].length }));
  return [...statics, ...stars, ...dynamics].sort((a, b) => a.index - b.index);
}

/** Index just past the `}` that closes the block the position sits in, or the text's end. */
function blockEnd(source, from) {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return source.length;
}

function escapeRe(name) {
  return name.replace(/[$]/g, '\\$&');
}

/**
 * Every use of a zod binding that is NOT a member access, as
 * `{ name, snippet }` — empty when the shim's object literals are safe.
 * A static binding is checked over the whole text (a bundled dist's
 * top-level names are unique); a dynamic one over its own block. The
 * binding's own declaration is not a use.
 */
export function nonMemberZodUses(source) {
  const offences = [];
  for (const site of zodImportSites(source)) {
    if (site.name === null) continue;
    // A static binding is a top-level name of a bundled file, unique across
    // it; a dynamic one lives from its declaration to the end of its block.
    const scopeStart = site.kind === 'dynamic' ? site.end : 0;
    const scopeEnd = site.kind === 'dynamic' ? blockEnd(source, site.end) : source.length;
    const re = new RegExp(`(?<![\\w$])${escapeRe(site.name)}(?![\\w$])`, 'g');
    for (const m of source.slice(scopeStart, scopeEnd).matchAll(re)) {
      const at = scopeStart + m.index;
      if (at >= site.index && at < site.end) continue;
      const before = source.slice(Math.max(0, at - 3), at);
      // `obj.Q` is a property of something else; `...Q` is a spread of Q.
      if (before.endsWith('.') && !before.endsWith('...')) continue;
      // `${` opens a template substitution, not a use of a binding named `$`.
      if (site.name === '$' && source[at + 1] === '{') continue;
      const after = source.slice(at + site.name.length).match(/^\s*(\?\.|\.)(?!\.)/);
      if (after) continue;
      offences.push({ name: site.name, snippet: source.slice(Math.max(0, at - 30), at + site.name.length + 30) });
    }
  }
  return offences;
}

/**
 * Check the files the shim resolved for, and the fact that it resolved at
 * all. Throws with the reason; returns the site count when all three
 * conditions hold.
 */
export function assertShimConditions(importerFiles, readFile = (p) => readFileSync(p, 'utf8')) {
  if (importerFiles.length === 0) {
    throw new Error(
      'remove the ggui#2032 shim: no file under @modelcontextprotocol/ext-apps imports "zod/v4" any more, so the zod shim in esbuild.config.mjs adapts to nothing (oss/packages/scripts/ext-apps-zod-shim.mjs)',
    );
  }
  let sites = 0;
  for (const file of importerFiles) {
    const source = readFile(file);
    const found = zodImportSites(source);
    sites += found.length;
    const offences = nonMemberZodUses(source);
    if (offences.length > 0) {
      throw new Error(
        `ggui#2032 zod shim: ${file} uses a zod binding other than by member access, so the shim's object literal (no \`locales\`) is not a safe stand-in:\n  ${offences.map((o) => `${o.name}: …${o.snippet}…`).join('\n  ')}`,
      );
    }
  }
  if (sites === 0) {
    throw new Error('remove the ggui#2032 shim: the ext-apps files that import "zod/v4" no longer do so in any form this shim knows (static `{ z }`, `* as`, or dynamic import)');
  }
  return sites;
}

/**
 * The esbuild plugin. `enumerate` returns `{ zodNames, coreNames }` from the
 * installed zod (the build passes `Object.keys(await import('zod/v4'))` etc.,
 * resolved from the package root so it is the same instance the bundle gets).
 */
export function extAppsZodShimPlugin({ resolveDir, zodNames, coreNames }) {
  const importers = new Set();
  const contents = zodShimSource({ zodNames, coreNames });
  return {
    name: 'ggui-ext-apps-zod-shim',
    setup(build) {
      build.onResolve({ filter: ZOD_V4 }, (args) => {
        if (!EXT_APPS_IMPORTER.test(args.importer)) return undefined;
        importers.add(args.importer);
        return { path: SHIM_PATH, namespace: SHIM_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: SHIM_NAMESPACE }, () => ({ contents, loader: 'js', resolveDir }));
      build.onEnd(() => {
        assertShimConditions([...importers].sort());
      });
    },
  };
}
