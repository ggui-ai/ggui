/**
 * Slice 3 (2026-05-07) — native-idiom Fullscreen API interceptors.
 *
 * `Element.prototype.requestFullscreen` and
 * `Document.prototype.exitFullscreen` are overridden to route through
 * {@link requestDisplayModeInParent}. Generated components calling
 * `el.requestFullscreen()` / `document.exitFullscreen()` get a full
 * audit envelope + `ui/request-display-mode` postMessage to the host.
 *
 * Both overrides return `Promise.resolve()` so callers using `.then()`
 * / `await` don't break. The native call is NOT delegated — there's
 * no useful behavior to preserve and a real fullscreen attempt would
 * race with the host's handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetInterceptorsForTest,
  installFullscreenInterceptors,
} from '../runtime.js';

let postMessageSpy: ReturnType<typeof vi.fn>;
let originalPostMessage: typeof window.parent.postMessage;
let originalRequestFullscreen: typeof Element.prototype.requestFullscreen;
let originalExitFullscreen: typeof Document.prototype.exitFullscreen;

const baseArgs = {
  dispatchToolName: 'ggui_runtime_submit_action',
  renderId: 'render_1',
  appId: 'app_1',
} as const;

beforeEach(() => {
  postMessageSpy = vi.fn();
  originalPostMessage = window.parent.postMessage;
  Object.defineProperty(window.parent, 'postMessage', {
    value: postMessageSpy,
    configurable: true,
    writable: true,
  });
  // Snapshot the prototype methods so the override can be restored
  // between tests (jsdom shares one Element/Document prototype across
  // the whole test run; un-shimmed state keeps subsequent specs
  // honest).
  originalRequestFullscreen = Element.prototype.requestFullscreen;
  originalExitFullscreen = Document.prototype.exitFullscreen;
  __resetInterceptorsForTest();
});

afterEach(() => {
  Object.defineProperty(window.parent, 'postMessage', {
    value: originalPostMessage,
    configurable: true,
    writable: true,
  });
  Element.prototype.requestFullscreen = originalRequestFullscreen;
  Document.prototype.exitFullscreen = originalExitFullscreen;
});

describe('installFullscreenInterceptors', () => {
  it('overrides Element.prototype.requestFullscreen to fire audit + ui/request-display-mode', async () => {
    installFullscreenInterceptors(baseArgs);
    const div = document.createElement('div');
    document.body.appendChild(div);

    const result = div.requestFullscreen();

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();

    expect(postMessageSpy).toHaveBeenCalledTimes(2);
    const audit = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    const reqMode = postMessageSpy.mock.calls[1][0] as Record<string, unknown>;
    expect((audit.params as Record<string, unknown>).name).toBe(
      'ggui_runtime_submit_action',
    );
    expect(
      ((audit.params as Record<string, unknown>).arguments as Record<string, unknown>)
        .kind,
    ).toBe('requestDisplayMode');
    expect(reqMode.method).toBe('ui/request-display-mode');
    expect(reqMode.params).toEqual({ mode: 'fullscreen' });

    document.body.removeChild(div);
  });

  it('overrides Document.prototype.exitFullscreen to fire mode: "inline"', async () => {
    installFullscreenInterceptors(baseArgs);

    const result = document.exitFullscreen();

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();

    expect(postMessageSpy).toHaveBeenCalledTimes(2);
    const reqMode = postMessageSpy.mock.calls[1][0] as Record<string, unknown>;
    expect(reqMode.method).toBe('ui/request-display-mode');
    expect(reqMode.params).toEqual({ mode: 'inline' });
  });

  it('does not throw on accidental options argument', () => {
    installFullscreenInterceptors(baseArgs);
    const div = document.createElement('div');
    document.body.appendChild(div);

    expect(() =>
      div.requestFullscreen({ navigationUI: 'show' } as FullscreenOptions),
    ).not.toThrow();

    document.body.removeChild(div);
  });

  it('is idempotent — calling install twice does not chain wrappers', async () => {
    installFullscreenInterceptors(baseArgs);
    installFullscreenInterceptors(baseArgs);
    installFullscreenInterceptors(baseArgs);

    const div = document.createElement('div');
    document.body.appendChild(div);

    await div.requestFullscreen();

    // Exactly 2 envelopes (audit + ui/request-display-mode), not 6.
    expect(postMessageSpy).toHaveBeenCalledTimes(2);

    document.body.removeChild(div);
  });

  it('callers using .then() / await do not break', async () => {
    installFullscreenInterceptors(baseArgs);
    const div = document.createElement('div');
    document.body.appendChild(div);

    let thenFired = false;
    await div.requestFullscreen().then(() => {
      thenFired = true;
    });
    expect(thenFired).toBe(true);

    document.body.removeChild(div);
  });
});
