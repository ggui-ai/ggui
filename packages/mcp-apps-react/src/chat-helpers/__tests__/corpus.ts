/**
 * Test-only corpus loader (#426 Spec A). Reads Task 1's fetched cache.
 * TWIN NOTE: this is a deliberate copy of agent-server's loader
 * (oss/packages/agent-server/src/testing/corpus.ts) — no cross-package
 * test coupling, no published surface. Keep the two in sync by hand;
 * they are ~40 lines.
 *
 * Boundary law (spec §6): this file and *.contract.test.ts are the ONLY
 * places in this package allowed to import @silverprotocol/* — and even
 * here, only to validate STIMULUS. Assertions live in ggui's terms.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/chat-helpers/__tests__/ → chat-helpers/ → src/ → ggui-react/ →
// packages/ → oss/
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'e2e',
  'fixtures',
  'silverprotocol',
);
const CACHE = join(FIXTURES, '.cache');

/**
 * Fail NAMING THE FIX when the cache does not match fixtures.lock.json: stale
 * from an earlier pin, or corrupt. A stale cache used to surface as a bare
 * assertion diff on whichever golden had moved (the 0.7.0 corpus re-pin,
 * #1298). The check is fetch-fixtures' own `--verify-only`, so the checksum
 * has ONE implementation; `verify` is injectable for the loader's tests.
 */
export function assertCacheMatchesLock(
  verify: () => void = () => {
    execFileSync(process.execPath, [join(FIXTURES, 'fetch-fixtures.mjs'), '--verify-only'], {
      stdio: 'pipe',
    });
  },
): void {
  try {
    verify();
  } catch (err) {
    const detail = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
    throw new Error(
      'silverprotocol fixture cache does not match fixtures.lock.json (stale from an earlier pin, or ' +
        'corrupt): run `node oss/e2e/fixtures/silverprotocol/fetch-fixtures.mjs` from the repo root. ' +
        `(${detail})`,
    );
  }
}

let cacheMatchesLock = false;

/**
 * Read one cached leg file, or fail NAMING THE FIX. The cache is gitignored
 * and fetched, so a fresh worktree has none; a bare ENOENT reads like a
 * pre-existing red and gets waved through (#1298).
 */
function readCached(scenario: string, framework: string, kind: string): unknown {
  const file = `${scenario}/${framework}.${kind}.json`;
  const path = join(CACHE, file);
  if (!existsSync(path)) {
    throw new Error(
      `silverprotocol fixture cache is missing ${file} (under ${CACHE}). The cache is gitignored ` +
        'and pinned by fixtures.lock.json: run `node oss/e2e/fixtures/silverprotocol/fetch-fixtures.mjs` ' +
        'from the repo root (with a valid cache it is a no-network no-op).',
    );
  }
  if (!cacheMatchesLock) {
    assertCacheMatchesLock();
    cacheMatchesLock = true;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadLeg(scenario: string, framework: string) {
  const read = (kind: string): unknown => readCached(scenario, framework, kind);
  return {
    native: read('native') as unknown[],
    agjson: read('agjson') as unknown[],
    provenance: read('provenance') as Record<string, unknown>,
  };
}

/**
 * Read a Layer-B leg from the fetched cache. Layer-B transcripts
 * (workspace#10 — e.g. `guest-gesture`, ggui-authored, enrolled
 * upstream via silverprotocol/workspace#12) are covered by the lock
 * like any corpus member, but have no `.agjson.json` golden by
 * construction: authored host-plane wire has no upstream normalized
 * fold. The stable/incidental set lives in the upstream corpus entry
 * (FIXTURES.md §Layer B + the transcript-contract gate).
 */
export function loadLayerBLeg(scenario: string, framework: string) {
  const read = (kind: string): unknown => readCached(scenario, framework, kind);
  return {
    native: read('native') as unknown[],
    provenance: read('provenance') as Record<string, unknown>,
  };
}

/**
 * Stable-set INPUT derived from the golden (never an assertion target
 * on ggui's output): how many tool completions in this scenario carry
 * the `_meta.ui` bootstrap. Event-type + structural reads only —
 * FIXTURES.md's stable set.
 *
 * Grounded shape note: in the pinned corpus (cohort 0.4.1) the fold
 * carries `_meta` directly ON the `tool.done` event — not under a
 * `result` property — so this reads `ev._meta.ui`.
 */
export function goldenUiToolDones(agjson: unknown[]): number {
  return agjson.filter((e) => {
    const ev = e as { type?: string; _meta?: { ui?: unknown } };
    return ev.type === 'tool.done' && ev._meta?.ui !== undefined;
  }).length;
}
