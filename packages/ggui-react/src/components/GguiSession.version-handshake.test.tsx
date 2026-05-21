/**
 * GguiSession — protocol-version handshake surface (SPEC §11.2.2).
 *
 * Exercises the two client-side paths Phase 1 Item 6 lands:
 *
 *   - On `{type:'ack'}` receipt, if `ack.serverVersion` is present and
 *     NOT in `CLIENT_SUPPORTED_VERSIONS`, the session surfaces
 *     `UpgradeRequiredError` via the `onError` hook.
 *   - On `{type:'error', payload:{code:'UPGRADE_REQUIRED'}}` receipt
 *     (server-emitted under `versionPolicy: 'advisory'` or
 *     `'reject'`), the session surfaces `UpgradeRequiredError` via
 *     `onError` — not a bare `Error` — so callers can pattern-match
 *     without string-sniffing `.message`.
 *
 * Mocks `../hooks/useWebSocket` to capture the `onMessage` callback
 * the component wires, then calls it synchronously with crafted
 * frames. This avoids spinning up a real websocket — we're pinning
 * client-side message dispatch, not transport behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import {
  CLIENT_SUPPORTED_VERSIONS,
  PROTOCOL_SCHEMA_VERSION,
  UpgradeRequiredError,
} from '@ggui-ai/protocol';

// Capture the onMessage callback the component passes to useWebSocket.
// Exposed via a module-level slot so each test can drive the real
// handler with synthetic frames.
let capturedOnMessage: ((message: WebSocketMessage) => void) | null = null;

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: (opts: { onMessage: (m: WebSocketMessage) => void }) => {
    capturedOnMessage = opts.onMessage;
    return { status: 'connected' as const, send: vi.fn() };
  },
}));

import { GguiProvider } from './GguiProvider';
import { GguiSession } from './GguiSession';

describe('GguiSession — protocol-version handshake', () => {
  beforeEach(() => {
    capturedOnMessage = null;
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <GguiProvider appId="app_123">{children}</GguiProvider>
  );

  it('surfaces UpgradeRequiredError when ack.serverVersion is unsupported', () => {
    const onError = vi.fn();
    render(
      <GguiSession sessionId="sess_abc" onError={onError}>
        <div>child</div>
      </GguiSession>,
      { wrapper },
    );
    expect(capturedOnMessage).toBeDefined();
    capturedOnMessage!({
      type: 'ack',
      payload: {
        sequence: 0,
        timestamp: 1,
        serverVersion: 'draft-2099-01-01-ancient',
      },
    });
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0];
    expect(err).toBeInstanceOf(UpgradeRequiredError);
    expect(err.code).toBe('UPGRADE_REQUIRED');
    expect(err.observedBy).toBe('client');
    expect(err.observedVersion).toBe('draft-2099-01-01-ancient');
  });

  it('does NOT surface anything when ack.serverVersion matches CLIENT_SUPPORTED_VERSIONS', () => {
    const onError = vi.fn();
    render(
      <GguiSession sessionId="sess_abc" onError={onError}>
        <div>child</div>
      </GguiSession>,
      { wrapper },
    );
    capturedOnMessage!({
      type: 'ack',
      payload: {
        sequence: 0,
        timestamp: 1,
        serverVersion: PROTOCOL_SCHEMA_VERSION,
      },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('does NOT surface anything when ack omits serverVersion (legacy-pass-through)', () => {
    const onError = vi.fn();
    render(
      <GguiSession sessionId="sess_abc" onError={onError}>
        <div>child</div>
      </GguiSession>,
      { wrapper },
    );
    capturedOnMessage!({
      type: 'ack',
      payload: { sequence: 0, timestamp: 1 },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('recognizes server-emitted UPGRADE_REQUIRED error frame as typed', () => {
    const onError = vi.fn();
    render(
      <GguiSession sessionId="sess_abc" onError={onError}>
        <div>child</div>
      </GguiSession>,
      { wrapper },
    );
    capturedOnMessage!({
      type: 'error',
      payload: {
        code: 'UPGRADE_REQUIRED',
        message: 'Server speaks v-new; client must upgrade.',
      },
    });
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0];
    expect(err).toBeInstanceOf(UpgradeRequiredError);
    expect(err.code).toBe('UPGRADE_REQUIRED');
    expect(err.observedBy).toBe('server');
    expect(err.acceptedVersions).toEqual(CLIENT_SUPPORTED_VERSIONS);
  });

  it('lifts details.serverVersion into the typed error when the server populates it', () => {
    // First-party servers stamp `details: {serverVersion, clientSupportedVersions, policy}`
    // on the UPGRADE_REQUIRED frame (see `session-channel.ts`
    // sendError call). Defensive lift so operators see which version
    // the server observed in `.observedVersion`, not just "unknown".
    const onError = vi.fn();
    render(
      <GguiSession sessionId="sess_abc" onError={onError}>
        <div>child</div>
      </GguiSession>,
      { wrapper },
    );
    capturedOnMessage!({
      type: 'error',
      payload: {
        code: 'UPGRADE_REQUIRED',
        message: 'mismatch',
        details: {
          serverVersion: 'v-future-server',
          clientSupportedVersions: ['v-old'],
          policy: 'advisory',
        },
      },
    });
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0];
    expect(err).toBeInstanceOf(UpgradeRequiredError);
    expect(err.observedVersion).toBe('v-future-server');
  });

  it('tolerates absent or malformed details on UPGRADE_REQUIRED (observedVersion undefined)', () => {
    const onError = vi.fn();
    render(
      <GguiSession sessionId="sess_abc" onError={onError}>
        <div>child</div>
      </GguiSession>,
      { wrapper },
    );
    capturedOnMessage!({
      type: 'error',
      payload: {
        code: 'UPGRADE_REQUIRED',
        message: 'mismatch',
        // details: (absent)
      },
    });
    const err1 = onError.mock.calls[0][0];
    expect(err1).toBeInstanceOf(UpgradeRequiredError);
    expect(err1.observedVersion).toBeUndefined();

    // Malformed details — array instead of object
    onError.mockClear();
    capturedOnMessage!({
      type: 'error',
      payload: {
        code: 'UPGRADE_REQUIRED',
        message: 'mismatch',
        details: ['not-an-object'],
      },
    });
    const err2 = onError.mock.calls[0][0];
    expect(err2).toBeInstanceOf(UpgradeRequiredError);
    expect(err2.observedVersion).toBeUndefined();
  });

  it('non-UPGRADE_REQUIRED error codes fall through to generic Error (not typed)', () => {
    const onError = vi.fn();
    render(
      <GguiSession sessionId="sess_abc" onError={onError}>
        <div>child</div>
      </GguiSession>,
      { wrapper },
    );
    capturedOnMessage!({
      type: 'error',
      payload: { code: 'SESSION_NOT_FOUND', message: 'no such session' },
    });
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UpgradeRequiredError);
    expect(err.message).toBe('no such session');
  });
});
