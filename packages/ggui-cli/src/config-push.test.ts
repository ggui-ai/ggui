/**
 * Unit tests for `config-push.ts`.
 *
 * - `readGadgetsFromGguiJson` — valid / absent / malformed
 * - `readPublicEnvFromGguiJson` — valid / absent / invalid keys
 * - `assertGadgetBundlesReachable` — loopback hosts throw; cloud hosts pass
 * - `runConfigPushStep` — integration over `findGguiJson` + `readGguiJson` +
 *   `patchAppConfig`; disk-backed temp dir per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STDLIB_GADGETS,
  type GadgetDescriptor,
  type AppTheme,
} from '@ggui-ai/protocol';

// ─── hoisted mocks ────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  patchAppConfig: vi.fn<
    (
      appId: string,
      patch: {
        gadgets?: GadgetDescriptor[];
        publicEnv?: Record<string, string>;
        generation?: { model: string; keySource: 'own' | 'managed' };
        theme?: AppTheme;
      },
    ) => Promise<{ updated: string[] }>
  >(),
}));

vi.mock('./api-client.js', () => ({
  patchAppConfig: mocks.patchAppConfig,
}));

// Import AFTER vi.mock so the mock is in place.
import {
  readPublicEnvFromGguiJson,
  readGenerationFromGguiJson,
  readThemeFromGguiJson,
  assertGadgetBundlesReachable,
  runConfigPushStep,
} from './config-push.js';
import { readGadgetsFromGguiJson } from './internal/ggui-json.js';
import { appThemeSchema, canonicalOverlayHash } from '@ggui-ai/protocol';
import type { GguiJsonV1, ThemeConfig } from '@ggui-ai/project-config';

// ─── theme fixtures ─────────────────────────────────────────────────────────
/**
 * A complete `ggui.json` manifest with an optional `theme` block. `loadTheme`
 * (and the `GguiJsonV1` contract) require the full manifest shape, so theme
 * tests use this rather than the minimal slice fixtures the other readers
 * accept. Typed `GguiJsonV1` so the fixture stays honest about the wire shape.
 */
function makeThemeManifest(theme?: ThemeConfig): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'test', name: 'Test' },
    blueprints: { include: [] },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    mcpMounts: [],
    ...(theme !== undefined ? { theme } : {}),
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid GadgetDescriptor for test fixtures. */
function makeGadget(pkg: string, overrides: Partial<GadgetDescriptor> = {}): GadgetDescriptor {
  return {
    ...structuredClone(STDLIB_GADGETS[0]!),
    package: pkg,
    ...overrides,
  };
}

// ─── readGadgetsFromGguiJson (shared reader in internal/ggui-json.ts) ────────
describe('readGadgetsFromGguiJson', () => {
  it('returns ok with [] when app.gadgets is absent', () => {
    expect(readGadgetsFromGguiJson({})).toEqual({ ok: true, gadgets: [] });
    expect(readGadgetsFromGguiJson({ app: {} })).toEqual({
      ok: true,
      gadgets: [],
    });
  });

  it('returns ok with a typed array when app.gadgets is valid', () => {
    const descriptor = structuredClone(STDLIB_GADGETS[0]!);
    const input = { app: { gadgets: [descriptor] } };
    const result = readGadgetsFromGguiJson(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gadgets).toHaveLength(1);
      expect(result.gadgets[0]!.package).toBe(descriptor.package);
      expect(result.gadgets[0]!.version).toBe(descriptor.version);
    }
  });

  it('returns a row-indexed error when a gadget descriptor is malformed', () => {
    const bad = { app: { gadgets: [{ package: 'not-a-valid-npm-name!' }] } };
    const result = readGadgetsFromGguiJson(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The message blames the offending ROW by index and points at
      // editing ggui.json — install must never imply it caused this.
      expect(result.error).toContain('app.gadgets[0]');
      expect(result.error).toContain('ggui.json');
    }
  });

  it('returns an error when app.gadgets is not an array', () => {
    const bad = { app: { gadgets: 'not-an-array' } };
    const result = readGadgetsFromGguiJson(bad);
    expect(result.ok).toBe(false);
  });
});

// ─── readPublicEnvFromGguiJson ────────────────────────────────────────────────
describe('readPublicEnvFromGguiJson', () => {
  it('returns {} when app.publicEnv is absent', () => {
    expect(readPublicEnvFromGguiJson({})).toEqual({});
    expect(readPublicEnvFromGguiJson({ app: {} })).toEqual({});
  });

  it('returns the record when keys are valid GGUI_PUBLIC_APP_ prefixed', () => {
    const input = {
      app: {
        publicEnv: {
          GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.abc',
          GGUI_PUBLIC_APP_API_BASE: 'https://api.example.com',
        },
      },
    };
    const result = readPublicEnvFromGguiJson(input);
    expect(result).toEqual({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.abc',
      GGUI_PUBLIC_APP_API_BASE: 'https://api.example.com',
    });
  });

  it('throws when a key does not match GGUI_PUBLIC_APP_ pattern', () => {
    const bad = { app: { publicEnv: { SECRET_KEY: 'value' } } };
    expect(() => readPublicEnvFromGguiJson(bad)).toThrow();
  });

  it('throws when a value is not a string', () => {
    const bad = { app: { publicEnv: { GGUI_PUBLIC_APP_TOKEN: 42 } } };
    expect(() => readPublicEnvFromGguiJson(bad)).toThrow();
  });
});

// ─── readGenerationFromGguiJson ───────────────────────────────────────────────
describe('readGenerationFromGguiJson', () => {
  it('returns undefined when generation block is absent', () => {
    expect(readGenerationFromGguiJson({})).toBeUndefined();
    expect(readGenerationFromGguiJson({ app: {} })).toBeUndefined();
  });

  it('returns undefined when generation is present but model is absent', () => {
    expect(readGenerationFromGguiJson({ generation: {} })).toBeUndefined();
    expect(readGenerationFromGguiJson({ generation: { keySource: 'own' } })).toBeUndefined();
  });

  it('returns model+keySource when both are present', () => {
    const input = { generation: { model: 'anthropic:claude-haiku-4-5-20251001', keySource: 'own' as const } };
    const result = readGenerationFromGguiJson(input);
    expect(result).toEqual({ model: 'anthropic:claude-haiku-4-5-20251001', keySource: 'own' });
  });

  it('defaults keySource to "managed" when model is present but keySource is absent', () => {
    const input = { generation: { model: 'openai:gpt-5' } };
    const result = readGenerationFromGguiJson(input);
    expect(result).toEqual({ model: 'openai:gpt-5', keySource: 'managed' });
  });

  it('preserves the model as a raw string — does NOT transform it', () => {
    // The raw model string is forwarded as-is; cloud re-parses via parseAnyLlmRoute.
    const rawModel = 'gemini/gemini-3.5-flash';
    const input = { generation: { model: rawModel, keySource: 'managed' as const } };
    const result = readGenerationFromGguiJson(input);
    expect(result?.model).toBe(rawModel);
  });

  it('throws when generation.model is empty string', () => {
    const bad = { generation: { model: '' } };
    expect(() => readGenerationFromGguiJson(bad)).toThrow();
  });

  it('throws when generation.keySource is an invalid value', () => {
    const bad = { generation: { model: 'anthropic:claude-haiku-4-5-20251001', keySource: 'invalid' } };
    expect(() => readGenerationFromGguiJson(bad)).toThrow();
  });
});

// ─── readThemeFromGguiJson ────────────────────────────────────────────────────
describe('readThemeFromGguiJson', () => {
  const projectRoot = tmpdir();

  it('returns undefined when the theme field is absent', async () => {
    expect(await readThemeFromGguiJson(projectRoot, makeThemeManifest(undefined))).toBeUndefined();
  });

  it('resolves a preset theme to the v2 projection: both overlays, attestation, label, default mode', async () => {
    const manifest = makeThemeManifest({ preset: 'claudic', mode: 'dark' });
    const read = await readThemeFromGguiJson(projectRoot, manifest);
    expect(read).toBeDefined();
    const theme = read!.theme;
    expect(read!.declaredFaceFamilies).toEqual([]);
    expect(theme!.mode).toBe('dark');
    expect(theme!.name).toBe('claudic');
    expect(theme!.overlayHash).toMatch(/^[0-9a-f]{64}$/);
    for (const mode of ['light', 'dark'] as const) {
      const keys = Object.keys(theme!.overlays[mode]);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) {
        expect(k.startsWith('--ggui-'), `key ${k} must be --ggui-* namespaced`).toBe(true);
      }
    }
    expect(theme!.overlays.light).not.toEqual(theme!.overlays.dark);
    expect('cssVariables' in theme!).toBe(false);
  });

  it('the declared mode is the DEFAULT only — the same preset yields the same overlays either way', async () => {
    const dark = (await readThemeFromGguiJson(projectRoot, makeThemeManifest({ preset: 'claudic', mode: 'dark' })))?.theme;
    const light = (await readThemeFromGguiJson(projectRoot, makeThemeManifest({ preset: 'claudic', mode: 'light' })))?.theme;
    expect(dark!.mode).toBe('dark');
    expect(light!.mode).toBe('light');
    expect(dark!.overlays).toEqual(light!.overlays);
    expect(dark!.overlayHash).toBe(light!.overlayHash);
  });

  it('produces a value that passes appThemeSchema and whose attestation recomputes (proves the write door admits it)', async () => {
    const theme = (await readThemeFromGguiJson(projectRoot, makeThemeManifest({ preset: 'ggui', mode: 'light' })))?.theme;
    const parsed = appThemeSchema.safeParse(theme);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(await canonicalOverlayHash({ overlays: theme!.overlays })).toBe(theme!.overlayHash);
  });

  it('throws a clear error when the preset id is unregistered', async () => {
    const manifest = makeThemeManifest({ preset: 'not-a-real-preset', mode: 'light' });
    await expect(readThemeFromGguiJson(projectRoot, manifest)).rejects.toThrow(/theme/i);
  });
});

// ─── assertGadgetBundlesReachable ─────────────────────────────────────────────
describe('assertGadgetBundlesReachable', () => {
  it('passes with an empty gadget list', () => {
    expect(() => assertGadgetBundlesReachable([])).not.toThrow();
  });

  it('passes when a gadget has no bundle reference', () => {
    const g = makeGadget('@ggui-ai/gadgets');
    // STDLIB_GADGETS[0] has no bundleHost / bundleUrl
    expect(g.bundleHost).toBeUndefined();
    expect(g.bundleUrl).toBeUndefined();
    expect(() => assertGadgetBundlesReachable([g])).not.toThrow();
  });

  it('passes when bundleHost is a cloud registry hostname', () => {
    const g = makeGadget('@my-org/my-widget', { bundleHost: 'registry.ggui.ai' });
    expect(() => assertGadgetBundlesReachable([g])).not.toThrow();
  });

  it('passes when bundleUrl points to a cloud origin', () => {
    const g = makeGadget('@my-org/my-widget', {
      bundleUrl: 'https://cdn.example.com/widget.js',
    });
    expect(() => assertGadgetBundlesReachable([g])).not.toThrow();
  });

  it('throws when bundleHost is localhost', () => {
    const g = makeGadget('@my-org/my-widget', { bundleHost: 'localhost:3000' });
    expect(() => assertGadgetBundlesReachable([g])).toThrow(
      /local-only.*ggui gadget publish/i,
    );
  });

  it('throws when bundleHost is 127.0.0.1', () => {
    const g = makeGadget('@my-org/my-widget', { bundleHost: '127.0.0.1' });
    expect(() => assertGadgetBundlesReachable([g])).toThrow(/local-only/i);
  });

  it('throws when bundleHost is 0.0.0.0', () => {
    const g = makeGadget('@my-org/my-widget', { bundleHost: '0.0.0.0:8080' });
    expect(() => assertGadgetBundlesReachable([g])).toThrow(/local-only/i);
  });

  it('throws when bundleUrl host is localhost', () => {
    const g = makeGadget('@my-org/my-widget', {
      bundleUrl: 'http://localhost:4000/bundle.js',
    });
    expect(() => assertGadgetBundlesReachable([g])).toThrow(
      /local-only.*ggui gadget publish/i,
    );
  });

  it('throws when bundleUrl host is 127.0.0.1', () => {
    const g = makeGadget('@my-org/my-widget', {
      bundleUrl: 'http://127.0.0.1:5000/bundle.js',
    });
    expect(() => assertGadgetBundlesReachable([g])).toThrow(/local-only/i);
  });

  it('error message includes the gadget package name and remediation hint', () => {
    const g = makeGadget('@my-org/my-widget', { bundleHost: 'localhost:3000' });
    expect(() => assertGadgetBundlesReachable([g])).toThrow(/@my-org\/my-widget/);
  });
});

// ─── runConfigPushStep ────────────────────────────────────────────────────────
describe('runConfigPushStep', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ggui-config-push-test-'));
    mocks.patchAppConfig.mockReset();
    mocks.patchAppConfig.mockResolvedValue({ updated: ['gadgets'] });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns 1 and writes to stderr when ggui.json is not found', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123');
    expect(code).toBe(1);
    expect(stderrSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('calls patchAppConfig with gadgets and exits 0 on success', async () => {
    const descriptor = structuredClone(STDLIB_GADGETS[0]!);
    const gguiJson = { app: { gadgets: [descriptor] } };
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    expect(mocks.patchAppConfig).toHaveBeenCalledOnce();
    const [appId, patch] = mocks.patchAppConfig.mock.calls[0]!;
    expect(appId).toBe('app123');
    expect(patch.gadgets).toHaveLength(1);
    // publicEnv absent → not sent
    expect(patch.publicEnv).toBeUndefined();

    stdoutSpy.mockRestore();
  });

  it('sends publicEnv when present and non-empty', async () => {
    const gguiJson = {
      app: {
        gadgets: [structuredClone(STDLIB_GADGETS[0]!)],
        publicEnv: { GGUI_PUBLIC_APP_TOKEN: 'pk.abc' },
      },
    };
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    const [, patch] = mocks.patchAppConfig.mock.calls[0]!;
    expect(patch.publicEnv).toEqual({ GGUI_PUBLIC_APP_TOKEN: 'pk.abc' });
  });

  it('returns 1 and writes to stderr when a gadget bundle is loopback', async () => {
    const badDescriptor = {
      ...structuredClone(STDLIB_GADGETS[0]!),
      package: '@my-org/my-widget',
      bundleHost: 'localhost:3000',
    };
    const gguiJson = { app: { gadgets: [badDescriptor] } };
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(1);
    expect(stderrSpy.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.patchAppConfig).not.toHaveBeenCalled();
  });

  it('sends empty gadgets array (clears) when no gadgets declared', async () => {
    const gguiJson = { app: {} };
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    const [, patch] = mocks.patchAppConfig.mock.calls[0]!;
    expect(patch.gadgets).toEqual([]);
    expect(patch.publicEnv).toBeUndefined();
  });

  it('includes generation in the PATCH when ggui.json has a generation block', async () => {
    const gguiJson = {
      generation: { model: 'anthropic:claude-haiku-4-5-20251001', keySource: 'own' },
      app: {},
    };
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    const [appId, patch] = mocks.patchAppConfig.mock.calls[0]!;
    expect(appId).toBe('app123');
    expect(patch.generation).toEqual({ model: 'anthropic:claude-haiku-4-5-20251001', keySource: 'own' });
  });

  it('omits generation from the PATCH when ggui.json has no generation block', async () => {
    const gguiJson = { app: {} };
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    const [, patch] = mocks.patchAppConfig.mock.calls[0]!;
    expect(patch.generation).toBeUndefined();
  });

  it('defaults generation.keySource to "managed" when only model is present', async () => {
    const gguiJson = {
      generation: { model: 'openai:gpt-5' },
      app: {},
    };
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    const [, patch] = mocks.patchAppConfig.mock.calls[0]!;
    expect(patch.generation).toEqual({ model: 'openai:gpt-5', keySource: 'managed' });
  });

  it('prints the model in the summary line when generation is pushed', async () => {
    const gguiJson = {
      generation: { model: 'anthropic:claude-haiku-4-5-20251001' },
      app: {},
    };
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('anthropic:claude-haiku-4-5-20251001');
  });

  it('includes the resolved theme in the PATCH when ggui.json has a theme block', async () => {
    const gguiJson = makeThemeManifest({ preset: 'claudic', mode: 'dark' });
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    const [, patch] = mocks.patchAppConfig.mock.calls[0]!;
    expect(patch.theme).toBeDefined();
    expect(patch.theme!.mode).toBe('dark');
    expect(patch.theme!.name).toBe('claudic');
    expect(patch.theme!.overlayHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(patch.theme!.overlays.dark).every((k) => k.startsWith('--ggui-'))).toBe(true);
  });

  it('omits theme from the PATCH when ggui.json has no theme block', async () => {
    const gguiJson = { app: {} };
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    const [, patch] = mocks.patchAppConfig.mock.calls[0]!;
    expect(patch.theme).toBeUndefined();
  });

  it('prints the theme in the summary line when a theme is pushed', async () => {
    const gguiJson = makeThemeManifest({ preset: 'claudic', mode: 'dark' });
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(gguiJson), 'utf-8');

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);

    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('claudic');
  });
});

// ─── #990 — declared faces are not delivered on the hosted path yet ──────────
describe('runConfigPushStep — declared font faces (ggui#990)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ggui-config-push-faces-'));
    mocks.patchAppConfig.mockReset();
    mocks.patchAppConfig.mockResolvedValue({ updated: ['theme'] });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const color = (v: string) => ({ $type: 'color', $value: v });
  const themeDoc = (faces?: readonly { family: string; src: string }[]) => ({
    color: {
      primary: { '500': color('#0ea5e9') },
      success: { '500': color('#16a34a') },
      warning: { '500': color('#f59e0b') },
      error: { '500': color('#dc2626') },
      info: { '500': color('#2563eb') },
      ground: color('#ffffff'),
      onGround: color('#111827'),
      container: color('#ffffff'),
      onContainer: color('#111827'),
      sunken: color('#f3f4f6'),
      onSunken: color('#374151'),
    },
    spacing: { '4': { $type: 'dimension', $value: '16px' } },
    font: {
      family: { sans: { $type: 'fontFamily', $value: 'Acme Sans' } },
      weight: { regular: { $type: 'fontWeight', $value: 400 } },
    },
    shape: {
      radius: { md: { $type: 'dimension', $value: '8px' } },
      shadow: { sm: { $type: 'shadow', $value: '0 1px 2px 0 rgba(0,0,0,.05)' } },
    },
    ...(faces !== undefined ? { typography: { faces } } : {}),
  });

  it('prints ONE warning naming each declared family as not delivered on the hosted path, pointing at #990', async () => {
    writeFileSync(
      join(dir, 'theme.json'),
      JSON.stringify(
        themeDoc([
          { family: 'Acme Sans', src: 'https://fonts.acme.example/sans.woff2' },
          { family: 'Acme Sans', src: 'https://fonts.acme.example/sans-bold.woff2' },
          { family: 'Acme Mono', src: 'https://fonts.acme.example/mono.woff2' },
        ]),
      ),
    );
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(makeThemeManifest({ file: './theme.json', mode: 'light' })));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runConfigPushStep('app123', dir);
    expect(code).toBe(0);
    const lines = stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('#990'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Acme Sans');
    expect(lines[0]).toContain('Acme Mono');
    expect(lines[0]).toMatch(/fallback/i);
    expect(lines[0]).toMatch(/not delivered/i);
    // The projection still ships.
    const [, patch] = mocks.patchAppConfig.mock.calls[0]!;
    expect(patch.theme).toBeDefined();
  });

  it('prints no such warning when the document declares no faces', async () => {
    writeFileSync(join(dir, 'theme.json'), JSON.stringify(themeDoc()));
    writeFileSync(join(dir, 'ggui.json'), JSON.stringify(makeThemeManifest({ file: './theme.json', mode: 'light' })));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runConfigPushStep('app123', dir)).toBe(0);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).some((l) => l.includes('#990'))).toBe(false);
  });
});
