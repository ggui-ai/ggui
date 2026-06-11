/**
 * Drift guard: every shipped `ggui.json` sample (and the template shells'
 * `ggui-json.md` reference doc) MUST declare the CURRENT protocol version.
 *
 * The schema deliberately validates `protocol` as pattern-only (see
 * {@link GguiJsonV1}), so a stale declaration parses silently — this test is
 * the membership check the schema defers. README contract: "`protocol` MUST
 * match `PROTOCOL_VERSION` exported by `@ggui-ai/protocol`". The samples are
 * also the source the template assembler copies into every published
 * agentic-app template, so drift here ships to every scaffolded project.
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
const SHELLS_DIR = join(OSS_ROOT, 'template-shells/agentic-app-template');

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

describe('template-shell ggui-json.md reference docs declare the current protocol', () => {
  // The shells exist in the monorepo and the public mirror; if the layout
  // ever changes, fail loud rather than silently skipping the doc check.
  it('finds the template-shells directory (repo-layout invariant)', () => {
    expect(existsSync(SHELLS_DIR)).toBe(true);
  });

  const shells = existsSync(SHELLS_DIR)
    ? readdirSync(SHELLS_DIR).filter((d) =>
        existsSync(join(SHELLS_DIR, d, '.reference/ggui-json.md')),
      )
    : [];

  it('has at least one shell reference doc to check', () => {
    expect(shells.length).toBeGreaterThan(0);
  });

  it.each(shells)(
    '%s/.reference/ggui-json.md quotes the current protocol draft',
    (shell) => {
      const doc = readFileSync(
        join(SHELLS_DIR, shell, '.reference/ggui-json.md'),
        'utf8',
      );
      const quoted = /"protocol":\s*"([^"]+)"/.exec(doc);
      expect(quoted, 'doc must quote a "protocol" field').not.toBeNull();
      expect(quoted?.[1]).toBe(PROTOCOL_VERSION);
    },
  );
});
