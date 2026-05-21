/**
 * Adapter tests — storage-side helpers for PendingEvent envelopes.
 *
 * `PendingEvent.envelope` carries the per-gesture {@link ConsumeEventEntry}
 * row written by `submit_action`'s `kind:"dispatch"` branch.
 * The only adapter left is {@link parsePendingEnvelope}, a shape-neutral
 * reader for stored envelope values (object or JSON-string).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ConsumeEventEntry, PendingEvent } from './types/mcp.js';
import { parsePendingEnvelope } from './envelope-adapters.js';

const sampleEntry: ConsumeEventEntry = {
  type: 'action',
  stackItemId: 'stk_abc',
  intent: 'submit',
  actionData: { x: 42 },
  uiContext: {},
  actionId: '12345678',
  firedAt: '2026-04-19T00:00:00.000Z',
};

describe('parsePendingEnvelope', () => {
  it('returns object input unchanged', () => {
    expect(parsePendingEnvelope(sampleEntry)).toBe(sampleEntry);
  });

  it('parses JSON-stringified input (AppSync a.json() read path)', () => {
    expect(parsePendingEnvelope(JSON.stringify(sampleEntry))).toEqual(sampleEntry);
  });
});

describe('GguiConsumeOutput canonical-surface lock', () => {
  it('events are ConsumeEventEntry[] — pipe shape written by submit_action', () => {
    type Output = import('./types/mcp.js').GguiConsumeOutput;
    expectTypeOf<Output['events'][number]>().toEqualTypeOf<ConsumeEventEntry>();
    expectTypeOf<Output['events'][number]>().toHaveProperty('intent');
    expectTypeOf<Output['events'][number]>().toHaveProperty('actionData');
    expectTypeOf<Output['events'][number]>().toHaveProperty('uiContext');
    expectTypeOf<Output['events'][number]>().toHaveProperty('actionId');
    expectTypeOf<Output['events'][number]>().toHaveProperty('firedAt');
    expect(true).toBe(true);
  });
});

describe('PendingEvent structural lock', () => {
  it('canonical shape: id + envelope + sequence + createdAt', () => {
    const row: PendingEvent = {
      id: 'evt_abc',
      envelope: sampleEntry,
      sequence: 7,
      createdAt: '2026-04-19T00:00:00.000Z',
    };
    expect(row.envelope).toBeDefined();
    expectTypeOf<PendingEvent['envelope']>().toEqualTypeOf<
      ConsumeEventEntry | string
    >();
    expectTypeOf<PendingEvent['sequence']>().toEqualTypeOf<number>();
  });

  it('PendingEvent keys are canonical four', () => {
    type PendingEventKeys = keyof PendingEvent;
    expectTypeOf<PendingEventKeys>().toEqualTypeOf<
      'id' | 'envelope' | 'sequence' | 'createdAt'
    >();
  });
});
