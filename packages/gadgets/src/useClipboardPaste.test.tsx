import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useClipboardPaste } from './useClipboardPaste';

describe('useClipboardPaste', () => {
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

  it('reads text and transitions idle → prompting → completed', async () => {
    const readText = vi.fn().mockResolvedValue('pasted content');
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { readText } },
      configurable: true,
    });

    const { result } = renderHook(() => useClipboardPaste());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('completed');
    expect(result.current.value).toBe('pasted content');
  });

  it('maps NotAllowedError to permission_denied + status=denied', async () => {
    const err = Object.assign(new Error('blocked'), {
      name: 'NotAllowedError',
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { readText: vi.fn().mockRejectedValue(err) } },
      configurable: true,
    });
    const { result } = renderHook(() => useClipboardPaste());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.error?.code).toBe('permission_denied');
  });

  it('returns not_supported when clipboard read is missing', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
    });
    const { result } = renderHook(() => useClipboardPaste());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('not_supported');
  });
});
