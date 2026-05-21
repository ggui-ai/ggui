import { describe, it, expect } from 'vitest';
import { DEFAULT_SUBSCRIPTION, type EventSubscription } from '@ggui-ai/protocol';
import { assertEventAllowed } from './assert-event-allowed.js';
import { EventNotAllowedError } from './errors.js';

describe('assertEventAllowed', () => {
  describe('default subscription fallback (undefined subscription)', () => {
    it('allows data:submit (in protocol DEFAULT_SUBSCRIPTION)', () => {
      expect(() => assertEventAllowed(undefined, 'data:submit')).not.toThrow();
    });

    it('allows lifecycle:session_end (in protocol DEFAULT_SUBSCRIPTION)', () => {
      expect(() => assertEventAllowed(undefined, 'lifecycle:session_end')).not.toThrow();
    });

    it('rejects interaction:click under default subscription', () => {
      expect(() => assertEventAllowed(undefined, 'interaction:click')).toThrow(
        EventNotAllowedError,
      );
    });

    it('rejects unknown event type under default subscription', () => {
      expect(() => assertEventAllowed(undefined, 'ext:something')).toThrow(EventNotAllowedError);
    });

    it('error carries the default allowed list for client debugging', () => {
      try {
        assertEventAllowed(undefined, 'interaction:click');
        throw new Error('should have thrown');
      } catch (e) {
        if (e instanceof EventNotAllowedError) {
          expect(e.allowedEvents).toEqual(DEFAULT_SUBSCRIPTION.events);
        } else {
          throw e;
        }
      }
    });
  });

  describe('explicit subscription', () => {
    const NARROW: EventSubscription = { events: ['data:submit'] };

    it('allows a declared event', () => {
      expect(() => assertEventAllowed(NARROW, 'data:submit')).not.toThrow();
    });

    it('rejects an event that DEFAULT_SUBSCRIPTION allows but the narrow list does not', () => {
      // lifecycle:session_end is in DEFAULT but not in NARROW — the explicit
      // list wins; DEFAULT isn't a floor.
      expect(() => assertEventAllowed(NARROW, 'lifecycle:session_end')).toThrow(
        EventNotAllowedError,
      );
    });

    it('rejects an undeclared event with tool-specific envelope shape', () => {
      try {
        assertEventAllowed(NARROW, 'interaction:click');
        throw new Error('should have thrown');
      } catch (e) {
        if (e instanceof EventNotAllowedError) {
          expect(e.eventType).toBe('interaction:click');
          expect(e.allowedEvents).toEqual(['data:submit']);
          expect(e.message).toContain('interaction:click');
          expect(e.message).toContain('data:submit');
        } else {
          throw e;
        }
      }
    });

    it('empty events list rejects everything with (none) in message', () => {
      try {
        assertEventAllowed({ events: [] }, 'data:submit');
        throw new Error('should have thrown');
      } catch (e) {
        if (e instanceof EventNotAllowedError) {
          expect(e.message).toContain('(none)');
        } else {
          throw e;
        }
      }
    });
  });

  describe('EventNotAllowedError envelope', () => {
    it('toErrorData returns wire-safe {error, eventType, allowedEvents} shape', () => {
      try {
        assertEventAllowed({ events: ['data:submit'] }, 'error:validation');
        throw new Error('should have thrown');
      } catch (e) {
        if (e instanceof EventNotAllowedError) {
          const data = e.toErrorData();
          expect(data).toEqual({
            error: 'event_not_allowed',
            eventType: 'error:validation',
            allowedEvents: ['data:submit'],
          });
          // Explicit mutability assertion — ensures wire-layer assignment
          // to `ErrorPayload.details: JsonValue` doesn't need a cast
          // (readonly arrays aren't structurally assignable to JsonValue[]).
          expect(Array.isArray(data.allowedEvents)).toBe(true);
          // Pushing onto the returned array must succeed (mutable copy).
          data.allowedEvents.push('data:change');
          expect(e.allowedEvents).not.toContain('data:change');
        } else {
          throw e;
        }
      }
    });
  });
});
