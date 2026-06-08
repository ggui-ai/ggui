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
} from '@ggui-ai/protocol';

// ─── hoisted mocks ────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  patchAppConfig: vi.fn<
    (appId: string, patch: { gadgets?: GadgetDescriptor[]; publicEnv?: Record<string, string> }) => Promise<{ updated: string[] }>
  >(),
}));

vi.mock('./api-client.js', () => ({
  patchAppConfig: mocks.patchAppConfig,
}));

// Import AFTER vi.mock so the mock is in place.
import {
  readGadgetsFromGguiJson,
  readPublicEnvFromGguiJson,
  assertGadgetBundlesReachable,
  runConfigPushStep,
} from './config-push.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid GadgetDescriptor for test fixtures. */
function makeGadget(pkg: string, overrides: Partial<GadgetDescriptor> = {}): GadgetDescriptor {
  return {
    ...structuredClone(STDLIB_GADGETS[0]!),
    package: pkg,
    ...overrides,
  };
}

// ─── readGadgetsFromGguiJson ──────────────────────────────────────────────────
describe('readGadgetsFromGguiJson', () => {
  it('returns [] when app.gadgets is absent', () => {
    expect(readGadgetsFromGguiJson({})).toEqual([]);
    expect(readGadgetsFromGguiJson({ app: {} })).toEqual([]);
  });

  it('returns typed array when app.gadgets is valid', () => {
    const descriptor = structuredClone(STDLIB_GADGETS[0]!);
    const input = { app: { gadgets: [descriptor] } };
    const result = readGadgetsFromGguiJson(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.package).toBe(descriptor.package);
    expect(result[0]!.version).toBe(descriptor.version);
  });

  it('throws a clear Error when a gadget descriptor is malformed', () => {
    const bad = { app: { gadgets: [{ package: 'not-a-valid-npm-name!' }] } };
    expect(() => readGadgetsFromGguiJson(bad)).toThrow();
  });

  it('throws when app.gadgets is not an array', () => {
    const bad = { app: { gadgets: 'not-an-array' } };
    expect(() => readGadgetsFromGguiJson(bad)).toThrow();
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
});
