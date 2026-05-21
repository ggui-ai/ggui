import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFilePicker } from './useFilePicker';

function makeFile(name: string, content = 'data'): File {
  return new File([content], name, { type: 'text/plain' });
}

describe('useFilePicker', () => {
  let originalCreate: typeof document.createElement;
  beforeEach(() => {
    originalCreate = document.createElement.bind(document);
  });
  afterEach(() => {
    document.createElement = originalCreate;
  });

  it('completes with one file when user picks something', async () => {
    const file = makeFile('hello.txt');
    document.createElement = vi.fn((tag: string) => {
      const real = originalCreate(tag);
      if (tag === 'input') {
        Object.defineProperty(real, 'click', {
          value: () => {
            Object.defineProperty(real, 'files', {
              value: [file],
              configurable: true,
            });
            (real as HTMLInputElement).onchange?.(
              new Event('change') as unknown as Event,
            );
          },
        });
      }
      return real;
    }) as typeof document.createElement;

    const { result } = renderHook(() => useFilePicker());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('completed');
    expect(result.current.value?.files).toHaveLength(1);
    expect(result.current.value?.files[0].name).toBe('hello.txt');
  });

  it('routes empty selection to denied with aborted error', async () => {
    document.createElement = vi.fn((tag: string) => {
      const real = originalCreate(tag);
      if (tag === 'input') {
        Object.defineProperty(real, 'click', {
          value: () => {
            Object.defineProperty(real, 'files', {
              value: [],
              configurable: true,
            });
            (real as HTMLInputElement).onchange?.(
              new Event('change') as unknown as Event,
            );
          },
        });
      }
      return real;
    }) as typeof document.createElement;

    const { result } = renderHook(() => useFilePicker());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.error?.code).toBe('aborted');
  });
});
