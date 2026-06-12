/**
 * EventBuffer (RN) tests — twin of `@ggui-ai/react`'s
 * `websocket/EventBuffer.test.ts`.
 *
 * Platform delta: the shared queue coverage (add/flush ordering,
 * overflow drop + warn + `onOverflow`, size) mirrors the web suite;
 * RN-only scenarios cover AsyncStorage persistence
 * (`setStorage` / `loadPersisted`) and type+payload deduplication.
 *
 * Listed in `../twin-parity.test.ts` `DOCUMENTED_DELTA_TWINS`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBuffer } from './EventBuffer';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import { clearAsyncStore } from '../test-setup';

describe('EventBuffer', () => {
  beforeEach(() => {
    clearAsyncStore();
  });

  it('adds and flushes messages', () => {
    const buffer = new EventBuffer();
    const msg1: WebSocketMessage = { type: 'ping', payload: { id: 1 } };
    const msg2: WebSocketMessage = { type: 'ping', payload: { id: 2 } };

    buffer.add(msg1);
    buffer.add(msg2);

    expect(buffer.size()).toBe(2);

    const flushed = buffer.flush();
    expect(flushed).toEqual([msg1, msg2]);
    expect(buffer.size()).toBe(0);
  });

  it('defaults to max size of 500', () => {
    const buffer = new EventBuffer();
    for (let i = 0; i < 500; i++) {
      buffer.add({ type: 'ping', payload: { id: i } });
    }
    expect(buffer.size()).toBe(500);

    // Adding one more (unique) should drop the oldest
    buffer.add({ type: 'ping', payload: { id: 500 } });
    expect(buffer.size()).toBe(500);
  });

  it('respects max size and drops oldest messages', () => {
    const buffer = new EventBuffer(2);
    const msg1: WebSocketMessage = { type: 'ping', payload: { id: 1 } };
    const msg2: WebSocketMessage = { type: 'ping', payload: { id: 2 } };
    const msg3: WebSocketMessage = { type: 'ping', payload: { id: 3 } };

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    buffer.add(msg1);
    buffer.add(msg2);
    buffer.add(msg3);
    vi.restoreAllMocks();

    expect(buffer.size()).toBe(2);

    const flushed = buffer.flush();
    expect(flushed).toEqual([msg2, msg3]);
  });

  it('warns on overflow', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buffer = new EventBuffer(2);

    buffer.add({ type: 'ping', payload: { id: 1 } });
    buffer.add({ type: 'ping', payload: { id: 2 } });
    expect(warnSpy).not.toHaveBeenCalled();

    buffer.add({ type: 'ping', payload: { id: 3 } });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('EventBuffer overflow')
    );

    warnSpy.mockRestore();
  });

  it('calls onOverflow callback when messages are dropped', () => {
    const onOverflow = vi.fn();
    const buffer = new EventBuffer({ maxSize: 2, onOverflow });

    const msg1: WebSocketMessage = { type: 'ping', payload: { id: 1 } };
    const msg2: WebSocketMessage = { type: 'ping', payload: { id: 2 } };
    const msg3: WebSocketMessage = { type: 'ping', payload: { id: 3 } };

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    buffer.add(msg1);
    buffer.add(msg2);
    buffer.add(msg3);

    expect(onOverflow).toHaveBeenCalledWith(msg1);
    vi.restoreAllMocks();
  });

  it('accepts options object for configuration', () => {
    const onOverflow = vi.fn();
    const buffer = new EventBuffer({ maxSize: 3, onOverflow });

    for (let i = 0; i < 3; i++) {
      buffer.add({ type: 'ping', payload: { id: i } });
    }
    expect(buffer.size()).toBe(3);
    expect(onOverflow).not.toHaveBeenCalled();
  });

  it('returns empty array when flushing empty buffer', () => {
    const buffer = new EventBuffer();
    expect(buffer.flush()).toEqual([]);
  });

  it('deduplicates messages with same type and payload', () => {
    const buffer = new EventBuffer();
    const msg: WebSocketMessage = { type: 'ping', payload: { id: 1 } };

    buffer.add(msg);
    buffer.add(msg); // duplicate

    expect(buffer.size()).toBe(1);
  });

  it('persists messages to storage', async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    };

    const buffer = new EventBuffer();
    buffer.setStorage(storage);

    const msg: WebSocketMessage = { type: 'ping', payload: { id: 1 } };
    buffer.add(msg);

    // setItem should have been called
    expect(storage.setItem).toHaveBeenCalled();
  });

  it('loads persisted messages from storage', async () => {
    const msg: WebSocketMessage = { type: 'ping', payload: { id: 42 } };
    const store = new Map<string, string>([
      ['ggui_event_buffer', JSON.stringify([msg])],
    ]);
    const storage = {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    };

    const buffer = new EventBuffer();
    buffer.setStorage(storage);
    await buffer.loadPersisted();

    expect(buffer.size()).toBe(1);
    const flushed = buffer.flush();
    expect(flushed).toEqual([msg]);
  });

  it('clears persisted data on flush', async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    };

    const buffer = new EventBuffer();
    buffer.setStorage(storage);

    buffer.add({ type: 'ping', payload: { id: 1 } });
    buffer.flush();

    expect(storage.removeItem).toHaveBeenCalledWith('ggui_event_buffer');
  });
});
