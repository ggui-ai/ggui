// ggui#1280 — the generator's build identity. The pin tie-in (the runtime
// digests equal the design-mode pin's recorded constants under the default
// env) lives in `design-mode.pin.test.ts`, beside the constants. Pinned here:
// the version is the package's own; a design mode and an env gate each select
// their own digests; and a repeat call answers from the memo.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findPackageVersion, generatorBuild } from './generator-build.js';

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

describe('generatorBuild (ggui#1280)', () => {
  const saved = process.env.GGUI_PITFALLS;
  afterEach(() => {
    if (saved === undefined) delete process.env.GGUI_PITFALLS;
    else process.env.GGUI_PITFALLS = saved;
  });

  it('carries the package’s own version, read from its package.json', () => {
    const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    const version = typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined;
    expect(typeof version).toBe('string');
    expect(generatorBuild('constrained').version).toBe(version);
  });

  it('the two design modes have their own template digests', () => {
    const constrained = generatorBuild('constrained');
    const free = generatorBuild('free');
    expect(constrained.mode).toBe('constrained');
    expect(free.mode).toBe('free');
    expect(free.digests.promptTemplateSha256).not.toBe(constrained.digests.promptTemplateSha256);
    expect(free.digests.boilerplateTemplateSha256).not.toBe(constrained.digests.boilerplateTemplateSha256);
    expect(constrained.digests.promptTemplateSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the pitfalls env gate selects its own prompt digest — never answered from a stale memo', () => {
    delete process.env.GGUI_PITFALLS;
    const on = generatorBuild('constrained');
    process.env.GGUI_PITFALLS = 'off';
    const off = generatorBuild('constrained');
    expect(off.digests.promptTemplateSha256).not.toBe(on.digests.promptTemplateSha256);
    expect(off.digests.boilerplateTemplateSha256, 'the boilerplate does not read the gate').toBe(on.digests.boilerplateTemplateSha256);
    delete process.env.GGUI_PITFALLS;
    expect(generatorBuild('constrained')).toBe(on);
  });

  it('a repeat call answers from the memo (computed once per process per mode and gate)', () => {
    expect(generatorBuild('free')).toBe(generatorBuild('free'));
  });
});

// ggui#1280 review (oss): the version walk runs on the generation path, and in a
// consumer's bundle it can climb through package.json files that are not ours.
// A malformed one must not fail a generation: it is skipped, and the version is
// absent, never guessed.
describe('findPackageVersion — a malformed package.json on the walk', () => {
  let root = '';
  afterEach(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('skips a candidate that does not parse and keeps climbing to ours', () => {
    root = mkdtempSync(join(tmpdir(), 'ggui-pkg-walk-'));
    const pkgRoot = join(root, 'ui-gen');
    const nested = join(pkgRoot, 'consumer', 'dist');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@ggui-ai/ui-gen', version: '9.9.9' }));
    writeFileSync(join(pkgRoot, 'consumer', 'package.json'), '{ this is not json');
    expect(findPackageVersion(nested)).toBe('9.9.9');
  });

  it('with nothing parseable of ours on the walk, the version is absent — no throw', () => {
    root = mkdtempSync(join(tmpdir(), 'ggui-pkg-walk-'));
    const start = join(root, 'a', 'b');
    mkdirSync(start, { recursive: true });
    writeFileSync(join(root, 'a', 'package.json'), '{ nope');
    expect(findPackageVersion(start)).toBeUndefined();
  });
});
