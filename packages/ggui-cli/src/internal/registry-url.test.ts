/**
 * Shared registry-URL resolver tests. Consolidates the per-verb suites
 * that previously lived in `artifact-publish.test.ts` (write posture)
 * and `artifact-search.test.ts` (pre-unification resolver) — one chain,
 * one suite. Per-verb integration coverage (which posture each verb
 * passes) stays with the verb tests:
 *   - install/search default to {@link DEFAULT_REGISTRY_URL} (READ)
 *   - publish / keys register error without explicit config (WRITE)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY_URL, resolveRegistryUrl } from './registry-url.js';

describe('resolveRegistryUrl', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ggui-registry-url-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function seedGguiJson(registry?: string): void {
    writeFileSync(
      join(workDir, 'ggui.json'),
      JSON.stringify({ schema: '1', ...(registry !== undefined ? { registry } : {}) }),
    );
  }

  it('layer 1: flag beats env + ggui.json', () => {
    seedGguiJson('https://from-json.example');
    const r = resolveRegistryUrl({
      flag: 'https://from-flag.example',
      cwd: workDir,
      env: { GGUI_REGISTRY: 'https://from-env.example' },
    });
    expect(r).toEqual({
      ok: true,
      url: 'https://from-flag.example',
      source: 'flag',
    });
  });

  it('layer 2: GGUI_REGISTRY env beats ggui.json (npm model — env over project config)', () => {
    seedGguiJson('https://from-json.example');
    const r = resolveRegistryUrl({
      cwd: workDir,
      env: { GGUI_REGISTRY: 'https://from-env.example' },
    });
    expect(r).toEqual({
      ok: true,
      url: 'https://from-env.example',
      source: 'env',
    });
  });

  it('layer 3: ggui.json#registry when flag + env absent', () => {
    seedGguiJson('https://from-json.example/');
    const r = resolveRegistryUrl({ cwd: workDir, env: {} });
    expect(r).toEqual({
      ok: true,
      url: 'https://from-json.example',
      source: 'ggui.json',
    });
  });

  it('walks UP from cwd to find ggui.json', () => {
    const sub = join(workDir, 'sub', 'nested');
    mkdirSync(sub, { recursive: true });
    seedGguiJson('https://parent.example');
    const r = resolveRegistryUrl({ cwd: sub, env: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://parent.example');
      expect(r.source).toBe('ggui.json');
    }
  });

  it('walks DEEP (>8 levels) — the shared budget covers 16-level monorepos', () => {
    // The retired publish resolver walked 16 levels while search/install
    // walked 8; the unified constant must not regress the deeper walk.
    const segments = Array.from({ length: 12 }, (_, i) => `d${i}`);
    const deep = join(workDir, ...segments);
    mkdirSync(deep, { recursive: true });
    seedGguiJson('https://deep-root.example');
    const r = resolveRegistryUrl({ cwd: deep, env: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://deep-root.example');
      expect(r.source).toBe('ggui.json');
    }
  });

  it('continues past a field-less ggui.json to an ancestor that carries the field', () => {
    // A nested project manifest without `registry` must not shadow the
    // monorepo root that pins it — otherwise READ verbs silently fall
    // through to the public default past the operator's config.
    const sub = join(workDir, 'apps', 'web');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'ggui.json'),
      JSON.stringify({ schema: '1', app: { slug: 'web', name: 'Web' } }),
    );
    seedGguiJson('https://monorepo-root.example');
    const r = resolveRegistryUrl({
      cwd: sub,
      env: {},
      defaultUrl: DEFAULT_REGISTRY_URL,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://monorepo-root.example');
      expect(r.source).toBe('ggui.json');
    }
  });

  it('layer 4 (READ verbs): falls back to defaultUrl when nothing is configured', () => {
    seedGguiJson(undefined); // ggui.json present but no registry field
    const r = resolveRegistryUrl({
      cwd: workDir,
      env: {},
      defaultUrl: DEFAULT_REGISTRY_URL,
    });
    expect(r).toEqual({
      ok: true,
      url: DEFAULT_REGISTRY_URL,
      source: 'default',
    });
  });

  it('layer 4 (WRITE verbs): no-registry error when nothing is configured and no default', () => {
    seedGguiJson(undefined);
    const r = resolveRegistryUrl({ cwd: workDir, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('no-registry');
      expect(r.message).toContain('no registry resolved');
      expect(r.message).toContain('--registry');
      expect(r.message).toContain('GGUI_REGISTRY');
      expect(r.message).toContain('ggui.json');
    }
  });

  it('explicit config beats the default even when defaultUrl is supplied', () => {
    seedGguiJson('https://from-json.example');
    const r = resolveRegistryUrl({
      cwd: workDir,
      env: {},
      defaultUrl: DEFAULT_REGISTRY_URL,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://from-json.example');
      expect(r.source).toBe('ggui.json');
    }
  });

  it('normalizes trailing slashes on every layer', () => {
    const r = resolveRegistryUrl({
      flag: 'https://r.example.com/',
      cwd: workDir,
      env: {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://r.example.com');
  });

  it('rejects a malformed flag URL with invalid-registry', () => {
    const r = resolveRegistryUrl({ flag: 'not-a-url', cwd: workDir, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('invalid-registry');
      expect(r.message).toContain('--registry');
    }
  });

  it('rejects a malformed GGUI_REGISTRY with invalid-registry', () => {
    const r = resolveRegistryUrl({
      cwd: workDir,
      env: { GGUI_REGISTRY: 'not-a-url' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('invalid-registry');
      expect(r.message).toContain('GGUI_REGISTRY');
    }
  });

  it('rejects a non-http(s) scheme', () => {
    const r = resolveRegistryUrl({
      flag: 'ftp://r.example.com',
      cwd: workDir,
      env: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-registry');
  });

  it('skips a non-string ggui.json#registry field (tolerant) and falls through', () => {
    writeFileSync(
      join(workDir, 'ggui.json'),
      JSON.stringify({ schema: '1', registry: 42 }),
    );
    const r = resolveRegistryUrl({
      cwd: workDir,
      env: {},
      defaultUrl: DEFAULT_REGISTRY_URL,
    });
    expect(r).toEqual({
      ok: true,
      url: DEFAULT_REGISTRY_URL,
      source: 'default',
    });
  });

  it('skips an empty-string ggui.json#registry field (tolerant) and falls through', () => {
    seedGguiJson('');
    const readVerb = resolveRegistryUrl({
      cwd: workDir,
      env: {},
      defaultUrl: DEFAULT_REGISTRY_URL,
    });
    expect(readVerb).toEqual({
      ok: true,
      url: DEFAULT_REGISTRY_URL,
      source: 'default',
    });
    // WRITE verbs fall through to the no-registry error, not a
    // validateUrl('') hard failure.
    const writeVerb = resolveRegistryUrl({ cwd: workDir, env: {} });
    expect(writeVerb.ok).toBe(false);
    if (!writeVerb.ok) expect(writeVerb.code).toBe('no-registry');
  });

  it('a skipped (empty/non-string) field defers to an ancestor that carries one', () => {
    const sub = join(workDir, 'pkg');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'ggui.json'),
      JSON.stringify({ schema: '1', registry: '' }),
    );
    seedGguiJson('https://monorepo-root.example');
    const r = resolveRegistryUrl({ cwd: sub, env: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://monorepo-root.example');
      expect(r.source).toBe('ggui.json');
    }
  });

  it('errors (not silent-default) on unparseable ggui.json — a broken config must not reroute reads', () => {
    writeFileSync(join(workDir, 'ggui.json'), '{ not json');
    const r = resolveRegistryUrl({
      cwd: workDir,
      env: {},
      defaultUrl: DEFAULT_REGISTRY_URL,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid-registry');
  });
});
