/**
 * Per-PR gate for the consumed-token manifest (ggui#598 slice 1).
 *
 * The manifest (`consumed-tokens.manifest.json`) is the closed set of
 * `--ggui-*` CSS custom properties that generated-UI surfaces consume.
 * `scripts/derive-consumed-tokens.mjs` derives that set from the
 * consumer surfaces' source; this test runs it in verify mode so any
 * PR that adds/removes a consumed token without regenerating the
 * manifest (`node scripts/derive-consumed-tokens.mjs --write`) fails.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..');
const scriptPath = path.join(packageRoot, 'scripts', 'derive-consumed-tokens.mjs');
const manifestPath = path.join(here, 'consumed-tokens.manifest.json');

interface ConsumedTokensManifest {
  version: number;
  tokens: string[];
}

describe('consumed-tokens manifest', () => {
  it('verify mode passes: derived consumption set == checked-in manifest', () => {
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    expect(
      result.status,
      `derive-consumed-tokens.mjs verify failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
  });

  it('manifest pins: version === 1, tokens sorted, unique, valid --ggui-* names', () => {
    const manifest: ConsumedTokensManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.version).toBe(1);
    expect(Array.isArray(manifest.tokens)).toBe(true);
    expect(manifest.tokens.length).toBeGreaterThan(0);
    for (const token of manifest.tokens) {
      expect(token).toMatch(/^--ggui-[a-zA-Z0-9-]+$/);
    }
    const sorted = [...manifest.tokens].sort();
    expect(manifest.tokens).toEqual(sorted);
    expect(new Set(manifest.tokens).size).toBe(manifest.tokens.length);
  });
});
