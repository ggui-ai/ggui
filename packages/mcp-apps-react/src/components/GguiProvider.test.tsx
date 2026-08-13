import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { UnknownPermissionNameError, type PermissionStatus } from '@ggui-ai/protocol';
import { GguiProvider, useGguiContext } from './GguiProvider';

function TestConsumer() {
  const ctx = useGguiContext();
  return <div data-testid="app-id">{ctx.appId}</div>;
}

describe('GguiProvider', () => {
  it('provides appId to children', () => {
    render(
      <GguiProvider appId="app_123">
        <TestConsumer />
      </GguiProvider>
    );
    expect(screen.getByTestId('app-id').textContent).toBe('app_123');
  });

  it('throws when used outside provider', () => {
    expect(() => render(<TestConsumer />)).toThrow(
      'useGguiContext must be used within a GguiProvider'
    );
  });

  // The `adapters` prop + `ctx.adapters` allow-list was retired in
  // Bucket B (2026-05-18, LOCKED-22). Grant model lives on
  // `clientCapabilities.gadgets[*].permission`.

  describe('requestPermission', () => {
    // Bucket B audit follow-up (2026-05-18, Issue 1): SDK must gate
    // requested names against `KNOWN_PERMISSION_NAMES` now that the
    // host-advertised `AdapterType[]` allow-list is gone.

    function CaptureRequest({ onReady }: { onReady: (fn: (name: string) => Promise<PermissionStatus>) => void }) {
      const ctx = useGguiContext();
      const seen = useRef(false);
      useEffect(() => {
        if (seen.current) return;
        seen.current = true;
        onReady(ctx.requestPermission);
      }, [ctx.requestPermission, onReady]);
      return null;
    }

    function renderProviderAndCapture(): (name: string) => Promise<PermissionStatus> {
      let captured: ((name: string) => Promise<PermissionStatus>) | null = null;
      render(
        <GguiProvider appId="app_perm">
          <CaptureRequest onReady={(fn) => { captured = fn; }} />
        </GguiProvider>
      );
      if (!captured) throw new Error('requestPermission was not captured');
      return captured;
    }

    it('accepts a known Web Permissions API name', async () => {
      const requestPermission = renderProviderAndCapture();
      let status: PermissionStatus | undefined;
      await act(async () => {
        status = await requestPermission('geolocation');
      });
      expect(status).toBe('granted');
    });

    it('throws UnknownPermissionNameError for an unknown name', async () => {
      const requestPermission = renderProviderAndCapture();
      await expect(requestPermission('geolocaiton')).rejects.toBeInstanceOf(
        UnknownPermissionNameError,
      );
    });
  });
});
