/**
 * Tests for `createGguiConsumeHandler`.
 *
 * Post-Phase-B (flatten-render-identity): the pending-events pipe is
 * keyed by `renderId` (was `stackItemId`). The handler takes a single
 * `renderId` input, no longer round-trips through a secondary
 * `stackItemId → sessionId` index. `SessionStore` → `GguiSessionStore`.
 * `StackItemNotFoundError` → `GguiSessionNotFoundError`.
 *
 * Covers the wire contract:
 *   - renderId → tenancy gate via renderStore.get + appId cmp
 *   - tenancy mismatch + unknown render surface as GguiSessionNotFoundError
 *   - long-poll loop semantics (immediate, with-events, completed,
 *     mid-poll render-disappeared)
 *   - normalize raw rows to ConsumeEventEntry via parsePendingEnvelope
 *   - observer notifier fan-out (only fires when events present)
 *   - drain_ack + activeConsumerRegistry + slow-consume telemetry
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import {
  InMemoryActiveConsumerRegistry,
  InMemoryPendingEventConsumer,
  InMemoryGguiSessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiConsumeHandler,
  type ConsumeLogger,
  type DrainAckNotifier,
  type ObserverNotifier,
} from './consume.js';
import { GguiSessionNotFoundError } from './errors.js';

const NOW_MS = Date.parse('2026-05-09T00:00:00.000Z');

describe('createGguiConsumeHandler', () => {
  let renderStore: InMemoryGguiSessionStore;
  let consumer: InMemoryPendingEventConsumer;

  beforeEach(() => {
    renderStore = new InMemoryGguiSessionStore();
    consumer = new InMemoryPendingEventConsumer();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function seedRender(renderId: string, appId: string): Promise<void> {
    const render: ComponentGguiSession = {
      id: renderId,
      appId,
      type: 'component',
      componentCode: '',
      contentType: 'application/javascript+react',
      eventSequence: 0,
      createdAt: NOW_MS,
      lastActivityAt: NOW_MS,
      expiresAt: NOW_MS + 60_000,
    };
    await renderStore.commit({ render, appId });
    consumer.markCreated(renderId);
  }

  describe('declaration metadata', () => {
    it('exposes ggui_consume name + agent audience tag', () => {
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      expect(handler.name).toBe('ggui_consume');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('renderId resolution', () => {
    it('resolves renderId via the render store and returns events', async () => {
      await seedRender('render-1', 'app-1');
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({
          type: 'submit',
          payload: { foo: 'bar' },
        }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('submit');
      expect(result.status).toBe('active');
    });

    it('cross-tenant renderId throws GguiSessionNotFoundError (no leak)', async () => {
      await seedRender('render-1', 'app-1');
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      await expect(
        handler.handler(
          { renderId: 'render-1', timeout: 0 },
          { appId: 'tenant-X', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });

    it('unknown renderId throws GguiSessionNotFoundError', async () => {
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      await expect(
        handler.handler(
          { renderId: 'never-existed', timeout: 0 },
          { appId: 'app-1', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });
  });

  describe('immediate (timeout=0)', () => {
    it('returns events when present without sleeping', async () => {
      await seedRender('render-1', 'app-1');
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({ type: 'click' }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      const start = Date.now();
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      // No long-poll wait when timeout=0.
      expect(Date.now() - start).toBeLessThan(500);
      expect(result.events).toHaveLength(1);
    });

    it('returns empty events + active status when buffer empty + timeout=0', async () => {
      await seedRender('render-1', 'app-1');
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(result.events).toEqual([]);
      expect(result.status).toBe('active');
    });
  });

  describe('long-poll', () => {
    it('returns events that arrive during the long-poll window', async () => {
      await seedRender('render-1', 'app-1');
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      // Schedule an append after 200ms (well inside the poll cadence).
      setTimeout(() => {
        void consumer.append('render-1', {
          id: 'evt-late',
          envelope: JSON.stringify({ type: 'submit' }),
          sequence: 1,
          createdAt: new Date().toISOString(),
        });
      }, 200);
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 5 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events[0].type).toBe('submit');
    });

    it('long-poll short-circuits when status flips to expired', async () => {
      await seedRender('render-1', 'app-1');
      consumer.markStatus('render-1', 'expired');
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      const start = Date.now();
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 5 },
        { appId: 'app-1', requestId: 'r1' },
      );
      // First fetchAndClearSafe sees status=expired → no long-poll wait.
      expect(Date.now() - start).toBeLessThan(500);
      expect(result.events).toEqual([]);
      expect(result.status).toBe('expired');
    });

    it('mid-poll render-disappeared returns expired status (no throw)', async () => {
      await seedRender('render-1', 'app-1');
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      // Drop the pipe mid-poll.
      setTimeout(() => {
        consumer.markDeleted('render-1');
      }, 200);
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 3 },
        { appId: 'app-1', requestId: 'r1' },
      );
      // PendingPipeNotFoundError mid-poll is converted to expired status.
      expect(result.status).toBe('expired');
      expect(result.events).toEqual([]);
    });
  });

  describe('event normalization', () => {
    it('object-shaped envelope passes through as ConsumeEventEntry', async () => {
      await seedRender('render-1', 'app-1');
      await consumer.append('render-1', {
        id: 'evt-obj',
        envelope: {
          type: 'action',
          renderId: 'render-1',
          intent: 'choose',
          actionData: { value: 'X' },
          uiContext: {},
          actionId: 'evt-obj',
          firedAt: '2026-04-19T00:00:00.000Z',
        },
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(result.events[0].intent).toBe('choose');
      expect(result.events[0].actionData).toEqual({ value: 'X' });
    });

    it('stringified-JSON envelope round-trips correctly', async () => {
      await seedRender('render-1', 'app-1');
      await consumer.append('render-1', {
        id: 'evt-str',
        envelope: JSON.stringify({
          type: 'action',
          renderId: 'render-1',
          intent: 'submit',
          actionData: { v: 1 },
          uiContext: {},
          actionId: 'evt-str',
          firedAt: '2026-04-19T00:00:00.000Z',
        }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(result.events[0].intent).toBe('submit');
      expect(result.events[0].actionData).toEqual({ v: 1 });
    });
  });

  describe('observer notifier seam', () => {
    it('fires only when events were actually returned', async () => {
      const calls: Parameters<ObserverNotifier['notifyToolCall']>[0][] = [];
      const observer: ObserverNotifier = {
        notifyToolCall: (args) => {
          calls.push(args);
        },
      };
      await seedRender('render-1', 'app-1');
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        observerNotifier: observer,
      });

      // Empty consume — no notify.
      await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(calls).toHaveLength(0);

      // Now seed an event and consume — should fire.
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({ type: 'submit' }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r2' },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].renderId).toBe('render-1');
      expect(calls[0].appId).toBe('app-1');
      expect(calls[0].tool).toBe('ggui_consume');
      expect(calls[0].result.eventCount).toBe(1);
      expect(calls[0].result.eventTypes).toEqual(['submit']);
    });

    it('handler works without observer (OSS default)', async () => {
      await seedRender('render-1', 'app-1');
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({ type: 'submit' }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(result.events).toHaveLength(1);
    });
  });

  describe('drain_ack notifier seam (Slice A5)', () => {
    it('fires sendDrainAck once per drained event', async () => {
      await seedRender('render-1', 'app-1');
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({ type: 'submit', payload: {} }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      await consumer.append('render-1', {
        id: 'evt-2',
        envelope: JSON.stringify({ type: 'submit', payload: {} }),
        sequence: 2,
        createdAt: new Date().toISOString(),
      });
      const sendDrainAck = vi.fn();
      const drainAckNotifier: DrainAckNotifier = { sendDrainAck };
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        drainAckNotifier,
      });
      await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(sendDrainAck).toHaveBeenCalledTimes(2);
      expect(sendDrainAck).toHaveBeenCalledWith(
        expect.objectContaining({
          renderId: 'render-1',
          appId: 'app-1',
          eventId: 'evt-1',
        }),
      );
      expect(sendDrainAck).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'evt-2' }),
      );
    });

    it('does not fire when no events are drained', async () => {
      await seedRender('render-1', 'app-1');
      const sendDrainAck = vi.fn();
      const drainAckNotifier: DrainAckNotifier = { sendDrainAck };
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        drainAckNotifier,
      });
      await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(sendDrainAck).not.toHaveBeenCalled();
    });

    it('absorbs notifier throws — drain still returns events', async () => {
      await seedRender('render-1', 'app-1');
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({ type: 'submit', payload: {} }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      const drainAckNotifier: DrainAckNotifier = {
        sendDrainAck: () => {
          throw new Error('subscriber gone');
        },
      };
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        drainAckNotifier,
      });
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(result.events).toHaveLength(1);
    });
  });

  describe('action_consume_slow telemetry (Slice A5)', () => {
    it('logs info-event when submit → drain latency exceeds 2s', async () => {
      await seedRender('render-1', 'app-1');
      // Stamp createdAt 3s in the past — past the yellow-flag threshold.
      const stale = new Date(Date.now() - 3_000).toISOString();
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({ type: 'submit', payload: {} }),
        sequence: 1,
        createdAt: stale,
      });
      const info = vi.fn();
      const logger: ConsumeLogger = { info };
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        logger,
      });
      await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(info).toHaveBeenCalledWith(
        'action_consume_slow',
        expect.objectContaining({
          renderId: 'render-1',
          appId: 'app-1',
          eventId: 'evt-1',
          thresholdMs: 2000,
        }),
      );
    });

    it('does NOT log when latency is under the threshold (healthy path)', async () => {
      await seedRender('render-1', 'app-1');
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({ type: 'submit', payload: {} }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      const info = vi.fn();
      const logger: ConsumeLogger = { info };
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        logger,
      });
      await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(info).not.toHaveBeenCalled();
    });
  });

  describe('activeConsumerRegistry enter/exit', () => {
    it('registers an active consumer for the duration of the call', async () => {
      await seedRender('render-1', 'app-1');
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({ type: 'submit', payload: {} }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      const registry = new InMemoryActiveConsumerRegistry();
      const enterSpy = vi.spyOn(registry, 'enter');
      const exitSpy = vi.spyOn(registry, 'exit');
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        activeConsumerRegistry: registry,
      });
      await handler.handler(
        { renderId: 'render-1', timeout: 0 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(enterSpy).toHaveBeenCalledWith('render-1');
      expect(exitSpy).toHaveBeenCalledWith('render-1');
      // Counts net to zero — no zombie entry after the call returns.
      expect(registry.hasActive('render-1')).toBe(false);
    });

    it('exits the registry even when the handler throws (GguiSessionNotFoundError)', async () => {
      // Tenancy mismatch surfaces as GguiSessionNotFoundError; enter MUST
      // still pair with exit so a long-poll-with-bad-tenancy can't
      // leave a sticky `hasActive: true` for that renderId.
      await seedRender('render-1', 'app-OWNER');
      const registry = new InMemoryActiveConsumerRegistry();
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        activeConsumerRegistry: registry,
      });
      await expect(
        handler.handler(
          { renderId: 'render-1', timeout: 0 },
          { appId: 'app-INTRUDER', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
      expect(registry.hasActive('render-1')).toBe(false);
    });

    it('surfaces hasActive:true to a concurrent observer during the long-poll', async () => {
      // The contract submit-action depends on: while consume is awaiting
      // an event mid-long-poll, hasActive MUST report true so a
      // concurrent submit-action append sees a "drainer is listening"
      // signal. Validate by entering the long-poll, polling hasActive
      // from outside, then appending an event to release it.
      await seedRender('render-1', 'app-1');
      const registry = new InMemoryActiveConsumerRegistry();
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        activeConsumerRegistry: registry,
      });
      const promise = handler.handler(
        { renderId: 'render-1', timeout: 5 },
        { appId: 'app-1', requestId: 'r1' },
      );
      // Yield once so the handler's body runs up through `enter()`.
      await new Promise((resolve) => setImmediate(resolve));
      expect(registry.hasActive('render-1')).toBe(true);
      // Drop an event so the long-poll resolves promptly.
      await consumer.append('render-1', {
        id: 'evt-1',
        envelope: JSON.stringify({ type: 'submit', payload: {} }),
        sequence: 1,
        createdAt: new Date().toISOString(),
      });
      await promise;
      expect(registry.hasActive('render-1')).toBe(false);
    });
  });

  describe('abort-aware long-poll (zombie-consumer kill)', () => {
    it('breaks the long-poll promptly when ctx.signal aborts mid-wait', async () => {
      // The zombie-consumer bug: when an agent's loop is aborted
      // (browser reload → agent-server SSE abort → SDK abort → MCP
      // `notifications/cancelled` / transport close), the consume
      // long-poll must STOP — not keep polling to its deadline holding
      // `hasActive: true`, which would suppress the recovery doorbell on
      // the user's post-reload gesture. With a 60s timeout the loop
      // would normally run for a full minute; aborting after the first
      // poll tick must release it in well under a second.
      await seedRender('render-1', 'app-1');
      const registry = new InMemoryActiveConsumerRegistry();
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        activeConsumerRegistry: registry,
      });
      const controller = new AbortController();
      const start = Date.now();
      const promise = handler.handler(
        { renderId: 'render-1', timeout: 60 },
        { appId: 'app-1', requestId: 'r1', signal: controller.signal },
      );
      // Yield so the handler runs up through `enter()` + into the loop.
      await new Promise((resolve) => setImmediate(resolve));
      expect(registry.hasActive('render-1')).toBe(true);
      // Abort mid-wait — the sleepUntilAbort race resolves immediately
      // rather than waiting out the 1.5s poll tick.
      controller.abort();
      const result = await promise;
      const elapsed = Date.now() - start;
      // (a) Returns PROMPTLY — far below the 60_000ms deadline AND below
      //     a single 1.5s poll tick (the mid-sleep abort short-circuit).
      expect(elapsed).toBeLessThan(1000);
      // (a') Clean empty result — no throw, no partial events; matches
      //      the fetchAndClearSafe empty-shape contract.
      expect(result.events).toEqual([]);
      expect(result.status).toBe('active');
      // (b) Registry released — a subsequent submit-action now reads
      //     hasActive:false and the iframe rings the recovery doorbell.
      expect(registry.hasActive('render-1')).toBe(false);
    });

    it('returns immediately without arming a poll tick when already aborted', async () => {
      // A signal that's already aborted before the loop body runs must
      // not park on a 1.5s sleep even once.
      await seedRender('render-1', 'app-1');
      const registry = new InMemoryActiveConsumerRegistry();
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
        activeConsumerRegistry: registry,
      });
      const controller = new AbortController();
      controller.abort();
      const start = Date.now();
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 60 },
        { appId: 'app-1', requestId: 'r1', signal: controller.signal },
      );
      expect(Date.now() - start).toBeLessThan(500);
      expect(result.events).toEqual([]);
      expect(result.status).toBe('active');
      expect(registry.hasActive('render-1')).toBe(false);
    });

    it('still long-polls normally when no signal is supplied', async () => {
      // Absent signal (in-process invocation) must preserve today's
      // behavior: the loop waits for an event up to the deadline.
      await seedRender('render-1', 'app-1');
      const handler = createGguiConsumeHandler({
        pendingEventConsumer: consumer,
        renderStore,
      });
      setTimeout(() => {
        void consumer.append('render-1', {
          id: 'evt-late',
          envelope: JSON.stringify({ type: 'submit' }),
          sequence: 1,
          createdAt: new Date().toISOString(),
        });
      }, 200);
      const result = await handler.handler(
        { renderId: 'render-1', timeout: 5 },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.events[0].type).toBe('submit');
    });
  });
});
