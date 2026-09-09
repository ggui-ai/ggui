/**
 * Browser selection for the visual judge's screenshot — pinned WITHOUT
 * launching anything: `PUPPETEER_EXECUTABLE_PATH` (a system Chromium —
 * the bench runner image, a dev box) wins and never loads
 * `@sparticuz/chromium`; absent, the bundled Chromium supplies binary +
 * flags as before. The launcher is injected so `captureScreenshot`'s
 * whole path (options → launch → page → PNG → close) runs against a
 * recorded fake.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import {
  EXECUTABLE_PATH_LAUNCH_ARGS,
  captureScreenshot,
  resolveLaunchOptions,
  type ScreenshotBrowser,
  type ScreenshotPage,
} from './visual-evaluator.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function fakeBrowser(closed: { count: number }): ScreenshotBrowser {
  const page: ScreenshotPage = {
    setContent: async () => {},
    waitForNetworkIdle: async () => {},
    waitForSelector: async () => null,
    screenshot: async () => new Uint8Array(PNG),
  };
  return {
    newPage: async () => page,
    close: async () => {
      closed.count += 1;
    },
  };
}

describe('resolveLaunchOptions — PUPPETEER_EXECUTABLE_PATH vs @sparticuz/chromium', () => {
  it('env override: launches that binary with --no-sandbox + --disable-dev-shm-usage and never loads @sparticuz/chromium', async () => {
    const loadChromium = vi.fn(async () => {
      throw new Error('must not load @sparticuz/chromium when the override is set');
    });
    const opts = await resolveLaunchOptions(
      { width: 400, height: 640 },
      { env: { PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium' }, loadChromium },
    );
    expect(opts.executablePath).toBe('/usr/bin/chromium');
    expect(opts.args).toEqual(['--no-sandbox', '--disable-dev-shm-usage']);
    expect(opts.args).toEqual([...EXECUTABLE_PATH_LAUNCH_ARGS]);
    expect(opts.headless).toBe(true);
    expect(opts.defaultViewport).toEqual({ width: 400, height: 640 });
    expect(loadChromium).not.toHaveBeenCalled();
  });

  it('no override (unset OR blank): the bundled Chromium supplies binary + args', async () => {
    const loadChromium = vi.fn(async () => ({
      args: ['--sparticuz-flag'],
      executablePath: async () => '/tmp/sparticuz/chromium',
    }));
    for (const env of [{}, { PUPPETEER_EXECUTABLE_PATH: '   ' }]) {
      const opts = await resolveLaunchOptions({ width: 1280, height: 800 }, { env, loadChromium });
      expect(opts.executablePath).toBe('/tmp/sparticuz/chromium');
      expect(opts.args).toEqual(['--sparticuz-flag']);
      expect(opts.headless).toBe(true);
    }
    expect(loadChromium).toHaveBeenCalledTimes(2);
  });
});

describe('captureScreenshot — injected launcher', () => {
  it('launches with the resolved options, returns the PNG as a Buffer and closes the browser', async () => {
    const launched: LaunchOptions[] = [];
    const closed = { count: 0 };
    const png = await captureScreenshot(
      '<html><body><div id="root"><p>hi</p></div></body></html>',
      { width: 390, height: 844 },
      {
        env: { PUPPETEER_EXECUTABLE_PATH: '/opt/chrome' },
        launch: async (o) => {
          launched.push(o);
          return fakeBrowser(closed);
        },
        settleMs: 0,
      },
    );
    expect(png).toBeInstanceOf(Buffer);
    expect(png?.equals(PNG)).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.executablePath).toBe('/opt/chrome');
    expect(launched[0]?.args).toEqual(['--no-sandbox', '--disable-dev-shm-usage']);
    expect(launched[0]?.defaultViewport).toEqual({ width: 390, height: 844 });
    expect(closed.count).toBe(1);
  });

  it('a launch failure yields null (no browser → the visual leg is skipped), never a throw', async () => {
    const png = await captureScreenshot('<html></html>', undefined, {
      env: { PUPPETEER_EXECUTABLE_PATH: '/nope' },
      launch: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(png).toBeNull();
  });
});
