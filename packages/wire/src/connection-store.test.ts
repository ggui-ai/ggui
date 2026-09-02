/**
 * ggui#670 — the connection store: the in-document external store that
 * makes `useRender().isConnected` a LIVE read (it was a hardcoded `true`
 * — a standing lie in the taught surface). Build-once preserved: the
 * store object is stable; only subscribers re-render. Runtime writes
 * via `set`; wire reads via `useSyncExternalStore(subscribe, getSnapshot)`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createConnectionStore } from './connection-store';

describe('createConnectionStore (ggui#670)', () => {
  it('defaults to connected — absent transition means today\'s behavior', () => {
    const s = createConnectionStore();
    expect(s.getSnapshot()).toBe(true);
  });

  it('set(false) notifies subscribers and flips the snapshot', () => {
    const s = createConnectionStore();
    const listener = vi.fn();
    s.subscribe(listener);
    s.set(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot()).toBe(false);
  });

  it('setting the same value does NOT notify — one transition per edge, structurally', () => {
    const s = createConnectionStore();
    const listener = vi.fn();
    s.subscribe(listener);
    s.set(true);
    s.set(true);
    expect(listener).not.toHaveBeenCalled();
    s.set(false);
    s.set(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const s = createConnectionStore();
    const listener = vi.fn();
    const off = s.subscribe(listener);
    off();
    s.set(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('getSnapshot is synchronous and stable-by-value — a late reader lands on the current state with no first-frame flash', () => {
    const s = createConnectionStore();
    s.set(false);
    // A reader subscribing AFTER the transition reads false immediately.
    expect(s.getSnapshot()).toBe(false);
    const seen: boolean[] = [];
    s.subscribe(() => seen.push(s.getSnapshot()));
    s.set(true);
    expect(seen).toEqual([true]);
  });
});
