/**
 * `createDrainAckHandler` — unit coverage for the channel handler
 * factored out of `handleRendererMessage` in B2. The handler is a thin
 * passthrough to the module-scoped dispatch fan-out; the tests pin
 * payload forwarding + handler-type identity.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDrainAckHandler } from '../drain-ack.js';

describe('createDrainAckHandler', () => {
  it('forwards every payload to the dispatch closure', () => {
    const dispatch = vi.fn();
    const handler = createDrainAckHandler({ dispatch });
    handler.onMessage({
      sessionId: 's',
      appId: 'a',
      eventId: 'evt-1',
      drainedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(dispatch).toHaveBeenCalledWith({
      sessionId: 's',
      appId: 'a',
      eventId: 'evt-1',
      drainedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('declares the correct channel type for registry routing', () => {
    const handler = createDrainAckHandler({ dispatch: () => {} });
    expect(handler.type).toBe('drain_ack');
  });
});
