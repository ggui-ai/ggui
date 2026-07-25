/**
 * Drift guard: every shipped `ggui.json` sample MUST declare the CURRENT
 * protocol version.
 *
 * The schema deliberately validates `protocol` as pattern-only (see
 * {@link GguiJsonV1}), so a stale declaration parses silently — this test is
 * the membership check the schema defers. README contract: "`protocol` MUST
 * match `PROTOCOL_VERSION` exported by `@ggui-ai/protocol`". The samples are
 * also what the samples-render e2e harness composes into a runnable app
 * (and the public starting point for self-hosters), so drift here ships.
 *
 * Paths are resolved relative to this package so the test works both in the
 * monorepo (`oss/packages/project-config` → `oss/samples`) and in the public
 * `ggui-ai/ggui` mirror (`packages/project-config` → `samples`). A missing
 * samples dir FAILS — silently skipping would turn this gate off.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@ggui-ai/protocol';
import { safeParseGguiJson } from './schema.js';

const OSS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GGUIS_DIR = join(OSS_ROOT, 'samples/gguis');

describe('shipped ggui.json samples declare the current protocol', () => {
  it('finds the samples directory (repo-layout invariant)', () => {
    expect(existsSync(GGUIS_DIR)).toBe(true);
  });

  const sampleDirs = existsSync(GGUIS_DIR)
    ? readdirSync(GGUIS_DIR).filter((d) =>
        existsSync(join(GGUIS_DIR, d, 'ggui.json')),
      )
    : [];

  it('has at least one ggui.json sample to check', () => {
    expect(sampleDirs.length).toBeGreaterThan(0);
  });

  it.each(sampleDirs)(
    'samples/gguis/%s/ggui.json parses and pins PROTOCOL_VERSION',
    (dir) => {
      const raw: unknown = JSON.parse(
        readFileSync(join(GGUIS_DIR, dir, 'ggui.json'), 'utf8'),
      );
      const parsed = safeParseGguiJson(raw);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      if (parsed.success) {
        expect(parsed.data.protocol).toBe(PROTOCOL_VERSION);
      }
    },
  );
});
