import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCamera } from './useCamera';

describe('useCamera', () => {
  let originalNavigator: Navigator | undefined;
  beforeEach(() => {
    originalNavigator = globalThis.navigator;
  });
  afterEach(() => {
    if (originalNavigator !== undefined) {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      });
    }
  });

  it('not_supported when mediaDevices is missing', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
    });
    const { result } = renderHook(() => useCamera());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('not_supported');
  });

  it('permission_denied → denied when getUserMedia rejects with NotAllowedError', async () => {
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(err) } },
      configurable: true,
    });
    const { result } = renderHook(() => useCamera());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.error?.code).toBe('permission_denied');
  });
});
