import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMicrophone } from './useMicrophone';

describe('useMicrophone', () => {
  let originalNavigator: Navigator | undefined;
  let originalMediaRecorder:
    | typeof MediaRecorder
    | undefined;
  beforeEach(() => {
    originalNavigator = globalThis.navigator;
    originalMediaRecorder = (
      globalThis as { MediaRecorder?: typeof MediaRecorder }
    ).MediaRecorder;
  });
  afterEach(() => {
    if (originalNavigator !== undefined) {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      });
    }
    if (originalMediaRecorder !== undefined) {
      Object.defineProperty(globalThis, 'MediaRecorder', {
        value: originalMediaRecorder,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as { MediaRecorder?: typeof MediaRecorder })
        .MediaRecorder;
    }
  });

  it('not_supported when MediaRecorder is missing', async () => {
    delete (globalThis as { MediaRecorder?: typeof MediaRecorder })
      .MediaRecorder;
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: vi.fn() } },
      configurable: true,
    });
    const { result } = renderHook(() => useMicrophone());
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
    Object.defineProperty(globalThis, 'MediaRecorder', {
      value: class {},
      configurable: true,
      writable: true,
    });
    const { result } = renderHook(() => useMicrophone());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.error?.code).toBe('permission_denied');
  });
});
