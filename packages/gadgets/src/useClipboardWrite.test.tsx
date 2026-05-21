import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useClipboardWrite } from './useClipboardWrite';

describe('useClipboardWrite', () => {
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

  it('starts idle with no value', () => {
    const { result } = renderHook(() =>
      useClipboardWrite({ text: 'hello' }),
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.value).toBeUndefined();
  });

  it('writes text and transitions idle → prompting → completed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    });

    const { result } = renderHook(() =>
      useClipboardWrite({ text: 'copied!' }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(writeText).toHaveBeenCalledWith('copied!');
    expect(result.current.status).toBe('completed');
    expect(result.current.value).toBe('copied!');
  });

  it('maps NotAllowedError to permission_denied + status=denied', async () => {
    const err = Object.assign(new Error('blocked'), {
      name: 'NotAllowedError',
    });
    const writeText = vi.fn().mockRejectedValue(err);
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    });

    const { result } = renderHook(() =>
      useClipboardWrite({ text: 'x' }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.error?.code).toBe('permission_denied');
  });

  it('maps generic Error to unknown + status=error', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('mystery'));
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    });

    const { result } = renderHook(() =>
      useClipboardWrite({ text: 'x' }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('unknown');
  });

  it('returns not_supported error when clipboard API is missing', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
    });
    const { result } = renderHook(() =>
      useClipboardWrite({ text: 'x' }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('not_supported');
  });

  it('errors when text option is missing at start time', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: vi.fn() } },
      configurable: true,
    });
    const { result } = renderHook(() =>
      useClipboardWrite(undefined as never),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.code).toBe('unknown');
    expect(result.current.error?.message).toMatch(/text/);
  });
});
