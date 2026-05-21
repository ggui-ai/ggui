/**
 * Pins the postMessage envelope shapes for the two native-idiom host-
 * control primitives (openLink / requestDisplayMode) and their paired
 * action audit fires.
 *
 * Each primitive emits TWO envelopes:
 *   1. `tools/call ggui_runtime_submit_action` — action envelope. Carries
 *      the `kind`-discriminated `GguiSubmitActionInput` shape from
 *      `@ggui-ai/protocol/integrations/mcp-apps`.
 *   2. The primary host effect (`ui/open-link` / `ui/request-display-mode`).
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
import {
  emitAudit,
  openLinkInParent,
  requestDisplayModeInParent,
} from '../runtime.js';

const baseArgs = {
  toolName: 'ggui_runtime_submit_action',
  sessionId: 'sess_1',
  appId: 'app_1',
};

let postMessageSpy: ReturnType<typeof vi.fn>;
let originalPostMessage: typeof window.parent.postMessage;

beforeEach(() => {
  postMessageSpy = vi.fn();
  originalPostMessage = window.parent.postMessage;
  // jsdom: same window is its own parent. Replace postMessage on the
  // (effectively-self) parent surface so the helpers' calls land here.
  Object.defineProperty(window.parent, 'postMessage', {
    value: postMessageSpy,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window.parent, 'postMessage', {
    value: originalPostMessage,
    configurable: true,
    writable: true,
  });
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
          sessionId: 'sess_1',
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
  it('emits a ui/open-link envelope alongside the audit', () => {
    openLinkInParent({ ...baseArgs, url: 'https://example.com' });
    expect(postMessageSpy).toHaveBeenCalledTimes(2);
    const audit = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    const openLink = postMessageSpy.mock.calls[1][0] as Record<string, unknown>;
    expect(
      ((audit.params as Record<string, unknown>).arguments as Record<string, unknown>)
        .kind,
    ).toBe('openLink');
    expect(openLink.method).toBe('ui/open-link');
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
    'emits a ui/request-display-mode envelope for mode=%s',
    (mode) => {
      requestDisplayModeInParent({ ...baseArgs, mode });
      const displayMode = postMessageSpy.mock.calls[1][0] as Record<string, unknown>;
      expect(displayMode.method).toBe('ui/request-display-mode');
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
    expect(postMessageSpy).toHaveBeenCalledTimes(2);
    const first = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(first.method).toBe('tools/call');
    expect((first.params as Record<string, unknown>).name).toBe(
      'ggui_runtime_submit_action',
    );
  });
});
