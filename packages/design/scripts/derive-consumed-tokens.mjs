#!/usr/bin/env node
/**
 * Derive / verify the consumed-token manifest (ggui#598 slice 1).
 *
 * The manifest at `src/themes/consumed-tokens.manifest.json` is the
 * closed set of `--ggui-*` CSS custom properties that generated-UI
 * surfaces CONSUME. This script scans the consumer surfaces' source:
 *
 *   - design/src/**            (components, primitives, rendering, ...)
 *     EXCLUDING src/themes/**  (parser + theme definitions EMIT tokens,
 *     they do not consume them) and test/story files
 *   - iframe-runtime/src/**    (excluding tests)
 *   - ui-gen/src/design-system-docs.ts, ui-gen/src/boilerplate/**,
 *     ui-gen/src/fragments/**  (the LLM-taught vocabulary; excluding tests)
 *
 * Static consumption is matched with `var(--ggui-<name>`. Wildcard doc
 * mentions (`var(--ggui-color-*`) and metavariable doc mentions
 * (`var(--ggui-spacing-N)`, `var(--ggui-shape-radius-NAME, fallback)`)
 * are vocabulary patterns, not concrete tokens, and are skipped — real
 * token names never contain an ALL-CAPS segment. Dynamic construction (`var(--ggui-...${`) is
 * allowed at exactly ONE declared site — design/src/primitives/
 * color-slots.ts, whose range is the closed SEMANTIC_TONE_FALLBACK key
 * union in the same file; the union is extracted from that file so the
 * range can never drift from source. Any other dynamic construction is
 * a hard error: dynamic token construction must declare its range in
 * derive-consumed-tokens.mjs.
 *
 * Modes:
 *   node scripts/derive-consumed-tokens.mjs           # verify (exit 1 on drift)
 *   node scripts/derive-consumed-tokens.mjs --write   # regenerate the manifest
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const designRoot = path.resolve(here, '..');
const packagesRoot = path.resolve(designRoot, '..');

const MANIFEST_PATH = path.join(designRoot, 'src', 'themes', 'consumed-tokens.manifest.json');
const MANIFEST_VERSION = 1;

/** The single declared dynamic-consumption site (see header comment). */
const DYNAMIC_SITE = path.join(designRoot, 'src', 'primitives', 'color-slots.ts');
/** The exact dynamic construction the declared site is allowed to hold. */
const DYNAMIC_SITE_SHAPE = 'var(--ggui-color-${tone}-500';

/** File extensions the scan reads (everything else is skipped as non-source). */
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.tmpl']);

const TOKEN_NAME_RE = /^--ggui-[a-zA-Z0-9-]+$/;
const CONSUMPTION_RE = /var\(\s*(--ggui-[a-zA-Z0-9-]+)/g;

/** @type {Array<{ dir: string, excludeSubdirs?: string[] } | { file: string }>} */
const SCAN_SURFACES = [
  { dir: path.join(designRoot, 'src'), excludeSubdirs: ['themes'] },
  { dir: path.join(packagesRoot, 'iframe-runtime', 'src') },
  { file: path.join(packagesRoot, 'ui-gen', 'src', 'design-system-docs.ts') },
  { dir: path.join(packagesRoot, 'ui-gen', 'src', 'boilerplate') },
  { dir: path.join(packagesRoot, 'ui-gen', 'src', 'fragments') },
];

function isTestFile(filePath) {
  const base = path.basename(filePath);
  return (
    filePath.split(path.sep).includes('__tests__') ||
    /\.(test|test-d|spec|stories)\.[^.]+$/.test(base)
  );
}

/** Recursively collect scannable source files under `dir`. */
function collectFiles(dir, excludeSubdirs = []) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeSubdirs.includes(entry.name) || entry.name === '__tests__') continue;
      files.push(...collectFiles(full));
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name)) && !isTestFile(full)) {
      files.push(full);
    }
  }
  return files;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * Extract the SEMANTIC_TONE_FALLBACK key union from color-slots.ts —
 * the declared range of the single dynamic site. Loud failure if the
 * record is not found: never silently emit zero dynamic tokens.
 */
function extractDynamicRange(siteContent, sitePath) {
  const record = siteContent.match(/SEMANTIC_TONE_FALLBACK\s*:[^=]*=\s*\{([\s\S]*?)\}/);
  if (!record) {
    throw new Error(
      `${sitePath}: SEMANTIC_TONE_FALLBACK record not found — the declared dynamic site's ` +
        'range extraction in derive-consumed-tokens.mjs no longer matches the source. ' +
        'Update the extraction (or the declared-site registration) in the same change.',
    );
  }
  const keys = [...record[1].matchAll(/^\s*([a-zA-Z0-9]+)\s*:/gm)].map((m) => m[1]);
  if (keys.length === 0) {
    throw new Error(
      `${sitePath}: SEMANTIC_TONE_FALLBACK record matched but yielded zero keys — ` +
        'refusing to silently emit zero dynamic tokens. Fix the extraction in ' +
        'derive-consumed-tokens.mjs.',
    );
  }
  return keys.map((key) => `--ggui-color-${key}-500`);
}

/** Derive the full consumed-token set from the scan surfaces. */
export function deriveConsumedTokens() {
  const files = [];
  for (const surface of SCAN_SURFACES) {
    const target = 'file' in surface ? surface.file : surface.dir;
    if (!existsSync(target)) {
      throw new Error(
        `Scan surface missing: ${target} — refusing to derive from a shrunken surface set. ` +
          'If the surface moved, update SCAN_SURFACES in derive-consumed-tokens.mjs.',
      );
    }
    if ('file' in surface) files.push(surface.file);
    else files.push(...collectFiles(surface.dir, surface.excludeSubdirs));
  }

  const tokens = new Set();
  const errors = [];
  let dynamicSiteSeen = false;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(CONSUMPTION_RE)) {
      const name = match[1];
      const next = content[match.index + match[0].length];
      if (next === '$') {
        // Dynamic construction: `var(--ggui-...${`.
        const isDeclaredSite =
          path.resolve(file) === DYNAMIC_SITE &&
          content.startsWith(DYNAMIC_SITE_SHAPE, match.index);
        if (isDeclaredSite) {
          dynamicSiteSeen = true;
        } else {
          errors.push(
            `${file}:${lineOf(content, match.index)}: dynamic token construction ` +
              '(`var(--ggui-...${`) must declare its range in derive-consumed-tokens.mjs',
          );
        }
        continue;
      }
      if (name.endsWith('-')) {
        // Wildcard / doc-fragment mention (`var(--ggui-color-*`): a
        // vocabulary pattern, not a concrete consumed token.
        continue;
      }
      if (name.split('-').some((segment) => /^[A-Z]+$/.test(segment))) {
        // Metavariable doc mention (`var(--ggui-spacing-N)`,
        // `var(--ggui-shape-radius-NAME, ...)`): documentation teaches
        // the pattern with an ALL-CAPS placeholder segment; no real
        // token name has one (real segments are lowercase, camelCase
        // like `onSurface`, or digit-led like `2xl`).
        continue;
      }
      tokens.add(name);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Undeclared dynamic token construction:\n  ${errors.join('\n  ')}`);
  }

  if (dynamicSiteSeen) {
    const dynamicTokens = extractDynamicRange(readFileSync(DYNAMIC_SITE, 'utf8'), DYNAMIC_SITE);
    for (const token of dynamicTokens) tokens.add(token);
  }

  return [...tokens].sort();
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function main(argv) {
  const write = argv.includes('--write');
  const derived = deriveConsumedTokens();

  const invalid = derived.filter((token) => !TOKEN_NAME_RE.test(token));
  if (invalid.length > 0) {
    throw new Error(`Derived token names failed validation: ${invalid.join(', ')}`);
  }

  if (write) {
    const manifest = { version: MANIFEST_VERSION, tokens: derived };
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${MANIFEST_PATH} (${derived.length} tokens).`);
    return 0;
  }

  const manifest = readManifest();
  if (manifest === null) {
    console.error(
      `Manifest missing: ${MANIFEST_PATH}\n` +
        'Run with --write and commit the manifest in the same change.',
    );
    return 1;
  }
  if (manifest.version !== MANIFEST_VERSION) {
    console.error(
      `Manifest version ${JSON.stringify(manifest.version)} != ${MANIFEST_VERSION}. ` +
        'Run with --write and commit the manifest in the same change.',
    );
    return 1;
  }

  const manifestTokens = Array.isArray(manifest.tokens) ? manifest.tokens : [];
  const manifestSet = new Set(manifestTokens);
  const derivedSet = new Set(derived);
  const added = derived.filter((token) => !manifestSet.has(token));
  const removed = manifestTokens.filter((token) => !derivedSet.has(token));
  const misordered =
    added.length === 0 &&
    removed.length === 0 &&
    JSON.stringify(manifestTokens) !== JSON.stringify(derived);

  if (added.length > 0 || removed.length > 0 || misordered) {
    console.error('Consumed-token manifest is out of sync with source.');
    if (added.length > 0) console.error(`  Added (consumed in source, missing from manifest):\n    ${added.join('\n    ')}`);
    if (removed.length > 0) console.error(`  Removed (in manifest, no longer consumed):\n    ${removed.join('\n    ')}`);
    if (misordered) console.error('  Manifest token order/duplication differs from the canonical sorted-unique form.');
    console.error('Run with --write and commit the manifest in the same change.');
    return 1;
  }

  console.log(`OK: ${derived.length} consumed tokens; manifest in sync.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
