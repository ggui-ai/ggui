import { describe, it, expect } from 'vitest';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { UnknownPermissionNameError, type PermissionStatus } from '@ggui-ai/protocol';
import { GguiProvider } from './GguiProvider';
import { useGguiContext } from '../context/GguiContext';

// Bucket B audit follow-up (2026-05-18, Issue 1): the React Native SDK
// must gate `requestPermission` against `KNOWN_PERMISSION_NAMES` now
// that LOCKED-22 retired the host-advertised `AdapterType[]` allow-list.

interface CaptureProps {
  onReady: (fn: (name: string) => Promise<PermissionStatus>) => void;
}

function Capture({ onReady }: CaptureProps): null {
  const ctx = useGguiContext();
  React.useEffect(() => {
    onReady(ctx.requestPermission);
  }, [ctx.requestPermission, onReady]);
  return null;
}

async function renderAndCapture(): Promise<(name: string) => Promise<PermissionStatus>> {
  let captured: ((name: string) => Promise<PermissionStatus>) | null = null;
  await act(async () => {
    create(
      <GguiProvider appId="app_perm">
        <Capture onReady={(fn) => { captured = fn; }} />
      </GguiProvider>,
    );
  });
  if (!captured) throw new Error('requestPermission was not captured');
  return captured;
}

describe('GguiProvider (react-native) requestPermission', () => {
  it('accepts a known Web Permissions API name', async () => {
    const requestPermission = await renderAndCapture();
    let status: PermissionStatus | undefined;
    await act(async () => {
      status = await requestPermission('camera');
    });
    expect(status).toBe('granted');
  });

  it('throws UnknownPermissionNameError for an unknown name', async () => {
    const requestPermission = await renderAndCapture();
    await expect(requestPermission('voice')).rejects.toBeInstanceOf(
      UnknownPermissionNameError,
    );
  });
});
