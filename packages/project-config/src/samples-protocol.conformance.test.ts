/**
 * Drift guards for the `protocol` declaration of every checked-in
 * `ggui.json` — the shipped samples under `samples/gguis/` AND the e2e
 * fixtures under `e2e/` — since every one of them is loaded through
 * `loadGguiJson` somewhere (a self-hoster's first boot, `ggui serve`
 * journeys, the samples-render harness) and a declaration the loader
 * refuses would fail those boots.
 *
 * Two claims, deliberately named apart (#810):
 *
 *   1. **Conformance** — every file declares a SUPPORTED protocol: a
 *      member of `CLIENT_SUPPORTED_VERSIONS`, the wire's own predicate
 *      and the one the loader enforces (`UPGRADE_REQUIRED` otherwise).
 *   2. **House rule** — every file declares the CURRENT stamp,
 *      `PROTOCOL_VERSION`. Stricter than the contract: a still-supported
 *      but stale declaration would pass (1) and fail (2). Shipped files
 *      are what a new project starts from, so they ship current — this
 *      is the pin that goes red when a stamp move forgets them.
 *
 * The schema validates `protocol` as pattern-only by design (see
 * {@link GguiJsonV1}) — a well-formed old declaration must stay
 * READABLE so the reader can say "upgrade"; membership is the loader's
 * check, and currency is this file's.
 *
 * Paths are resolved relative to this package so the test works both in
 * the monorepo (`oss/packages/project-config` → `oss/`) and in the
 * public `ggui-ai/ggui` mirror (`packages/project-config` → repo root).
 * A missing samples dir FAILS — silently skipping would turn this gate
 * off.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_SUPPORTED_VERSIONS, PROTOCOL_VERSION } from '@ggui-ai/protocol';
import { GGUI_JSON_FILENAME, safeParseGguiJson } from './schema.js';

const OSS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GGUIS_DIR = join(OSS_ROOT, 'samples/gguis');

/** Directories that hold no checked-in project files. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.git']);

/** Every `ggui.json` under `root`, as paths relative to it (stable test names). */
function collectGguiJsonFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === GGUI_JSON_FILENAME) found.push(relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

const gguiJsonFiles = collectGguiJsonFiles(OSS_ROOT);

function declaredProtocol(relPath: string): string {
  const raw: unknown = JSON.parse(readFileSync(join(OSS_ROOT, relPath), 'utf8'));
  const parsed = safeParseGguiJson(raw);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return parsed.success ? parsed.data.protocol : '';
}

describe('checked-in ggui.json files — repo layout', () => {
  it('finds the samples directory (repo-layout invariant)', () => {
    expect(existsSync(GGUIS_DIR)).toBe(true);
  });

  it('finds at least one shipped sample among the checked-in ggui.json files', () => {
    expect(gguiJsonFiles.some((p) => p.startsWith('samples/gguis/'))).toBe(true);
  });
});

describe('conformance: every checked-in ggui.json declares a SUPPORTED protocol (∈ CLIENT_SUPPORTED_VERSIONS)', () => {
  it.each(gguiJsonFiles)('%s parses and its protocol is in the supported set', (relPath) => {
    expect(CLIENT_SUPPORTED_VERSIONS).toContain(declaredProtocol(relPath));
  });
});

describe('house rule: every checked-in ggui.json declares the CURRENT protocol (=== PROTOCOL_VERSION)', () => {
  it.each(gguiJsonFiles)('%s is on the current stamp', (relPath) => {
    expect(declaredProtocol(relPath)).toBe(PROTOCOL_VERSION);
  });
});
