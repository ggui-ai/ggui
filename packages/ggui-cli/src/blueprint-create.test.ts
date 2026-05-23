/**
 * `ggui blueprint create` unit tests. Mirrors `gadget-create.test.ts`
 * — every test runs in its own randomized tmpdir so parallel cases
 * never collide.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GGUI_BLUEPRINT_JSON_FILENAME,
  parseBlueprintManifest,
} from '@ggui-ai/artifact-manifest';
import {
  buildScaffoldManifest,
  parseBlueprintCreateFlags,
  runBlueprintCreate,
} from './blueprint-create.js';

describe('parseBlueprintCreateFlags', () => {
  it('returns __help__ when called with no args', () => {
    expect(parseBlueprintCreateFlags([]).error).toBe('__help__');
  });

  it('returns __help__ on --help / -h', () => {
    expect(parseBlueprintCreateFlags(['--help']).error).toBe('__help__');
    expect(parseBlueprintCreateFlags(['-h']).error).toBe('__help__');
  });

  it('parses a bare positional', () => {
    const r = parseBlueprintCreateFlags(['@my-org/login-form']);
    expect(r.error).toBeUndefined();
    expect(r.flags?.scopeName).toBe('@my-org/login-form');
  });

  it('parses --dir + --description + --visibility', () => {
    const r = parseBlueprintCreateFlags([
      '@my-org/login-form',
      '--dir',
      '/tmp/x',
      '--description',
      'Login form blueprint',
      '--visibility',
      'private',
    ]);
    expect(r.error).toBeUndefined();
    expect(r.flags).toEqual({
      scopeName: '@my-org/login-form',
      dir: '/tmp/x',
      description: 'Login form blueprint',
      visibility: 'private',
    });
  });

  it('rejects unknown flag', () => {
    const r = parseBlueprintCreateFlags(['@my-org/login-form', '--frobnicate']);
    expect(r.error).toMatch(/unknown flag/);
  });

  it('rejects --visibility outside {public, private}', () => {
    const r = parseBlueprintCreateFlags(['@x/y', '--visibility', 'org']);
    expect(r.error).toMatch(/visibility/);
  });
});

describe('buildScaffoldManifest', () => {
  it('produces a manifest that round-trips through parseBlueprintManifest', () => {
    const m = buildScaffoldManifest({
      scope: '@my-org',
      name: 'login-form',
      visibility: 'public',
      source: 'export default function () { return null; }',
    });
    const parsed = parseBlueprintManifest(m);
    expect(parsed.kind).toBe('blueprint');
    expect(parsed.scope).toBe('@my-org');
    expect(parsed.name).toBe('login-form');
    expect(parsed.version).toBe('0.0.1');
  });
});

describe('runBlueprintCreate', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = join(tmpdir(), `ggui-blueprint-create-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('scaffolds the expected file set', async () => {
    const result = await runBlueprintCreate(
      { scopeName: '@my-org/login-form' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual([
      GGUI_BLUEPRINT_JSON_FILENAME,
      'package.json',
      'src/blueprint.tsx',
      'src/contract.ts',
      'README.md',
    ]);
    // Manifest on disk must parse cleanly.
    const manifestText = await readFile(
      join(result.targetDir, GGUI_BLUEPRINT_JSON_FILENAME),
      'utf-8',
    );
    const parsed = parseBlueprintManifest(JSON.parse(manifestText));
    expect(parsed.kind).toBe('blueprint');
    expect(parsed.scope).toBe('@my-org');
    expect(parsed.name).toBe('login-form');
    // Source body is a default-exported React component stub.
    const tsx = await readFile(
      join(result.targetDir, 'src', 'blueprint.tsx'),
      'utf-8',
    );
    expect(tsx).toContain('export default function');
  });

  it('rejects an invalid blueprint name (uppercase)', async () => {
    const result = await runBlueprintCreate(
      { scopeName: '@my-org/LoginForm' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-name');
  });

  it('rejects an invalid scope/name shape', async () => {
    const result = await runBlueprintCreate(
      { scopeName: 'not-an-id' },
      { cwd: workDir },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-scope-name');
  });

  it('refuses to overwrite a non-empty target dir', async () => {
    const dir = 'existing';
    await mkdir(join(workDir, dir));
    await writeFile(join(workDir, dir, 'placeholder.txt'), 'not empty\n');
    const result = await runBlueprintCreate(
      { scopeName: '@my-org/login-form', dir },
      { cwd: workDir },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('target-not-empty');
  });

  it('--dir honors absolute paths (regression: was concatenated under cwd via path.join)', async () => {
    // Absolute --dir outside cwd. Pre-fix: targetDir landed at
    // `<cwd>/tmp/.../absolute-dir/...` (path.join concatenation),
    // making `--dir <absolute>` silently broken. Post-fix uses
    // path.resolve so the absolute path wins.
    const absoluteDir = join(workDir, 'absolute-target');
    const result = await runBlueprintCreate(
      { scopeName: '@my-org/login-form', dir: absoluteDir },
      { cwd: '/different/cwd/that/does/not/exist' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetDir).toBe(absoluteDir);
    // Scaffold landed at the requested absolute path, not concatenated
    // beneath the bogus cwd.
    const tsx = await readFile(
      join(absoluteDir, 'src', 'blueprint.tsx'),
      'utf-8',
    );
    expect(tsx).toContain('export default function');
  });

  it('--description threads through to the manifest', async () => {
    const result = await runBlueprintCreate(
      {
        scopeName: '@my-org/login-form',
        description: 'A nice blueprint for login UIs.',
      },
      { cwd: workDir },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.description).toBe('A nice blueprint for login UIs.');
  });
});
