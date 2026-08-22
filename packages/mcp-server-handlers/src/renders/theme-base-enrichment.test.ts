/**
 * withResolvedThemeBase (ggui#598-C delivery emission) — the async
 * view-enrichment step every emitting door awaits BEFORE the ONE sync
 * spread: a session theme whose name resolves in the app's ThemeStore
 * gets its registered ladder delivered on `theme.base`.
 */
import { describe, expect, it } from 'vitest';
import type { RenderMetaView } from './slice-meta-derivation.js';
import { withResolvedThemeBase } from './slice-meta-derivation.js';

const BASE = {
  documentHash: 'c'.repeat(64),
  light: { '--ggui-color-surface': '#ffffff' },
  dark: { '--ggui-color-surface': '#101216' },
};

const themedView: RenderMetaView = {
  theme: { name: 'acme-brand-v1', mode: 'dark', cssVariables: {} },
};

describe('withResolvedThemeBase', () => {
  it('resolves a named theme through the provider and merges base', async () => {
    const calls: Array<[string, string]> = [];
    const out = await withResolvedThemeBase(themedView, {
      themeBaseProvider: async (appId, name) => {
        calls.push([appId, name]);
        return BASE;
      },
    }, 'app-1');
    expect(calls).toEqual([['app-1', 'acme-brand-v1']]);
    expect(out.theme?.base).toEqual(BASE);
    // Original fields intact; input view not mutated.
    expect(out.theme?.mode).toBe('dark');
    expect(themedView.theme?.base).toBeUndefined();
  });

  it('a name resolving nowhere leaves the view untouched (static preset / decorative name)', async () => {
    const out = await withResolvedThemeBase(themedView, {
      themeBaseProvider: async () => null,
    }, 'app-1');
    expect(out).toBe(themedView);
  });

  it('no provider bound → identity, zero calls (OSS default without a store)', async () => {
    const out = await withResolvedThemeBase(themedView, {}, 'app-1');
    expect(out).toBe(themedView);
  });

  it('no theme name → identity (overlay-only and theme-less views)', async () => {
    const bare: RenderMetaView = { theme: { mode: 'light', cssVariables: {} } };
    const out = await withResolvedThemeBase(bare, {
      themeBaseProvider: async () => BASE,
    }, 'app-1');
    expect(out).toBe(bare);
  });

  it('an already-present base is never re-resolved (idempotent across doors)', async () => {
    const preResolved: RenderMetaView = {
      theme: { name: 'acme-brand-v1', mode: 'dark', cssVariables: {}, base: BASE },
    };
    let called = 0;
    const out = await withResolvedThemeBase(preResolved, {
      themeBaseProvider: async () => {
        called += 1;
        return BASE;
      },
    }, 'app-1');
    expect(called).toBe(0);
    expect(out).toBe(preResolved);
  });

  it('provider failure THROWS — loud beats silently-wrong-brand (#595 lesson); fail-open is the wrapper\'s choice, never the default', async () => {
    await expect(
      withResolvedThemeBase(themedView, {
        themeBaseProvider: async () => {
          throw new Error('store unavailable');
        },
      }, 'app-1'),
    ).rejects.toThrow('store unavailable');
  });
});
