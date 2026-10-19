// ggui#1769 — with the bundle split, shared code runs from a chunk at `dist/` itself, not from `dist/<dir>/`.
// Every path a module computes from its own location must hold from both depths.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findPackageRootAbove, resolveUiGenPackageDir } from './visual-evaluator.js';

const root = mkdtempSync(join(tmpdir(), 'ui-gen-root-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const pkg = join(root, 'node_modules', '@ggui-ai', 'ui-gen');
mkdirSync(join(pkg, 'dist', 'evaluation'), { recursive: true });
writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@ggui-ai/ui-gen' }));
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'host-app' }));

describe('the ui-gen package root is found by its manifest, at any depth (ggui#1769)', () => {
  it('from a shared chunk at dist/', () => {
    expect(findPackageRootAbove(join(pkg, 'dist'), '@ggui-ai/ui-gen')).toBe(pkg);
  });
  it('from a per-entry dir dist/evaluation/', () => {
    expect(findPackageRootAbove(join(pkg, 'dist', 'evaluation'), '@ggui-ai/ui-gen')).toBe(pkg);
  });
  it('never stops at a host package.json with another name, and fails loudly with no match', () => {
    expect(() => findPackageRootAbove(root, '@ggui-ai/ui-gen')).toThrow(/no package.json named @ggui-ai\/ui-gen/);
  });
  it('from this source tree', () => {
    expect(JSON.parse(readFileSync(join(resolveUiGenPackageDir(), 'package.json'), 'utf8')).name).toBe('@ggui-ai/ui-gen');
  });
});

describe('the render smoke worker resolves from a dist-root chunk (ggui#1769)', () => {
  it('lists the ./tools/ candidate a dist-root chunk needs', () => {
    const src = readFileSync(new URL('../tools/render-check.ts', import.meta.url), 'utf8');
    expect(src).toContain("new URL('./tools/render-check-worker.js', import.meta.url)");
  });
  it('the in-loop worker host lists the ./harness/ candidate a dist-root chunk needs', () => {
    const src = readFileSync(new URL('../harness/check/runtime-render/render-check-host.ts', import.meta.url), 'utf8');
    expect(src).toContain('new URL(`./harness/check/runtime-render/${WORKER_BASENAME}.js`, import.meta.url)');
  });
});
