import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRafThrottled } from '../useRafThrottled';

describe('useRafThrottled', () => {
  let rafQueue: Map<number, () => void> = new Map();
  let rafIdSeq = 0;

  beforeEach(() => {
    rafQueue = new Map();
    rafIdSeq = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: () => void) => {
        const id = ++rafIdSeq;
        rafQueue.set(id, cb);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        rafQueue.delete(id);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushRaf() {
    const pending = Array.from(rafQueue.values());
    rafQueue.clear();
    for (const cb of pending) cb();
  }

  it('emits the initial value synchronously on first render', () => {
    const { result } = renderHook(({ src }) => useRafThrottled(src), {
      initialProps: { src: 1 },
    });
    expect(result.current).toBe(1);
  });

  it('defers source updates to the next animation frame', () => {
    const { result, rerender } = renderHook(({ src }) => useRafThrottled(src), {
      initialProps: { src: 0 },
    });
    expect(result.current).toBe(0);

    rerender({ src: 1 });
    expect(result.current).toBe(0);

    act(() => {
      flushRaf();
    });
    expect(result.current).toBe(1);
  });

  it('collapses multiple rapid updates into one render per frame', () => {
    const { result, rerender } = renderHook(({ src }) => useRafThrottled(src), {
      initialProps: { src: 0 },
    });

    rerender({ src: 1 });
    rerender({ src: 2 });
    rerender({ src: 3 });

    expect(result.current).toBe(0);
    // Effect cleanup cancels prior frame on each re-render, then schedules a new
    // one, so at any instant at most one frame is pending.
    expect(rafQueue.size).toBe(1);

    act(() => {
      flushRaf();
    });
    expect(result.current).toBe(3);
  });
});
