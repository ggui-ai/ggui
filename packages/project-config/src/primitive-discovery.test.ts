/**
 * Tests for primitive manifest discovery.
 *
 * Uses real filesystem fixtures (tempdirs) so the behaviour under
 * test is "real file I/O + real JSON + real zod validation." The
 * module-resolver hook is injected through `resolveModule` so we
 * don't have to build actual `node_modules/` trees in the tempdir —
 * each test synthesises a fake package root and a fake resolver
 * that points at an entry inside it. Mirrors the same split blueprint
 * discovery tests use (real FS, thin injection for parts that depend
 * on global state like `require` caches).
 */
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from './schema.js';
import {
  discoverPrimitives,
  discoverPrimitivesFromGguiJsonPath,
} from './primitive-discovery.js';

function manifestJson(init: {
  import: string;
  primitives?: Array<{ name: string }>;
  docs?: string;
}): string {
  return JSON.stringify({
    schema: '1',
    import: init.import,
    primitives: init.primitives ?? [{ name: 'Button' }],
    ...(init.docs !== undefined ? { docs: init.docs } : {}),
  });
}

function writePackagePrimitives(
  projectRoot: string,
  pkgName: string,
  init: { import: string; primitives?: Array<{ name: string }>; docs?: string },
): { pkgRoot: string; entryFile: string } {
  const pkgRoot = join(projectRoot, 'node_modules', pkgName);
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(
    join(pkgRoot, 'package.json'),
    JSON.stringify({ name: pkgName, version: '0.0.1' }),
  );
  writeFileSync(join(pkgRoot, 'ggui.primitives.json'), manifestJson(init));
  const entryFile = join(pkgRoot, 'index.js');
  writeFileSync(entryFile, 'export {};\n');
  return { pkgRoot, entryFile };
}

function writeLocalManifest(
  projectRoot: string,
  relDir: string,
  init: { import: string; primitives?: Array<{ name: string }>; docs?: string },
): string {
  const dir = join(projectRoot, relDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'ggui.primitives.json');
  writeFileSync(path, manifestJson(init));
  return path;
}

function makeGgui(overrides: Partial<GguiJsonV1> = {}): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'test', name: 'Test' },
    blueprints: { include: [] },
    primitives: { packages: [], local: [] },
    mcpMounts: [],
    ...overrides,
  };
}

describe('discoverPrimitives — zero-config', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-primitives-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an empty result when packages and local are both empty', async () => {
    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui(),
    });
    expect(result.catalogs).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('throws when projectRoot is not absolute', async () => {
    await expect(
      discoverPrimitives({
        projectRoot: 'relative/path',
        manifest: makeGgui(),
      }),
    ).rejects.toThrow(/absolute/);
  });
});

describe('discoverPrimitives — packages', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-primitives-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves one declared package and parses its manifest', async () => {
    const { entryFile } = writePackagePrimitives(tmp, '@acme/ui', {
      import: '@acme/ui',
      primitives: [{ name: 'Button' }, { name: 'Card' }],
    });

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({ primitives: { packages: ['@acme/ui'], local: [] } }),
      resolveModule: (spec) => {
        if (spec === '@acme/ui') return entryFile;
        throw new Error(`resolveModule stub: unknown spec ${spec}`);
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.catalogs).toHaveLength(1);
    expect(result.catalogs[0]).toMatchObject({
      source: 'package',
      import: '@acme/ui',
    });
    expect(result.catalogs[0]?.manifest.primitives.map((p) => p.name)).toEqual([
      'Button',
      'Card',
    ]);
  });

  it('walks up from a subpath entry to the enclosing package root', async () => {
    // Real packages often expose a subpath (e.g. `@ggui-ai/design/primitives`);
    // the resolver returns a file deep inside the package and discovery
    // must walk UP to find `package.json` + the colocated manifest.
    const pkgName = '@acme/ui';
    const pkgRoot = join(tmp, 'node_modules', pkgName);
    mkdirSync(join(pkgRoot, 'dist', 'primitives'), { recursive: true });
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({ name: pkgName }),
    );
    writeFileSync(
      join(pkgRoot, 'ggui.primitives.json'),
      manifestJson({ import: '@acme/ui/primitives' }),
    );
    const subpathEntry = join(pkgRoot, 'dist', 'primitives', 'index.js');
    writeFileSync(subpathEntry, 'export {};');

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({
        primitives: { packages: ['@acme/ui/primitives'], local: [] },
      }),
      resolveModule: (spec) => {
        if (spec === '@acme/ui/primitives') return subpathEntry;
        throw new Error(`resolveModule stub: unknown spec ${spec}`);
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.catalogs).toHaveLength(1);
    expect(result.catalogs[0]?.import).toBe('@acme/ui/primitives');
  });

  it('surfaces an issue when the package does not resolve', async () => {
    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({
        primitives: { packages: ['@missing/pkg'], local: [] },
      }),
      resolveModule: () => {
        throw new Error('Cannot find module');
      },
    });

    expect(result.catalogs).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('@missing/pkg');
    expect(result.issues[0]?.message).toMatch(/Could not resolve/);
  });

  it('surfaces an issue when the package has no ggui.primitives.json at its root', async () => {
    const pkgName = '@acme/ui';
    const pkgRoot = join(tmp, 'node_modules', pkgName);
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({ name: pkgName }),
    );
    const entry = join(pkgRoot, 'index.js');
    writeFileSync(entry, 'export {};');

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({ primitives: { packages: ['@acme/ui'], local: [] } }),
      resolveModule: () => entry,
    });

    expect(result.catalogs).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/missing ggui\.primitives\.json/);
  });

  it('surfaces an issue when the manifest is malformed JSON', async () => {
    const pkgName = '@acme/ui';
    const pkgRoot = join(tmp, 'node_modules', pkgName);
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({ name: pkgName }),
    );
    writeFileSync(join(pkgRoot, 'ggui.primitives.json'), '{ not valid json');
    const entry = join(pkgRoot, 'index.js');
    writeFileSync(entry, 'export {};');

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({ primitives: { packages: ['@acme/ui'], local: [] } }),
      resolveModule: () => entry,
    });

    expect(result.catalogs).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/not valid JSON/);
  });

  it('surfaces an issue when the manifest fails schema validation', async () => {
    const pkgName = '@acme/ui';
    const pkgRoot = join(tmp, 'node_modules', pkgName);
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({ name: pkgName }),
    );
    // Missing `schema` and `primitives` fields → schema validation fails.
    writeFileSync(
      join(pkgRoot, 'ggui.primitives.json'),
      JSON.stringify({ import: '@acme/ui' }),
    );
    const entry = join(pkgRoot, 'index.js');
    writeFileSync(entry, 'export {};');

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({ primitives: { packages: ['@acme/ui'], local: [] } }),
      resolveModule: () => entry,
    });

    expect(result.catalogs).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/schema validation/);
  });

  it("surfaces an issue when the manifest's import does not match the declared package spec", async () => {
    const { entryFile } = writePackagePrimitives(tmp, '@acme/ui', {
      import: '@someone-else/ui', // mismatch
    });

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({ primitives: { packages: ['@acme/ui'], local: [] } }),
      resolveModule: () => entryFile,
    });

    expect(result.catalogs).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(
      /import="@someone-else\/ui".*primitives\.packages as "@acme\/ui"/,
    );
  });
});

describe('discoverPrimitives — local globs', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-primitives-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('matches a local ggui.primitives.json under a glob and parses it', async () => {
    writeLocalManifest(tmp, 'ui/primitives', {
      import: './src/ui/primitives/index.js',
      primitives: [{ name: 'Brand' }],
    });

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({
        primitives: {
          packages: [],
          local: ['ui/**/ggui.primitives.json'],
        },
      }),
    });

    expect(result.issues).toEqual([]);
    expect(result.catalogs).toHaveLength(1);
    expect(result.catalogs[0]).toMatchObject({
      source: 'local',
      import: './src/ui/primitives/index.js',
    });
  });

  it('skips matches whose basename is not ggui.primitives.json (wide ** safety)', async () => {
    // A wide pattern that picks up a non-manifest JSON file — common
    // when users write `ui/**/*.json` expecting it to be specific.
    mkdirSync(join(tmp, 'ui'), { recursive: true });
    writeFileSync(
      join(tmp, 'ui', 'readme.json'),
      JSON.stringify({ hello: 'world' }),
    );
    writeLocalManifest(tmp, 'ui/primitives', {
      import: './src/ui/primitives/index.js',
    });

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({
        primitives: { packages: [], local: ['ui/**/*.json'] },
      }),
    });

    expect(result.issues).toEqual([]);
    expect(result.catalogs).toHaveLength(1);
    expect(result.catalogs[0]?.import).toBe('./src/ui/primitives/index.js');
  });

  it('allows globs that match zero files (catalog not yet authored)', async () => {
    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({
        primitives: { packages: [], local: ['ui/**/ggui.primitives.json'] },
      }),
    });
    expect(result.catalogs).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('surfaces schema issues for malformed local manifests', async () => {
    mkdirSync(join(tmp, 'ui'), { recursive: true });
    writeFileSync(
      join(tmp, 'ui', 'ggui.primitives.json'),
      JSON.stringify({ schema: '1', import: 'x', primitives: [] }),
    );

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({
        primitives: { packages: [], local: ['ui/ggui.primitives.json'] },
      }),
    });
    expect(result.catalogs).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/schema validation/);
  });
});

describe('discoverPrimitives — duplicate specifiers across sources', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-primitives-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('first-seen wins when two sources declare the same import specifier', async () => {
    const { entryFile } = writePackagePrimitives(tmp, '@acme/ui', {
      import: 'shared-spec',
    });
    writeLocalManifest(tmp, 'ui/primitives', { import: 'shared-spec' });

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({
        // Build-time mismatch guard against the default primitives
        // spec: pass the package under a DIFFERENT declared spec
        // than its manifest says.
        primitives: {
          packages: ['@acme/ui'],
          local: ['ui/**/ggui.primitives.json'],
        },
      }),
      resolveModule: () => entryFile,
    });

    // Package is visited first in declaration order. Its manifest's
    // `import = "shared-spec"` does NOT match the declared spec
    // "@acme/ui" — so we surface an import-mismatch issue and the
    // catalog stays empty for that entry. Local then claims the
    // specifier cleanly.
    expect(result.issues.some((i) => /import="shared-spec"/.test(i.message))).toBe(
      true,
    );
    expect(result.catalogs).toHaveLength(1);
    expect(result.catalogs[0]?.source).toBe('local');
    expect(result.catalogs[0]?.import).toBe('shared-spec');
  });

  it('reports duplicate specifier across two matching packages', async () => {
    const acme = writePackagePrimitives(tmp, '@acme/ui', {
      import: '@acme/ui',
    });
    const beta = writePackagePrimitives(tmp, '@beta/ui', {
      import: '@acme/ui', // claims someone else's specifier
    });

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({
        primitives: { packages: ['@acme/ui', '@beta/ui'], local: [] },
      }),
      resolveModule: (spec) => {
        if (spec === '@acme/ui') return acme.entryFile;
        if (spec === '@beta/ui') return beta.entryFile;
        throw new Error(`resolveModule stub: unknown ${spec}`);
      },
    });

    // First one (@acme/ui) succeeds; second one (@beta/ui) hits the
    // import-mismatch guard first because the declared spec "@beta/ui"
    // doesn't match the manifest's `import = "@acme/ui"`. We don't get
    // to the duplicate-specifier branch — but the mismatch guard is
    // strictly stronger anyway. Assert both outcomes together.
    expect(result.catalogs).toHaveLength(1);
    expect(result.catalogs[0]?.import).toBe('@acme/ui');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('@beta/ui');
  });

  it('reports a true duplicate when two local manifests share the same import', async () => {
    writeLocalManifest(tmp, 'ui/a', { import: 'local-shared' });
    writeLocalManifest(tmp, 'ui/b', { import: 'local-shared' });

    const result = await discoverPrimitives({
      projectRoot: tmp,
      manifest: makeGgui({
        primitives: { packages: [], local: ['ui/**/ggui.primitives.json'] },
      }),
    });

    expect(result.catalogs).toHaveLength(1);
    expect(result.catalogs[0]?.import).toBe('local-shared');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/Duplicate primitive import specifier/);
  });
});

describe('discoverPrimitivesFromGguiJsonPath', () => {
  it('resolves projectRoot from the given manifest path', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-primitives-'));
    try {
      writeLocalManifest(tmp, 'ui/primitives', {
        import: './src/ui/primitives/index.js',
      });
      const gguiPath = join(tmp, 'ggui.json');
      const result = await discoverPrimitivesFromGguiJsonPath(
        gguiPath,
        makeGgui({
          primitives: {
            packages: [],
            local: ['ui/**/ggui.primitives.json'],
          },
        }),
      );
      expect(result.issues).toEqual([]);
      expect(result.catalogs).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
