/**
 * Tests for `InMemoryPendingEventConsumer` — the OSS in-memory
 * adapter for the pending-events buffer that backs `ggui_consume`.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryPendingEventConsumer } from './pending-event-consumer.js';
import { PendingPipeNotFoundError } from '../pending-event-consumer.js';

describe('InMemoryPendingEventConsumer', () => {
  describe('lifecycle hooks', () => {
    it('markCreated registers a session — subsequent appends + consumes work', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      await c.append('stack-1', { id: 'evt-1', type: 'foo' });
      const result = await c.consumeAndClear('stack-1', 60_000);
      expect(result.events).toEqual([{ id: 'evt-1', type: 'foo' }]);
      expect(result.status).toBe('active');
    });

    it('markCreated is idempotent — calling twice does NOT reset', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      await c.append('stack-1', { id: 'evt-1' });
      c.markCreated('stack-1'); // no-op
      const result = await c.consumeAndClear('stack-1', 60_000);
      expect(result.events).toHaveLength(1);
    });

    it('markStatus flips the observed status — next consume returns it', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      c.markStatus('stack-1', 'completed');
      const result = await c.consumeAndClear('stack-1', 60_000);
      expect(result.status).toBe('completed');
    });

    it('markDeleted causes subsequent consumeAndClear to throw PendingPipeNotFoundError', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      c.markDeleted('stack-1');
      await expect(
        c.consumeAndClear('stack-1', 60_000),
      ).rejects.toBeInstanceOf(PendingPipeNotFoundError);
    });
  });

  describe('consumeAndClear', () => {
    it('returns events present at clear time, then leaves the buffer empty', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      await c.append('stack-1', { id: 'a' });
      await c.append('stack-1', { id: 'b' });
      const first = await c.consumeAndClear('stack-1', 60_000);
      expect(first.events).toEqual([{ id: 'a' }, { id: 'b' }]);
      const second = await c.consumeAndClear('stack-1', 60_000);
      expect(second.events).toEqual([]);
    });

    it('throws PendingPipeNotFoundError when the session never existed', async () => {
      const c = new InMemoryPendingEventConsumer();
      await expect(
        c.consumeAndClear('never-created', 60_000),
      ).rejects.toBeInstanceOf(PendingPipeNotFoundError);
    });

    it('returns empty array + active status when buffer is empty', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      const result = await c.consumeAndClear('stack-1', 60_000);
      expect(result.events).toEqual([]);
      expect(result.status).toBe('active');
    });

    it('serializes concurrent consumeAndClear — only one consumer sees the events', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      // Seed 5 events.
      for (let i = 0; i < 5; i++) {
        await c.append('stack-1', { id: `evt-${i}` });
      }
      // Two concurrent consumers race for the buffer.
      const [a, b] = await Promise.all([
        c.consumeAndClear('stack-1', 60_000),
        c.consumeAndClear('stack-1', 60_000),
      ]);
      // One sees all 5 events; the other sees 0. NOT both seeing
      // the same set (which would be the duplicate-delivery bug).
      const totalSeen = a.events.length + b.events.length;
      expect(totalSeen).toBe(5);
      expect(a.events.length === 0 || b.events.length === 0).toBe(true);
    });
  });

  describe('append', () => {
    it('throws PendingPipeNotFoundError when session never registered', async () => {
      const c = new InMemoryPendingEventConsumer();
      await expect(
        c.append('never', { id: 'evt-1' }),
      ).rejects.toBeInstanceOf(PendingPipeNotFoundError);
    });

    it('FIFO ordering — sequential appends preserve order on consume', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      await c.append('stack-1', { id: 'first' });
      await c.append('stack-1', { id: 'second' });
      await c.append('stack-1', { id: 'third' });
      const result = await c.consumeAndClear('stack-1', 60_000);
      expect(result.events.map((e) => e.id)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('events appended after a consume land in the next consume', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      await c.append('stack-1', { id: 'before' });
      const first = await c.consumeAndClear('stack-1', 60_000);
      expect(first.events).toEqual([{ id: 'before' }]);
      await c.append('stack-1', { id: 'after' });
      const second = await c.consumeAndClear('stack-1', 60_000);
      expect(second.events).toEqual([{ id: 'after' }]);
    });
  });

  describe('inspector helpers', () => {
    it('pendingCount reports buffer size without consuming', async () => {
      const c = new InMemoryPendingEventConsumer();
      c.markCreated('stack-1');
      expect(c.pendingCount('stack-1')).toBe(0);
      await c.append('stack-1', { id: 'a' });
      await c.append('stack-1', { id: 'b' });
      expect(c.pendingCount('stack-1')).toBe(2);
      // Repeated calls don't drain.
      expect(c.pendingCount('stack-1')).toBe(2);
    });

    it('pendingCount returns 0 for a session that doesn\'t exist (no throw)', () => {
      const c = new InMemoryPendingEventConsumer();
      expect(c.pendingCount('does-not-exist')).toBe(0);
    });
  });
});
