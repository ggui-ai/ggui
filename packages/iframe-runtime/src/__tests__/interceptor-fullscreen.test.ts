/**
 * Slice 3 (2026-05-07) — native-idiom Fullscreen API interceptors.
 *
 * `Element.prototype.requestFullscreen` and
 * `Document.prototype.exitFullscreen` are overridden to route through
 * {@link requestDisplayModeInParent}. Generated components calling
 * `el.requestFullscreen()` / `document.exitFullscreen()` get a raw-
 * postMessage audit envelope + the spec-canonical
 * `ui/request-display-mode` request via `app.requestDisplayMode(...)`
 * (post-Phase-1.19b.3 followup #275).
 *
 * Both overrides return `Promise.resolve()` so callers using `.then()`
 * / `await` don't break. The native call is NOT delegated — there's
 * no useful behavior to preserve and a real fullscreen attempt would
 * race with the host's handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import {
  __resetAppForTest,
  __resetInterceptorsForTest,
  installFullscreenInterceptors,
  setCurrentApp,
} from '../runtime.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

let postMessageSpy: ReturnType<typeof vi.fn>;
let originalPostMessage: typeof window.parent.postMessage;
let originalRequestFullscreen: typeof Element.prototype.requestFullscreen;
let originalExitFullscreen: typeof Document.prototype.exitFullscreen;
let transport: MockTransport;
let app: App;

const baseArgs = {
  dispatchToolName: 'ggui_runtime_submit_action',
  renderId: 'render_1',
  appId: 'app_1',
} as const;

/**
 * Helper — return every `ui/request-display-mode` request observed
 * on the App transport (the spec-canonical destination post-#275).
 */
function requestDisplayModeRequests(): Array<Record<string, unknown>> {
  return transport.sent
    .filter(
      (msg) =>
        (msg as { method?: unknown }).method === 'ui/request-display-mode',
    )
    .map((msg) => msg as Record<string, unknown>);
}

beforeEach(async () => {
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

  const harness = buildBootHarness();
  transport = harness.transport;
  app = harness.app;
  await app.connect(transport);
  setCurrentApp(app);
});

afterEach(() => {
  Object.defineProperty(window.parent, 'postMessage', {
    value: originalPostMessage,
    configurable: true,
    writable: true,
  });
  Element.prototype.requestFullscreen = originalRequestFullscreen;
  Document.prototype.exitFullscreen = originalExitFullscreen;
  __resetAppForTest();
});

describe('installFullscreenInterceptors', () => {
  it('overrides Element.prototype.requestFullscreen to fire audit + ui/request-display-mode', async () => {
    installFullscreenInterceptors(baseArgs);
    const div = document.createElement('div');
    document.body.appendChild(div);

    const result = div.requestFullscreen();

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();

    // Audit fires synchronously via raw postMessage.
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const audit = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect((audit.params as Record<string, unknown>).name).toBe(
      'ggui_runtime_submit_action',
    );
    expect(
      ((audit.params as Record<string, unknown>).arguments as Record<string, unknown>)
        .kind,
    ).toBe('requestDisplayMode');

    // ui/request-display-mode routes through the App transport.
    await tick();
    const reqs = requestDisplayModeRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.params).toEqual({ mode: 'fullscreen' });

    document.body.removeChild(div);
  });

  it('overrides Document.prototype.exitFullscreen to fire mode: "inline"', async () => {
    installFullscreenInterceptors(baseArgs);

    const result = document.exitFullscreen();

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    await tick();
    const reqs = requestDisplayModeRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.params).toEqual({ mode: 'inline' });
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

    // Audit fires exactly once (raw postMessage) and the
    // ui/request-display-mode request fires exactly once (App
    // transport) — not three of each.
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    await tick();
    expect(requestDisplayModeRequests()).toHaveLength(1);

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
