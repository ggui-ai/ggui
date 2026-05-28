/**
 * Slice 3 (2026-05-07) — capture-phase anchor click interceptor.
 *
 * Generated components can use plain `<a href>` and the runtime traps
 * the click in the capture phase, routing through
 * {@link openLinkInParent} (raw-postMessage audit envelope + the
 * spec-canonical `ui/open-link` request via `app.openLink(...)`
 * post-Phase-1.19b.3 followup #275). This file pins the decision
 * rules:
 *
 *   - External http(s) cross-origin → INTERCEPT
 *   - http(s) same-origin with target="_blank" → INTERCEPT
 *   - Same-origin without target="_blank" → DON'T (in-frame nav)
 *   - `#fragment` → DON'T (same-document scroll)
 *   - `mailto:` / `tel:` / `javascript:` / `data:` → DON'T
 *   - Click on element nested inside `<a>` → resolves via `closest()`
 *   - Idempotent: install twice → one listener, no double-fire
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import {
  __resetAppForTest,
  __resetInterceptorsForTest,
  installAnchorClickInterceptor,
  setCurrentApp,
} from '../runtime.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

let postMessageSpy: ReturnType<typeof vi.fn>;
let originalPostMessage: typeof window.parent.postMessage;
let transport: MockTransport;
let app: App;

const baseArgs = {
  dispatchToolName: 'ggui_runtime_submit_action',
  renderId: 'render_1',
  appId: 'app_1',
} as const;

beforeEach(async () => {
  postMessageSpy = vi.fn();
  originalPostMessage = window.parent.postMessage;
  Object.defineProperty(window.parent, 'postMessage', {
    value: postMessageSpy,
    configurable: true,
    writable: true,
  });
  // Module-level interceptor guards persist across tests; reset so
  // each spec installs fresh. (Production never resets — this is
  // explicitly test-only.)
  __resetInterceptorsForTest();
  document.body.innerHTML = '';

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
  document.body.innerHTML = '';
  __resetAppForTest();
});

/** Helper — fire a click event the same way a user gesture would. */
function clickAnchor(link: HTMLAnchorElement): MouseEvent {
  const evt = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
  });
  link.dispatchEvent(evt);
  return evt;
}

/**
 * Helper — return the array of methods seen on the raw-postMessage
 * spy (audits, not the spec-canonical App-routed `ui/open-link`).
 */
function postMessageMethods(): string[] {
  return postMessageSpy.mock.calls.map(
    (call) => (call[0] as { method?: string }).method ?? '',
  );
}

/**
 * Helper — return every `ui/open-link` request observed on the App
 * transport (the spec-canonical destination post-#275).
 */
function openLinkRequests(): Array<Record<string, unknown>> {
  return transport.sent
    .filter((msg) => (msg as { method?: unknown }).method === 'ui/open-link')
    .map((msg) => msg as Record<string, unknown>);
}

describe('installAnchorClickInterceptor', () => {
  it('intercepts external cross-origin http(s) clicks', async () => {
    installAnchorClickInterceptor(baseArgs);
    const a = document.createElement('a');
    a.href = 'https://example.com/page';
    a.textContent = 'click';
    document.body.appendChild(a);

    const evt = clickAnchor(a);

    expect(evt.defaultPrevented).toBe(true);
    // Audit fires synchronously on raw postMessage.
    expect(postMessageMethods()).toEqual(['tools/call']);
    // ui/open-link routes through the App transport — drain microtasks.
    await tick();
    const links = openLinkRequests();
    expect(links).toHaveLength(1);
    expect(links[0]?.params).toEqual({ url: 'https://example.com/page' });
  });

  it('intercepts same-origin links with target="_blank"', async () => {
    installAnchorClickInterceptor(baseArgs);
    const a = document.createElement('a');
    // jsdom default origin is http://localhost — make the href same-origin.
    a.href = `${window.location.origin}/local-page`;
    a.target = '_blank';
    document.body.appendChild(a);

    const evt = clickAnchor(a);

    expect(evt.defaultPrevented).toBe(true);
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    await tick();
    const links = openLinkRequests();
    expect(links).toHaveLength(1);
    expect((links[0]?.params as Record<string, unknown>).url).toBe(
      `${window.location.origin}/local-page`,
    );
  });

  it('does NOT intercept same-origin links without target="_blank"', () => {
    installAnchorClickInterceptor(baseArgs);
    const a = document.createElement('a');
    a.href = `${window.location.origin}/local-page`;
    document.body.appendChild(a);

    const evt = clickAnchor(a);

    expect(evt.defaultPrevented).toBe(false);
    expect(postMessageSpy).not.toHaveBeenCalled();
    expect(openLinkRequests()).toHaveLength(0);
  });

  it('does NOT intercept #fragment links', () => {
    installAnchorClickInterceptor(baseArgs);
    const a = document.createElement('a');
    a.setAttribute('href', '#section-2');
    document.body.appendChild(a);

    const evt = clickAnchor(a);

    expect(evt.defaultPrevented).toBe(false);
    expect(postMessageSpy).not.toHaveBeenCalled();
    expect(openLinkRequests()).toHaveLength(0);
  });

  it('does NOT intercept mailto: links', () => {
    installAnchorClickInterceptor(baseArgs);
    const a = document.createElement('a');
    a.setAttribute('href', 'mailto:hi@example.com');
    document.body.appendChild(a);

    const evt = clickAnchor(a);

    expect(evt.defaultPrevented).toBe(false);
    expect(postMessageSpy).not.toHaveBeenCalled();
    expect(openLinkRequests()).toHaveLength(0);
  });

  it('does NOT intercept tel: links', () => {
    installAnchorClickInterceptor(baseArgs);
    const a = document.createElement('a');
    a.setAttribute('href', 'tel:+15555555555');
    document.body.appendChild(a);

    const evt = clickAnchor(a);

    expect(evt.defaultPrevented).toBe(false);
    expect(postMessageSpy).not.toHaveBeenCalled();
    expect(openLinkRequests()).toHaveLength(0);
  });

  it('does NOT intercept javascript: links', () => {
    installAnchorClickInterceptor(baseArgs);
    const a = document.createElement('a');
    a.setAttribute('href', 'javascript:void(0)');
    document.body.appendChild(a);

    const evt = clickAnchor(a);

    expect(evt.defaultPrevented).toBe(false);
    expect(postMessageSpy).not.toHaveBeenCalled();
    expect(openLinkRequests()).toHaveLength(0);
  });

  it('resolves to the ancestor anchor when click target is nested', async () => {
    installAnchorClickInterceptor(baseArgs);
    const a = document.createElement('a');
    a.href = 'https://example.com/page';
    const span = document.createElement('span');
    span.textContent = 'inner';
    a.appendChild(span);
    document.body.appendChild(a);

    // Dispatch click on the inner span — the interceptor MUST find
    // the anchor via `closest()`.
    const evt = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    span.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    await tick();
    const links = openLinkRequests();
    expect(links).toHaveLength(1);
    expect((links[0]?.params as Record<string, unknown>).url).toBe(
      'https://example.com/page',
    );
  });

  it('does NOT fire when defaultPrevented is true (component already consumed)', () => {
    installAnchorClickInterceptor(baseArgs);
    const a = document.createElement('a');
    a.href = 'https://example.com/page';
    document.body.appendChild(a);
    // Pre-empt: a higher-priority capture-phase listener calls
    // preventDefault before our listener runs. To simulate that here,
    // attach a listener with capture and an earlier-registered window
    // listener won't help (ours is on document with capture, this
    // would also be capture but later-registered) — instead use a
    // dispatchEvent on a pre-prevented event by toggling
    // defaultPrevented BEFORE the dispatch isn't possible (read-only).
    // We mimic via a window-level capture listener registered AFTER
    // ours fires; since DOM dispatch order on capture goes window →
    // document → target, only window-level capture is earlier than
    // document-level capture. So register ours AFTER a window
    // listener that prevents.
    //
    // jsdom dispatch order: capture phase walks ancestors top-down
    // (window → document → … → parent → target's parent). A window
    // capture listener fires BEFORE the document capture listener.
    const earlierBlocker = (e: Event) => e.preventDefault();
    window.addEventListener('click', earlierBlocker, { capture: true });

    const evt = clickAnchor(a);
    expect(evt.defaultPrevented).toBe(true);
    // Our interceptor saw defaultPrevented and bailed → no postMessages
    // and no ui/open-link on the App transport.
    expect(postMessageSpy).not.toHaveBeenCalled();
    expect(openLinkRequests()).toHaveLength(0);

    window.removeEventListener('click', earlierBlocker, { capture: true });
  });

  it('is idempotent — calling install twice does not double-fire', async () => {
    installAnchorClickInterceptor(baseArgs);
    installAnchorClickInterceptor(baseArgs);
    installAnchorClickInterceptor(baseArgs);

    const a = document.createElement('a');
    a.href = 'https://example.com/page';
    document.body.appendChild(a);

    clickAnchor(a);

    // Audit fires exactly once (raw postMessage) and ui/open-link
    // exactly once (App transport) — not three of each.
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    await tick();
    expect(openLinkRequests()).toHaveLength(1);
  });
});
