import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from '@ggui-ai/project-config';
import { LocalUiRegistry } from './local-registry.js';

function makeGgui(include: string[]): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'test', name: 'Test' },
    blueprints: { include },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    mcpMounts: [],
  };
}

function writeUi(
  projectRoot: string,
  relativeDir: string,
  id: string,
  extras: Record<string, unknown> = {},
): string {
  const dir = join(projectRoot, relativeDir);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, 'ggui.ui.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      id,
      name: id,
      contract: { intent: 'test' },
      ...extras,
    }),
  );
  return manifestPath;
}

describe('LocalUiRegistry', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-cli-local-reg-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('declares itself observable (watcher-backed)', () => {
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui([]),
    });
    expect(registry.capabilities).toEqual({ observable: true });
    expect(typeof registry.subscribe).toBe('function');
  });

  it('lists discovered UIs as UiManifestEntry rows', async () => {
    writeUi(tmp, 'ui/weather', 'weather-card', { contentHash: 'abc123' });
    writeUi(tmp, 'ui/form', 'contact-form');
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });

    const list = await registry.list();
    expect(list.map((e) => e.id).sort()).toEqual(['contact-form', 'weather-card']);
    const weather = list.find((e) => e.id === 'weather-card');
    expect(weather?.contentHash).toBe('abc123');
    expect(weather?.manifest.name).toBe('weather-card');

    const contact = list.find((e) => e.id === 'contact-form');
    // Authored manifest with no contentHash → empty string, per the
    // "source-only dev registry" note in LocalUiRegistry.
    expect(contact?.contentHash).toBe('');
  });

  it('get(id) returns undefined for unknown ids (not an error)', async () => {
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui([]),
    });
    expect(await registry.get('nope')).toBeUndefined();
  });

  it('getBundle returns undefined when no colocated artifact AND no TSX entry exists', async () => {
    writeUi(tmp, 'ui/card', 'card');
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    expect(await registry.getBundle('card')).toBeUndefined();
  });

  it('getBundle compiles the colocated ggui.ui.tsx on demand when no precompiled artifact exists', async () => {
    writeUi(tmp, 'ui/card', 'card');
    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.tsx'),
      `export default function Card() { return null; }`,
    );
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    const bundle = await registry.getBundle('card');
    expect(bundle?.contentType).toBe('application/javascript+react');
    expect(bundle?.code).toMatch(/as\s+default|export\s+default/);
  });

  it('precompiled ggui.ui.js wins when newer than (or equal to) ggui.ui.tsx', async () => {
    writeUi(tmp, 'ui/card', 'card');
    // Write tsx first...
    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.tsx'),
      `export default function Card() { return null; }`,
    );
    // ...then the precompiled output second, so mtime is newer.
    writeFileSync(join(tmp, 'ui/card/ggui.ui.js'), 'export const MARKER = "precompiled";');
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    const bundle = await registry.getBundle('card');
    // The precompiled file body is raw (unminified, no bundling), so a
    // marker comparison is the cleanest assertion that we took the
    // fast-path instead of recompiling the TSX.
    expect(bundle?.code).toContain('MARKER = "precompiled"');
  });

  it('TSX newer than colocated .js invalidates the precompiled fast-path', async () => {
    writeUi(tmp, 'ui/card', 'card');
    // Precompiled artifact from some earlier build...
    writeFileSync(join(tmp, 'ui/card/ggui.ui.js'), 'export const MARKER = "stale";');
    // Wait a tick so mtimes can differ meaningfully, then write the
    // source (simulates "user just edited the TSX").
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.tsx'),
      `export default function Card() { return null; }`,
    );

    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    const result = await registry.fetchBundle('card');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.source).toBe('compiled');
    // Must not contain the stale marker — a compile-on-demand of
    // the TSX won the freshness race.
    expect(result.bundle.code).not.toContain('MARKER = "stale"');
    // Must contain something that looks like a real compiled output.
    expect(result.bundle.code).toMatch(/as\s+default|export\s+default/);
  });

  it('fetchBundle distinguishes precompiled vs compiled in the result', async () => {
    // Precompiled case
    writeUi(tmp, 'ui/a', 'a');
    writeFileSync(join(tmp, 'ui/a/ggui.ui.js'), 'export default () => null;');
    // Compiled case
    writeUi(tmp, 'ui/b', 'b');
    writeFileSync(
      join(tmp, 'ui/b/ggui.ui.tsx'),
      `export default function B() { return null; }`,
    );
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    const a = await registry.fetchBundle('a');
    const b = await registry.fetchBundle('b');
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    if (a.kind === 'ok') expect(a.source).toBe('precompiled');
    if (b.kind === 'ok') expect(b.source).toBe('compiled');
  });

  it('fetchBundle returns missing-entry when neither precompiled nor TSX entry exists', async () => {
    writeUi(tmp, 'ui/card', 'card');
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    const result = await registry.fetchBundle('card');
    expect(result.kind).toBe('missing-entry');
  });

  it('fetchBundle returns compile-failed with esbuild error locations on invalid TSX', async () => {
    writeUi(tmp, 'ui/broken', 'broken');
    writeFileSync(
      join(tmp, 'ui/broken/ggui.ui.tsx'),
      `export default function Broken() { return <div>; }`,
    );
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    const result = await registry.fetchBundle('broken');
    expect(result.kind).toBe('compile-failed');
    if (result.kind !== 'compile-failed') return;
    expect(result.errors.length).toBeGreaterThan(0);
    // At least one error should carry a location pointing at the TSX.
    const located = result.errors.find((e) => e.location !== null);
    expect(located).toBeDefined();
  });

  it('fetchBundle returns not-found for unknown ids', async () => {
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui([]),
    });
    const result = await registry.fetchBundle('nope');
    expect(result.kind).toBe('not-found');
  });

  it('getBundle returns the colocated ggui.ui.js when present', async () => {
    const manifestPath = writeUi(tmp, 'ui/card', 'card');
    writeFileSync(join(tmp, 'ui/card/ggui.ui.js'), 'export default () => null;');
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });

    const bundle = await registry.getBundle('card');
    expect(bundle?.contentType).toBe('application/javascript+react');
    expect(bundle?.code).toBe('export default () => null;');
    // Silence unused-var lint on fixture output path.
    expect(manifestPath).toContain('ui/card/ggui.ui.json');
  });

  it('getBundle also accepts a colocated ggui.ui.mjs', async () => {
    writeUi(tmp, 'ui/card', 'card');
    writeFileSync(join(tmp, 'ui/card/ggui.ui.mjs'), '/* mjs */');
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    const bundle = await registry.getBundle('card');
    expect(bundle?.code).toBe('/* mjs */');
  });

  it('refresh() re-scans the filesystem', async () => {
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    expect((await registry.list()).length).toBe(0);

    writeUi(tmp, 'ui/later', 'later');
    // No refresh yet — still cached empty.
    expect((await registry.list()).length).toBe(0);

    const outcome = await registry.refresh();
    expect(outcome.uiCount).toBe(1);
    expect((await registry.list()).length).toBe(1);
  });

  it('surfaces discovery issues via getIssues (non-UiRegistry diagnostic)', async () => {
    mkdirSync(join(tmp, 'ui/bad'), { recursive: true });
    writeFileSync(join(tmp, 'ui/bad/ggui.ui.json'), '{ not valid json');
    const registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });

    await registry.list();
    expect(registry.getIssues()).toHaveLength(1);
    expect(registry.getIssues()[0]?.message).toMatch(/not valid JSON/);
  });
});
