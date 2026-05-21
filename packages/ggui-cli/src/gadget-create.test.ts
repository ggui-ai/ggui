/**
 * `ggui gadget create` unit tests. Exercises the scaffolder against
 * real `tmpdir()` paths — never the operator's CWD. Each test runs in
 * its own randomized prefix so parallel cases never collide.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGadgetManifest } from '@ggui-ai/artifact-manifest';
import {
  buildScaffoldManifest,
  deriveHookName,
  parseGadgetCreateFlags,
  parseScopeName,
  runGadgetCreate,
} from './gadget-create.js';

describe('parseScopeName', () => {
  it('parses a canonical @scope/name identifier', () => {
    expect(parseScopeName('@my-org/weather-card')).toEqual({
      scope: '@my-org',
      name: 'weather-card',
    });
  });

  it('rejects missing leading @', () => {
    expect(parseScopeName('my-org/weather-card')).toBeNull();
  });

  it('rejects missing slash', () => {
    expect(parseScopeName('@my-org')).toBeNull();
  });

  it('rejects empty name', () => {
    expect(parseScopeName('@my-org/')).toBeNull();
  });

  it('rejects single-char scope (just @)', () => {
    expect(parseScopeName('@/x')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(parseScopeName('')).toBeNull();
  });
});

describe('deriveHookName', () => {
  it('converts kebab-case to use<PascalCase>', () => {
    expect(deriveHookName('weather-card')).toBe('useWeatherCard');
  });

  it('handles single-word names', () => {
    expect(deriveHookName('leaflet')).toBe('useLeaflet');
  });

  it('handles numeric suffixes', () => {
    expect(deriveHookName('mapbox-v2')).toBe('useMapboxV2');
  });

  it('collapses empty segments from double hyphens', () => {
    expect(deriveHookName('foo--bar')).toBe('useFooBar');
  });
});

describe('parseGadgetCreateFlags', () => {
  it('returns __help__ when called with no args', () => {
    expect(parseGadgetCreateFlags([]).error).toBe('__help__');
  });

  it('returns __help__ on --help', () => {
    expect(parseGadgetCreateFlags(['--help']).error).toBe('__help__');
    expect(parseGadgetCreateFlags(['-h']).error).toBe('__help__');
  });

  it('parses a bare positional', () => {
    const r = parseGadgetCreateFlags(['@my-org/weather-card']);
    expect(r.error).toBeUndefined();
    expect(r.flags?.scopeName).toBe('@my-org/weather-card');
  });

  it('parses --dir / --hook / --description / --visibility', () => {
    const r = parseGadgetCreateFlags([
      '@my-org/weather-card',
      '--dir',
      'custom',
      '--hook',
      'useWeather',
      '--description',
      'Weather card gadget',
      '--visibility',
      'private',
    ]);
    expect(r.error).toBeUndefined();
    expect(r.flags).toEqual({
      scopeName: '@my-org/weather-card',
      dir: 'custom',
      hook: 'useWeather',
      description: 'Weather card gadget',
      visibility: 'private',
    });
  });

  it('rejects --visibility values other than public/private', () => {
    const r = parseGadgetCreateFlags([
      '@my-org/x',
      '--visibility',
      'internal',
    ]);
    expect(r.error).toMatch(/visibility/);
  });

  it('rejects unknown flags', () => {
    const r = parseGadgetCreateFlags(['@my-org/x', '--frobnicate']);
    expect(r.error).toMatch(/unknown flag/);
  });

  it('rejects flags missing their value', () => {
    expect(parseGadgetCreateFlags(['@my-org/x', '--dir']).error).toMatch(
      /requires a value/,
    );
  });

  it('rejects missing positional', () => {
    const r = parseGadgetCreateFlags(['--dir', 'foo']);
    expect(r.error).toMatch(/missing required/);
  });

  it('rejects a second positional', () => {
    const r = parseGadgetCreateFlags(['@my-org/x', 'extra']);
    expect(r.error).toMatch(/unexpected positional/);
  });
});

describe('buildScaffoldManifest', () => {
  it('produces a manifest that parses against the schema', () => {
    const manifest = buildScaffoldManifest({
      scope: '@my-org',
      name: 'weather-card',
      hook: 'useWeatherCard',
      visibility: 'public',
      description: 'Hello',
    });
    expect(manifest.kind).toBe('gadget');
    expect(manifest.scope).toBe('@my-org');
    expect(manifest.name).toBe('weather-card');
    expect(manifest.bundle).toBe('src/index.ts');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    // Round-trip through the schema — the scaffolder's own validation
    // step. This is the "template regression" canary.
    expect(() => parseGadgetManifest(manifest)).not.toThrow();
  });
});

describe('runGadgetCreate', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = join(tmpdir(), `ggui-gadget-create-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('scaffolds expected files at CWD/<name> by default', async () => {
    const result = await runGadgetCreate(
      { scopeName: '@my-org/weather-card' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return; // type guard

    expect(result.targetDir).toBe(join(workDir, 'weather-card'));
    expect(result.hook).toBe('useWeatherCard');
    expect(result.files).toEqual(
      expect.arrayContaining([
        'ggui.gadget.json',
        'package.json',
        'tsconfig.json',
        'src/index.ts',
        'README.md',
      ]),
    );

    // Manifest on disk parses round-trip through the schema.
    const manifestRaw = await readFile(
      join(result.targetDir, 'ggui.gadget.json'),
      'utf-8',
    );
    const manifest = parseGadgetManifest(JSON.parse(manifestRaw));
    expect(manifest.scope).toBe('@my-org');
    expect(manifest.name).toBe('weather-card');
    const firstExport = manifest.exports[0];
    expect(firstExport).toBeDefined();
    if (firstExport && 'hook' in firstExport) {
      expect(firstExport.hook).toBe('useWeatherCard');
    } else {
      throw new Error('expected a hook export');
    }
    expect(manifest.visibility).toBe('public');
    expect(manifest.bundle).toBe('src/index.ts');

    // package.json shape — name matches scope/name.
    const pkgRaw = await readFile(
      join(result.targetDir, 'package.json'),
      'utf-8',
    );
    const pkg = JSON.parse(pkgRaw) as {
      name: string;
      type: string;
      peerDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('@my-org/weather-card');
    expect(pkg.type).toBe('module');
    expect(pkg.peerDependencies['@ggui-ai/gadgets']).toBeDefined();
    expect(pkg.peerDependencies['react']).toBeDefined();

    // tsconfig strict + bundler resolution.
    const tsconfigRaw = await readFile(
      join(result.targetDir, 'tsconfig.json'),
      'utf-8',
    );
    const tsconfig = JSON.parse(tsconfigRaw) as {
      compilerOptions: { strict: boolean; moduleResolution: string };
    };
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.moduleResolution).toBe('bundler');

    // src/index.ts mentions the hook name.
    const src = await readFile(
      join(result.targetDir, 'src', 'index.ts'),
      'utf-8',
    );
    expect(src).toContain('useWeatherCard');
    expect(src).toContain('GadgetHook');

    // README references the identifier.
    const readme = await readFile(
      join(result.targetDir, 'README.md'),
      'utf-8',
    );
    expect(readme).toContain('@my-org/weather-card');
  });

  it('respects --dir override', async () => {
    const result = await runGadgetCreate(
      { scopeName: '@my-org/weather-card', dir: 'custom-name' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetDir).toBe(join(workDir, 'custom-name'));
  });

  it('respects --hook override + threads it through manifest + src', async () => {
    const result = await runGadgetCreate(
      {
        scopeName: '@my-org/weather-card',
        hook: 'useWeather',
      },
      { cwd: workDir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.hook).toBe('useWeather');
    const weatherExport = result.manifest.exports[0];
    expect(weatherExport).toBeDefined();
    if (weatherExport && 'hook' in weatherExport) {
      expect(weatherExport.hook).toBe('useWeather');
    } else {
      throw new Error('expected a hook export');
    }

    const src = await readFile(
      join(result.targetDir, 'src', 'index.ts'),
      'utf-8',
    );
    expect(src).toContain('useWeather');
  });

  it('threads --description into manifest + README', async () => {
    const description = 'Beautiful weather card gadget.';
    const result = await runGadgetCreate(
      { scopeName: '@my-org/weather-card', description },
      { cwd: workDir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.description).toBe(description);
    const readme = await readFile(
      join(result.targetDir, 'README.md'),
      'utf-8',
    );
    expect(readme).toContain(description);
  });

  it('refuses a non-empty target directory', async () => {
    const target = join(workDir, 'weather-card');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'leftover.txt'), 'existing file');

    const result = await runGadgetCreate(
      { scopeName: '@my-org/weather-card' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('target-not-empty');
  });

  it('allows an empty existing target directory', async () => {
    const target = join(workDir, 'weather-card');
    await mkdir(target, { recursive: true });

    const result = await runGadgetCreate(
      { scopeName: '@my-org/weather-card' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid scope/name positional', async () => {
    const result = await runGadgetCreate(
      { scopeName: 'not-a-scope' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid-scope-name');
  });

  it('returns manifest-invalid when scope fails schema regex', async () => {
    // Uppercase in scope fails `ArtifactScopeSchema`.
    const result = await runGadgetCreate(
      { scopeName: '@MyOrg/weather-card' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('manifest-invalid');
  });

  it('private visibility flows into manifest', async () => {
    const result = await runGadgetCreate(
      { scopeName: '@my-org/weather-card', visibility: 'private' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.visibility).toBe('private');
  });
});
