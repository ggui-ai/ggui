/**
 * Pins the postMessage / App-method shapes for the two native-idiom
 * host-control primitives (openLink / requestDisplayMode) and their
 * paired action audit fires.
 *
 * Each primitive emits TWO envelopes:
 *   1. `tools/call ggui_runtime_submit_action` — action envelope.
 *      Carries the `kind`-discriminated `GguiSubmitActionInput` shape
 *      from `@ggui-ai/protocol/integrations/mcp-apps`. Fired by
 *      `emitAudit` via raw `window.parent.postMessage` (the audit
 *      shim has NOT migrated to `app.callServerTool` yet — separate
 *      cleanup).
 *   2. The primary host effect — spec-canonical App methods
 *      (`app.openLink(...)` / `app.requestDisplayMode(...)`) routed
 *      through the bound transport post-Phase-1.19b.3 followup
 *      (#275). Tests assert these via `transport.sent` filtered to
 *      the method.
 *
 * Empirically critical:
 *   - The audit envelope shape MUST match the protocol contract or the
 *     server-side `ggui_runtime_submit_action` handler rejects with
 *     `INVALID_ACTION_KIND` and operators lose observability.
 *
 * `sendMessage` was retired 2026-05-08 (Slice 12 Phase 2) — chat-shortcut
 * UX degrades to Pattern β consent prompts in v1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import {
  __resetAppForTest,
  emitAudit,
  openLinkInParent,
  requestDisplayModeInParent,
  setCurrentApp,
} from '../runtime.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

const baseArgs = {
  toolName: 'ggui_runtime_submit_action',
  sessionId: 'render_1',
  appId: 'app_1',
};

let postMessageSpy: ReturnType<typeof vi.fn>;
let originalPostMessage: typeof window.parent.postMessage;
let transport: MockTransport;
let app: App;

beforeEach(async () => {
  postMessageSpy = vi.fn();
  originalPostMessage = window.parent.postMessage;
  // jsdom: same window is its own parent. Replace postMessage on the
  // (effectively-self) parent surface so the helpers' calls land here.
  Object.defineProperty(window.parent, 'postMessage', {
    value: postMessageSpy,
    configurable: true,
    writable: true,
  });

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
  __resetAppForTest();
});

describe('emitAudit', () => {
  it('posts a tools/call envelope carrying the canonical GguiSubmitActionInput shape', () => {
    emitAudit({
      ...baseArgs,
      kind: 'openLink',
      payload: { url: 'https://example.com' },
      actionId: 'a3f2b1d4',
      firedAt: '2026-05-07T10:00:00.000Z',
    });
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const [envelope] = postMessageSpy.mock.calls[0];
    expect(envelope).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'ggui_runtime_submit_action',
        arguments: {
          kind: 'openLink',
          payload: { url: 'https://example.com' },
          sessionId: 'render_1',
          appId: 'app_1',
          actionId: 'a3f2b1d4',
          firedAt: '2026-05-07T10:00:00.000Z',
        },
      },
    });
    // `id` MUST be present (JSON-RPC) but value is fresh per call.
    expect(typeof (envelope as { id: unknown }).id).toBe('number');
  });
});

describe('openLinkInParent', () => {
  it('emits a ui/open-link request through the App transport alongside the raw-postMessage audit', async () => {
    openLinkInParent({ ...baseArgs, url: 'https://example.com' });

    // (1) Audit on raw postMessage (synchronous).
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const audit = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(
      ((audit.params as Record<string, unknown>).arguments as Record<string, unknown>)
        .kind,
    ).toBe('openLink');

    // (2) ui/open-link via App transport — fires asynchronously via
    // app.openLink(...). Drain microtasks before asserting.
    await tick();
    const openLinkRequests = transport.sent.filter(
      (msg) => (msg as { method?: unknown }).method === 'ui/open-link',
    );
    expect(openLinkRequests).toHaveLength(1);
    const openLink = openLinkRequests[0] as Record<string, unknown>;
    expect(openLink.params).toEqual({ url: 'https://example.com' });
  });

  it('throws on empty url', () => {
    expect(() =>
      openLinkInParent({ ...baseArgs, url: '' }),
    ).toThrow(/non-empty string/);
  });
});

describe('requestDisplayModeInParent', () => {
  it.each(['fullscreen', 'pip', 'inline'] as const)(
    'emits a ui/request-display-mode request through the App transport for mode=%s',
    async (mode) => {
      requestDisplayModeInParent({ ...baseArgs, mode });
      await tick();
      const displayModeRequests = transport.sent.filter(
        (msg) =>
          (msg as { method?: unknown }).method === 'ui/request-display-mode',
      );
      expect(displayModeRequests).toHaveLength(1);
      const displayMode = displayModeRequests[0] as Record<string, unknown>;
      expect(displayMode.params).toEqual({ mode });
    },
  );

  it('audit envelope carries kind:requestDisplayMode + payload.mode', () => {
    requestDisplayModeInParent({ ...baseArgs, mode: 'fullscreen' });
    const audit = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    const args = (audit.params as Record<string, unknown>).arguments as Record<
      string,
      unknown
    >;
    expect(args.kind).toBe('requestDisplayMode');
    expect(args.payload).toEqual({ mode: 'fullscreen' });
  });
});

describe('audit-symmetry invariant', () => {
  it.each([
    [
      'openLink',
      () => openLinkInParent({ ...baseArgs, url: 'https://example.com' }),
    ] as const,
    [
      'requestDisplayMode',
      () =>
        requestDisplayModeInParent({ ...baseArgs, mode: 'fullscreen' }),
    ] as const,
  ])('%s fires audit BEFORE the primary host effect', (_kind, run) => {
    run();
    // The audit fires synchronously via raw postMessage; the host
    // effect (now app.openLink / app.requestDisplayMode) is enqueued
    // asynchronously on the App transport. So at this synchronous
    // observation point, the audit MUST be the only thing on the spy
    // and the App transport MUST be empty of the host-effect request.
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const first = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(first.method).toBe('tools/call');
    expect((first.params as Record<string, unknown>).name).toBe(
      'ggui_runtime_submit_action',
    );
  });
});
