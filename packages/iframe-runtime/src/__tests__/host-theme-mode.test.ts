/**
 * Host-announced theme mode as the `themeMode` fallback (ggui#551,
 * rnd/gen-ui/beauty/experiments/002-host-theme-adaptation.md).
 *
 * `hostContext.theme` alone reaches only `data-theme` + `color-scheme`
 * (ext-apps `applyDocumentTheme`); nothing in the token pipeline keys
 * off it, so a dark host painted the LIGHT ladder — probe `cc728a8eb`
 * measured host-fit 46.0 vs 87.7 once the dark ladder is selected.
 * `buildOpts` (runtime.ts, closure-local to `bootSequence`) now reads
 * `meta.themeMode ?? hostAnnouncedThemeMode()`. This spec pins the
 * input half through the same App-injection seam `dispatch-routing`
 * uses (`buildBootHarness` + `setCurrentApp`), and the precedence
 * contract agreed with the read-door parity work (#539): the SLICE's
 * stamped mode always wins; the host fills only an ABSENT mode.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import {
  __resetAppForTest,
  hostAnnouncedThemeMode,
  resolveMountThemeMode,
  setCurrentApp,
} from '../runtime.js';
import { buildBootHarness, buildHappyInitResult, DEFAULT_HOST_CONTEXT } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

async function connectWithHostContext(
  hostContext: Record<string, unknown>,
): Promise<{ app: App; transport: MockTransport }> {
  const harness = buildBootHarness({
    initResponse: buildHappyInitResult({ hostContext }),
  });
  await harness.app.connect(harness.transport);
  setCurrentApp(harness.app);
  return { app: harness.app, transport: harness.transport };
}

describe('hostAnnouncedThemeMode — the #551 input leg', () => {
  beforeEach(() => {
    __resetAppForTest();
  });
  afterEach(() => {
    __resetAppForTest();
  });

  it('is undefined before any App is connected (static boot paths never guess a mode)', () => {
    expect(hostAnnouncedThemeMode()).toBeUndefined();
  });

  it("returns 'dark' when the host's ui/initialize hostContext announces theme:'dark'", async () => {
    await connectWithHostContext({ ...DEFAULT_HOST_CONTEXT, theme: 'dark' });
    expect(hostAnnouncedThemeMode()).toBe('dark');
  });

  it("returns 'light' when the host announces theme:'light'", async () => {
    await connectWithHostContext({ ...DEFAULT_HOST_CONTEXT, theme: 'light' });
    expect(hostAnnouncedThemeMode()).toBe('light');
  });

  it('is undefined when the host sends no theme (ggui embed host, wire-scenarios host)', async () => {
    await connectWithHostContext({ ...DEFAULT_HOST_CONTEXT });
    expect(hostAnnouncedThemeMode()).toBeUndefined();
  });

  it("a non-spec theme string ('auto') never reaches the fallback — ext-apps rejects it at the wire", async () => {
    // Finding worth pinning: `App.connect` zod-validates the initialize
    // result against the spec's CLOSED `'light' | 'dark'` union, so a
    // host sending 'auto' / 'high-contrast' fails the HANDSHAKE — the
    // literal guard inside `hostAnnouncedThemeMode` is defense in depth
    // for a raw-context path, not the primary filter. The mount dying
    // here (UI_INITIALIZE_FAILED) is the same behavior every ggui
    // runtime already has for a malformed host; nothing about #551
    // changes it.
    const harness = buildBootHarness({
      initResponse: buildHappyInitResult({
        hostContext: { ...DEFAULT_HOST_CONTEXT, theme: 'auto' },
      }),
    });
    await expect(harness.app.connect(harness.transport)).rejects.toThrow();
    expect(hostAnnouncedThemeMode()).toBeUndefined();
  });

  it('follows a post-boot host-context-changed theme flip (App pre-merges hostContext)', async () => {
    const { transport } = await connectWithHostContext({ ...DEFAULT_HOST_CONTEXT, theme: 'light' });
    expect(hostAnnouncedThemeMode()).toBe('light');
    transport.pushNotification({
      method: 'ui/notifications/host-context-changed',
      params: { theme: 'dark' },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hostAnnouncedThemeMode()).toBe('dark');
  });

  it('#589: the slice theme OBJECT is part of the slice — its mode sits between the stamped mode and the host announce', async () => {
    // The store-frame rejection (ggui#589 / guuey#318): an envelope
    // carrying `theme: {mode:'dark', cssVariables:{…}}` but NO
    // top-level `themeMode`, mounted under a host that (correctly,
    // per the adapter-boundary doctrine) announces no hostContext
    // theme. The old ladder (`themeMode ?? hostAnnounced()`) resolved
    // undefined → the base stylesheet painted the FULL LIGHT token
    // set under the 12 dark brand vars — a light skeleton in a dark
    // skin. The theme object's mode is slice-stamped material and
    // MUST be consulted before falling through to the host.
    await connectWithHostContext({ ...DEFAULT_HOST_CONTEXT }); // host silent
    expect(
      resolveMountThemeMode({
        theme: { mode: 'dark', cssVariables: { '--ggui-color-surface': '#111' } },
      }),
    ).toBe('dark');
  });

  it('#589 full ladder: stamped top-level > theme-object mode > host announce > undefined', async () => {
    await connectWithHostContext({ ...DEFAULT_HOST_CONTEXT, theme: 'dark' }); // host says dark
    // Stamped top-level wins over everything.
    expect(
      resolveMountThemeMode({
        themeMode: 'light',
        theme: { mode: 'dark', cssVariables: {} },
      }),
    ).toBe('light');
    // Theme-object mode beats the host announce.
    expect(
      resolveMountThemeMode({ theme: { mode: 'light', cssVariables: {} } }),
    ).toBe('light');
    // No slice opinion at all → host fills (the #551 leg, unchanged).
    expect(resolveMountThemeMode({})).toBe('dark');
    // Nothing anywhere → undefined (absent ≠ light).
    __resetAppForTest();
    expect(resolveMountThemeMode({})).toBeUndefined();
  });

  it('precedence contract: the slice-stamped mode wins; the host fills only an ABSENT mode', async () => {
    // This is exactly the expression `buildOpts` evaluates
    // (`meta.themeMode ?? hostAnnouncedThemeMode()`); pinning it here
    // as a value-level contract keeps the read-door parity work (#539)
    // and this fallback from ever disagreeing about who wins.
    await connectWithHostContext({ ...DEFAULT_HOST_CONTEXT, theme: 'dark' });
    const resolve = (sliceThemeMode: 'light' | 'dark' | undefined) =>
      sliceThemeMode ?? hostAnnouncedThemeMode();
    expect(resolve('light')).toBe('light'); // operator layer stamped light → light, host dark ignored
    expect(resolve('dark')).toBe('dark');
    expect(resolve(undefined)).toBe('dark'); // no operator opinion → host's dark
  });
});
