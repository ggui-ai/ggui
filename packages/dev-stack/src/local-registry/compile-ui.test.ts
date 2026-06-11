import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiManifest } from '@ggui-ai/project-config';
import { compileUiOnDemand, resolveEntryFile } from './compile-ui.js';

function manifest(overrides: Partial<UiManifest> = {}): UiManifest {
  return {
    id: overrides.id ?? 'test',
    name: overrides.name ?? 'Test',
    contract: overrides.contract ?? {
      propsSpec: { properties: { label: { schema: { type: 'string' } } } },
    },
    ...(overrides.entryPoint !== undefined ? { entryPoint: overrides.entryPoint } : {}),
  };
}

describe('resolveEntryFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-cli-compile-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns manifest.entryPoint resolved relative to projectRoot when it exists', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src/card.tsx'), 'export default () => null;');
    const result = resolveEntryFile({
      projectRoot: tmp,
      manifestPath: join(tmp, 'src/ggui.ui.json'),
      manifest: manifest({ entryPoint: 'src/card.tsx' }),
    });
    expect('entry' in result).toBe(true);
    expect((result as { entry: string }).entry).toBe(join(tmp, 'src/card.tsx'));
  });

  it('returns tried list when manifest.entryPoint is declared but missing', () => {
    const result = resolveEntryFile({
      projectRoot: tmp,
      manifestPath: join(tmp, 'ggui.ui.json'),
      manifest: manifest({ entryPoint: 'does-not-exist.tsx' }),
    });
    expect('tried' in result).toBe(true);
    expect((result as { tried: string[] }).tried).toHaveLength(1);
  });

  it('falls back to ggui.ui.tsx beside the manifest when no entryPoint declared', () => {
    mkdirSync(join(tmp, 'ui/card'), { recursive: true });
    writeFileSync(join(tmp, 'ui/card/ggui.ui.tsx'), 'export default () => null;');
    const result = resolveEntryFile({
      projectRoot: tmp,
      manifestPath: join(tmp, 'ui/card/ggui.ui.json'),
      manifest: manifest(),
    });
    expect('entry' in result).toBe(true);
    expect((result as { entry: string }).entry).toBe(join(tmp, 'ui/card/ggui.ui.tsx'));
  });

  it('falls back to index.tsx after ggui.ui.tsx', () => {
    mkdirSync(join(tmp, 'ui/card'), { recursive: true });
    writeFileSync(join(tmp, 'ui/card/index.tsx'), 'export default () => null;');
    const result = resolveEntryFile({
      projectRoot: tmp,
      manifestPath: join(tmp, 'ui/card/ggui.ui.json'),
      manifest: manifest(),
    });
    expect('entry' in result).toBe(true);
    expect((result as { entry: string }).entry).toBe(join(tmp, 'ui/card/index.tsx'));
  });

  it('returns tried list with all candidates when no fallback exists', () => {
    mkdirSync(join(tmp, 'ui/card'), { recursive: true });
    const result = resolveEntryFile({
      projectRoot: tmp,
      manifestPath: join(tmp, 'ui/card/ggui.ui.json'),
      manifest: manifest(),
    });
    expect('tried' in result).toBe(true);
    const tried = (result as { tried: string[] }).tried;
    expect(tried.length).toBeGreaterThan(0);
    expect(tried.every((p) => p.startsWith(join(tmp, 'ui/card')))).toBe(true);
  });
});

describe('compileUiOnDemand', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-cli-compile-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('compiles a trivial TSX entry and returns ESM code', async () => {
    mkdirSync(join(tmp, 'ui/card'), { recursive: true });
    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.tsx'),
      `export default function Card() { return null; }`,
    );
    const result = await compileUiOnDemand({
      projectRoot: tmp,
      manifestPath: join(tmp, 'ui/card/ggui.ui.json'),
      manifest: manifest(),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.code.length).toBeGreaterThan(0);
    // esbuild 0.25+ emits `export { X as default }` for default exports.
    // Accept either the classic syntax or the as-default remap.
    expect(result.code).toMatch(/export\s*(\{[^}]*as\s+default[^}]*\}|\s*default)/);
    expect(result.entry).toBe(join(tmp, 'ui/card/ggui.ui.tsx'));
  });

  it('externalises react + @ggui-ai/design so the bundle stays import-based', async () => {
    mkdirSync(join(tmp, 'ui/card'), { recursive: true });
    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.tsx'),
      `
import { Button } from '@ggui-ai/design/primitives';
export default function Card() {
  return <Button>Go</Button>;
}
      `.trim(),
    );
    const result = await compileUiOnDemand({
      projectRoot: tmp,
      manifestPath: join(tmp, 'ui/card/ggui.ui.json'),
      manifest: manifest(),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Externals stay as import statements (not inlined).
    expect(result.code).toMatch(/from\s*["']@ggui-ai\/design\/primitives["']/);
    expect(result.code).toMatch(/from\s*["']react\/jsx-runtime["']/);
  });

  it('returns missing-entry when nothing can be found', async () => {
    mkdirSync(join(tmp, 'ui/empty'), { recursive: true });
    const result = await compileUiOnDemand({
      projectRoot: tmp,
      manifestPath: join(tmp, 'ui/empty/ggui.ui.json'),
      manifest: manifest(),
    });
    expect(result.kind).toBe('missing-entry');
    if (result.kind !== 'missing-entry') return;
    expect(result.tried.length).toBeGreaterThan(0);
  });

  it('returns failure with typed esbuild errors on a syntax error', async () => {
    mkdirSync(join(tmp, 'ui/broken'), { recursive: true });
    writeFileSync(
      join(tmp, 'ui/broken/ggui.ui.tsx'),
      `export default function Broken() { return <div>; }`,
    );
    const result = await compileUiOnDemand({
      projectRoot: tmp,
      manifestPath: join(tmp, 'ui/broken/ggui.ui.json'),
      manifest: manifest(),
    });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.entry).toBe(join(tmp, 'ui/broken/ggui.ui.tsx'));
  });

  it('returns failure when the entry imports a missing local file', async () => {
    mkdirSync(join(tmp, 'ui/bad-import'), { recursive: true });
    writeFileSync(
      join(tmp, 'ui/bad-import/ggui.ui.tsx'),
      `
import { missing } from './no-such-file';
export default () => missing();
      `.trim(),
    );
    const result = await compileUiOnDemand({
      projectRoot: tmp,
      manifestPath: join(tmp, 'ui/bad-import/ggui.ui.json'),
      manifest: manifest(),
    });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.errors.some((e) => /resolve/i.test(e.text) || /no-such-file/.test(e.text))).toBe(true);
  });
});
