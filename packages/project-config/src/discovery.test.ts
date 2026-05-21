/**
 * Tests for blueprint manifest discovery.
 *
 * Exercises the walk-and-parse flow against real filesystem fixtures
 * (temp dirs, not mocked `fs`) because the behaviour under test is
 * "real glob against real files, real JSON round-trip, real schema
 * validation." Mocked `fs` would shadow exactly the code paths we
 * care about.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from './schema.js';
import { discoverFromGguiJsonPath, discoverLocalUis } from './discovery.js';

type ManifestInit = {
  id: string;
  name?: string;
  contract?: unknown;
  extra?: Record<string, unknown>;
};

function manifestJson(init: ManifestInit): string {
  return JSON.stringify({
    id: init.id,
    name: init.name ?? init.id,
    contract: init.contract ?? { intent: 'test' },
    ...(init.extra ?? {}),
  });
}

function writeUi(projectRoot: string, relativeDir: string, init: ManifestInit): string {
  const dir = join(projectRoot, relativeDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'ggui.ui.json');
  writeFileSync(path, manifestJson(init));
  return path;
}

function makeGgui(overrides: Partial<GguiJsonV1> = {}): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'test', name: 'Test' },
    blueprints: { include: [] },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    mcpMounts: [],
    ...overrides,
  };
}

describe('discoverLocalUis', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-discover-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an empty result when blueprints.include is empty', async () => {
    const result = await discoverLocalUis({
      projectRoot: tmp,
      manifest: makeGgui(),
    });
    expect(result.uis).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('finds a single ggui.ui.json under a glob and returns its id + path + manifest', async () => {
    const manifestPath = writeUi(tmp, 'ui/weather-card', { id: 'weather-card', name: 'Weather' });
    const result = await discoverLocalUis({
      projectRoot: tmp,
      manifest: makeGgui({ blueprints: { include: ['ui/**/ggui.ui.json'] } }),
    });

    expect(result.issues).toEqual([]);
    expect(result.uis).toHaveLength(1);
    expect(result.uis[0]?.id).toBe('weather-card');
    expect(result.uis[0]?.manifestPath).toBe(manifestPath);
    expect(result.uis[0]?.manifest.name).toBe('Weather');
  });

  it('skips glob matches whose basename is not ggui.ui.json', async () => {
    writeUi(tmp, 'ui/weather-card', { id: 'weather-card' });
    // A stray JSON the user might accidentally match with a wide pattern.
    mkdirSync(join(tmp, 'ui/weather-card'), { recursive: true });
    writeFileSync(join(tmp, 'ui/weather-card/README.json'), JSON.stringify({ hi: true }));

    const result = await discoverLocalUis({
      projectRoot: tmp,
      manifest: makeGgui({ blueprints: { include: ['ui/**/*.json'] } }),
    });

    expect(result.issues).toEqual([]);
    expect(result.uis).toHaveLength(1);
    expect(result.uis[0]?.id).toBe('weather-card');
  });

  it('collects an issue (not a throw) for malformed JSON and continues', async () => {
    writeUi(tmp, 'ui/good', { id: 'good' });
    const badDir = join(tmp, 'ui/bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'ggui.ui.json'), '{ not valid json');

    const result = await discoverLocalUis({
      projectRoot: tmp,
      manifest: makeGgui({ blueprints: { include: ['ui/**/ggui.ui.json'] } }),
    });

    expect(result.uis.map((u) => u.id)).toEqual(['good']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/not valid JSON/);
    expect(result.issues[0]?.path).toBe('ui/bad/ggui.ui.json');
  });

  it('collects a schema issue for a manifest missing id', async () => {
    const badDir = join(tmp, 'ui/noid');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'ggui.ui.json'), JSON.stringify({ name: 'No id' }));

    const result = await discoverLocalUis({
      projectRoot: tmp,
      manifest: makeGgui({ blueprints: { include: ['ui/**/ggui.ui.json'] } }),
    });

    expect(result.uis).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/schema validation/);
  });

  it('surfaces duplicate ids as issues, keeping the first encounter', async () => {
    writeUi(tmp, 'ui/a', { id: 'shared', name: 'First' });
    writeUi(tmp, 'ui/b', { id: 'shared', name: 'Second' });

    const result = await discoverLocalUis({
      projectRoot: tmp,
      manifest: makeGgui({ blueprints: { include: ['ui/**/ggui.ui.json'] } }),
    });

    expect(result.uis).toHaveLength(1);
    // Don't assert which one won — tinyglobby ordering is stable but
    // implementation-defined; assert that the survivor is one of the
    // two and the other shows up as a conflict issue.
    const survivorName = result.uis[0]?.manifest.name;
    expect(['First', 'Second']).toContain(survivorName);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/Duplicate id "shared"/);
  });

  it('handles multiple include globs without double-counting the same file', async () => {
    writeUi(tmp, 'ui/a', { id: 'a' });
    writeUi(tmp, 'ui/b', { id: 'b' });

    const result = await discoverLocalUis({
      projectRoot: tmp,
      manifest: makeGgui({
        blueprints: { include: ['ui/**/ggui.ui.json', 'ui/a/ggui.ui.json'] },
      }),
    });

    expect(result.uis.map((u) => u.id).sort()).toEqual(['a', 'b']);
    // The a-in-both-globs case should either be deduped by tinyglobby
    // or bounce off seenIds as a duplicate id conflict — either
    // behaviour is correct. Assert we did NOT emit two entries for it.
    expect(result.uis.filter((u) => u.id === 'a')).toHaveLength(1);
  });

  it('returns an empty result when globs match nothing', async () => {
    const result = await discoverLocalUis({
      projectRoot: tmp,
      manifest: makeGgui({ blueprints: { include: ['ui/**/ggui.ui.json'] } }),
    });
    expect(result.uis).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('rejects non-absolute projectRoot', async () => {
    await expect(
      discoverLocalUis({
        projectRoot: 'relative/path',
        manifest: makeGgui(),
      }),
    ).rejects.toThrow(/projectRoot must be absolute/);
  });

  it('discovers ggui.ui.json under .ggui/installed-blueprints/** (the gadget-install materialize path)', async () => {
    // Mirrors what `ggui gadget install <blueprint>` writes:
    // `.ggui/installed-blueprints/<scope>__<name>__<version>/ggui.ui.json`.
    // The dot-prefixed root is the integration point — tinyglobby's
    // `dot: false` default would skip `**` inside a hidden directory
    // UNLESS the pattern itself starts with `.`, which our auto-added
    // glob does. This test pins that behavior so a future tinyglobby
    // upgrade or a discovery-side default change can't silently break
    // marketplace-installed blueprints.
    writeUi(tmp, '.ggui/installed-blueprints/my-org__weather-card__0.1.0', {
      id: 'my-org:weather-card:0.1.0',
      name: '@my-org/weather-card',
    });

    const result = await discoverLocalUis({
      projectRoot: tmp,
      manifest: makeGgui({
        blueprints: { include: ['.ggui/installed-blueprints/**/ggui.ui.json'] },
      }),
    });

    expect(result.issues).toEqual([]);
    expect(result.uis).toHaveLength(1);
    expect(result.uis[0]?.id).toBe('my-org:weather-card:0.1.0');
  });
});

describe('discoverFromGguiJsonPath', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-discover-ggui-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('derives the project root from the manifest path', async () => {
    writeUi(tmp, 'ui/card', { id: 'card' });
    const gguiJsonPath = join(tmp, 'ggui.json');
    writeFileSync(gguiJsonPath, '{}'); // contents not parsed here; caller supplies GguiJsonV1

    const result = await discoverFromGguiJsonPath(
      gguiJsonPath,
      makeGgui({ blueprints: { include: ['ui/**/ggui.ui.json'] } }),
    );

    expect(result.uis.map((u) => u.id)).toEqual(['card']);
  });
});
