/**
 * `ggui_ops_set_app_theme` — the MCP write door for the per-app theme
 * (ggui#987 §3.4). The door validates SHAPE (protocol's v2
 * `appThemeSchema`), ATTESTATION (`overlayHash` recomputed), and
 * COVERAGE (the injected overlay validator — both modes); a refusal is
 * a schema-conformant `{ ok: false, code: 'invalid_app_config', refusal }`
 * result whose body is one of the four the protocol names, so every
 * write door (REST, AppSync, this one) says the same thing.
 */
import { describe, expect, it, vi } from 'vitest';
import { canonicalOverlayHash, type AppTheme } from '@ggui-ai/protocol';
import { isHandlerFailure, type HandlerContext } from '../types.js';
import { AppNotFoundError } from './types.js';
import { createSetAppThemeHandler, type OverlayCoverageValidator } from './set-app-theme.js';
import { InMemoryAppsSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

/** A coverage validator that accepts everything — the unit under test is the door, not design's report. */
const acceptAll: OverlayCoverageValidator = () => ({ uncovered: [], unknown: [], warnings: [] });

const OVERLAYS = {
  light: { '--ggui-color-ground': '#ffffff', '--ggui-color-onGround': '#111827' },
  dark: { '--ggui-color-ground': '#111827', '--ggui-color-onGround': '#f9fafb' },
};

async function validTheme(): Promise<AppTheme> {
  return {
    overlayHash: await canonicalOverlayHash({ overlays: OVERLAYS }),
    overlays: OVERLAYS,
    mode: 'dark',
    name: 'midnight',
  };
}

async function seeded() {
  const apps = new InMemoryAppsSource();
  const created = await apps.create({ ownerSub: 'user-1' });
  const handler = createSetAppThemeHandler({ apps, overlayCoverage: acceptAll });
  return { apps, appId: created.appId, handler };
}

describe('createSetAppThemeHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createSetAppThemeHandler({ apps: new InMemoryAppsSource(), overlayCoverage: acceptAll });
    expect(handler.name).toBe('ggui_ops_set_app_theme');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createSetAppThemeHandler — happy path', () => {
  it('persists a v2 theme with a matching attestation and echoes it back under ok: true', async () => {
    const { apps, appId, handler } = await seeded();
    const theme = await validTheme();
    const result = await handler.handler({ appId, theme }, makeCtx());
    expect(isHandlerFailure(result)).toBe(false);
    if (isHandlerFailure(result)) throw new Error('unreachable');
    expect(result.ok).toBe(true);
    expect(result.appId).toBe(appId);
    expect(result.theme).toEqual(theme);
    expect(result.updatedAt?.length).toBeGreaterThan(0);
    expect(apps.getTheme(appId)).toEqual(theme);
  });
});

describe('createSetAppThemeHandler — the four refusal bodies (ggui#987 §3.4)', () => {
  it("a v1 one-palette body is refused as { refused: 'v1 shape' } and nothing is persisted", async () => {
    const { apps, appId, handler } = await seeded();
    const result = await handler.handler(
      { appId, theme: { mode: 'dark', cssVariables: { '--ggui-color-ground': '#111827' }, name: 'old' } },
      makeCtx(),
    );
    expect(isHandlerFailure(result)).toBe(true);
    if (!isHandlerFailure(result)) throw new Error('unreachable');
    expect(result.data).toEqual({ ok: false, code: 'invalid_app_config', refusal: { refused: 'v1 shape' } });
    expect(result.errorText).toContain('invalid_app_config');
    expect(apps.getTheme(appId)).toBeUndefined();
  });

  it("a stale attestation is refused as { overlayHash: 'mismatch' }", async () => {
    const { apps, appId, handler } = await seeded();
    const theme = { ...(await validTheme()), overlayHash: 'ab'.repeat(32) };
    const result = await handler.handler({ appId, theme }, makeCtx());
    if (!isHandlerFailure(result)) throw new Error('expected a refusal');
    expect(result.data).toEqual({ ok: false, code: 'invalid_app_config', refusal: { overlayHash: 'mismatch' } });
    expect(apps.getTheme(appId)).toBeUndefined();
  });

  it('a gap the validator reports is refused as { uncovered: { light, dark } } — both modes, each on its own', async () => {
    const apps = new InMemoryAppsSource();
    const { appId } = await apps.create({ ownerSub: 'user-1' });
    const handler = createSetAppThemeHandler({
      apps,
      overlayCoverage: (overlay) => ({
        uncovered: overlay['--ggui-color-ground'] === '#ffffff' ? ['--ggui-color-sunken'] : [],
        unknown: [],
        warnings: [],
      }),
    });
    const result = await handler.handler({ appId, theme: await validTheme() }, makeCtx());
    if (!isHandlerFailure(result)) throw new Error('expected a refusal');
    expect(result.data).toEqual({
      ok: false,
      code: 'invalid_app_config',
      refusal: { uncovered: { light: ['--ggui-color-sunken'], dark: [] } },
    });
    expect(apps.getTheme(appId)).toBeUndefined();
  });

  // ggui#1286 (N−1, new → old): a key outside this door's manifest may be a name a NEWER projector
  // emits. The door admits it, persists it verbatim and names it — never refuses, never drops.
  it('ggui#1286: a --ggui-* key outside the manifest is ADMITTED, persisted verbatim and named once', async () => {
    const apps = new InMemoryAppsSource();
    const { appId } = await apps.create({ ownerSub: 'user-1' });
    const handler = createSetAppThemeHandler({
      apps,
      // The unit under test is the door, not design's report: the stub reports the key as unknown.
      overlayCoverage: () => ({ uncovered: [], unknown: ['--ggui-n1-future-probe'], warnings: [] }),
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const theme = await validTheme();
    const result = await handler.handler({ appId, theme }, makeCtx());
    expect(isHandlerFailure(result)).toBe(false);
    expect(apps.getTheme(appId)).toEqual(theme);
    const named = info.mock.calls.filter((c) => String(c[0]).includes('app_theme_unknown_overlay_names'));
    expect(named).toHaveLength(1);
    expect(named[0]![1]).toEqual({ appId, light: ['--ggui-n1-future-probe'], dark: ['--ggui-n1-future-probe'] });
    info.mockRestore();
  });

  it('ggui#1286: unknown AND uncovered is refused as { uncovered } — coverage is the one name check that refuses', async () => {
    const apps = new InMemoryAppsSource();
    const { appId } = await apps.create({ ownerSub: 'user-1' });
    const handler = createSetAppThemeHandler({
      apps,
      overlayCoverage: () => ({ uncovered: ['--ggui-color-sunken'], unknown: ['--ggui-n1-future-probe'], warnings: [] }),
    });
    const result = await handler.handler({ appId, theme: await validTheme() }, makeCtx());
    if (!isHandlerFailure(result)) throw new Error('expected a refusal');
    expect(result.data).toEqual({
      ok: false,
      code: 'invalid_app_config',
      refusal: { uncovered: { light: ['--ggui-color-sunken'], dark: ['--ggui-color-sunken'] } },
    });
  });

  it('shape refusals stay refusals: a non-`--ggui-*` key, a breakout value, an unknown top-level key', async () => {
    const { apps, appId, handler } = await seeded();
    const base = await validTheme();
    for (const theme of [
      { ...base, overlays: { ...OVERLAYS, light: { ...OVERLAYS.light, '--evil-var': 'red' } } },
      { ...base, overlays: { ...OVERLAYS, dark: { ...OVERLAYS.dark, '--ggui-color-ground': 'red; } body {' } } },
      { ...base, sneaky: true },
    ]) {
      const result = await handler.handler({ appId, theme }, makeCtx());
      expect(isHandlerFailure(result), JSON.stringify(theme)).toBe(true);
      if (!isHandlerFailure(result)) throw new Error('unreachable');
      expect(result.data.ok).toBe(false);
      expect(result.data.code).toBe('invalid_app_config');
    }
    expect(apps.getTheme(appId)).toBeUndefined();
  });
});

describe('createSetAppThemeHandler — not found + tenancy', () => {
  it('throws AppNotFoundError when the id is unknown', async () => {
    const handler = createSetAppThemeHandler({ apps: new InMemoryAppsSource(), overlayCoverage: acceptAll });
    await expect(
      handler.handler({ appId: 'nope', theme: await validTheme() }, makeCtx()),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('rejects cross-user writes with the uniform AppNotFoundError', async () => {
    const apps = new InMemoryAppsSource();
    const created = await apps.create({ ownerSub: 'user-1' });
    const handler = createSetAppThemeHandler({ apps, overlayCoverage: acceptAll });
    await expect(
      handler.handler(
        { appId: created.appId, theme: await validTheme() },
        makeCtx({ appId: 'user-2', userId: 'user-2' }),
      ),
    ).rejects.toBeInstanceOf(AppNotFoundError);
    expect(apps.getTheme(created.appId)).toBeUndefined();
  });

  it('throws on empty identity', async () => {
    const handler = createSetAppThemeHandler({ apps: new InMemoryAppsSource(), overlayCoverage: acceptAll });
    await expect(
      handler.handler({ appId: 'x', theme: await validTheme() }, makeCtx({ appId: '', userId: '' })),
    ).rejects.toThrow();
  });
});
