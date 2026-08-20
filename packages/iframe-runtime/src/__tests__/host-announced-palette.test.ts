/**
 * Host-announced palette as the scoped-block fallback layer — the
 * runtime input leg of ggui#572 (mirrors host-theme-mode.test.ts,
 * the #551 mode analog).
 *
 * `hostContext.styles.variables` alone reaches only inline `--color-*`
 * custom properties on `<html>` (ext-apps `applyHostStyleVariables`);
 * ggui UI consumes exclusively `--ggui-*`, and the scoped in-body
 * token block shadows anything inherited from the root anyway
 * (beauty/001 F2+F3) — so a host palette repainted NOTHING before this
 * bridge. `buildOpts` (runtime.ts, closure-local to `bootSequence`)
 * now threads `hostAnnouncedPalette()` onto the mount options; the
 * renderer merges it beneath the slice's own theme per the #573
 * ruling (slice wins, host fallback).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import { __resetAppForTest, hostAnnouncedPalette, setCurrentApp } from '../runtime.js';
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

describe('hostAnnouncedPalette — the ggui#572 input leg', () => {
  beforeEach(() => {
    __resetAppForTest();
  });
  afterEach(() => {
    __resetAppForTest();
  });

  it('is undefined before any App is connected (static boot paths never guess a palette)', () => {
    expect(hostAnnouncedPalette()).toBeUndefined();
  });

  it('returns the MAPPED ggui vars when ui/initialize hostContext carries styles.variables', async () => {
    await connectWithHostContext({
      ...DEFAULT_HOST_CONTEXT,
      styles: {
        variables: {
          '--color-background-primary': '#101014',
          '--color-text-primary': '#f4f4f5',
        },
      },
    });
    expect(hostAnnouncedPalette()).toEqual({
      '--ggui-color-surface': '#101014',
      '--ggui-color-onSurface': '#f4f4f5',
    });
  });

  it('is undefined when the host sends no styles (ggui embed host, wire-scenarios host)', async () => {
    await connectWithHostContext({ ...DEFAULT_HOST_CONTEXT });
    expect(hostAnnouncedPalette()).toBeUndefined();
  });

  it('follows a post-boot host-context-changed styles update (App pre-merges hostContext)', async () => {
    const { transport } = await connectWithHostContext({
      ...DEFAULT_HOST_CONTEXT,
      styles: { variables: { '--color-background-primary': '#ffffff' } },
    });
    expect(hostAnnouncedPalette()).toEqual({ '--ggui-color-surface': '#ffffff' });
    transport.pushNotification({
      method: 'ui/notifications/host-context-changed',
      params: {
        styles: { variables: { '--color-background-primary': '#101014' } },
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hostAnnouncedPalette()).toEqual({ '--ggui-color-surface': '#101014' });
  });
});
