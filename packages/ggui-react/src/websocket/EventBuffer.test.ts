import { describe, it, expect, vi } from 'vitest';
import { EventBuffer } from './EventBuffer';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';

describe('EventBuffer', () => {
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

    // Adding one more should drop the oldest
    buffer.add({ type: 'ping', payload: { id: 500 } });
    expect(buffer.size()).toBe(500);
  });

  it('respects max size and drops oldest messages', () => {
    const buffer = new EventBuffer(2);
    const msg1: WebSocketMessage = { type: 'ping', payload: { id: 1 } };
    const msg2: WebSocketMessage = { type: 'ping', payload: { id: 2 } };
    const msg3: WebSocketMessage = { type: 'ping', payload: { id: 3 } };

    buffer.add(msg1);
    buffer.add(msg2);
    buffer.add(msg3);

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
});
