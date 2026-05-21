/**
 * `resolveStreamChannel` coverage — the helper's job is narrow, so
 * the tests stay narrow. Four groups:
 *
 *   - spec absent / channel absent → undefined (the two
 *     "nothing to enforce" cases).
 *   - every optional field omitted → DEFAULT_STREAM_* applied (this
 *     is the "single source of truth for defaults" property).
 *   - every optional field explicit → pass-through, no drift.
 *   - description / example are optional passthroughs.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveStreamChannel,
  type ResolvedStreamChannel,
} from './resolve-stream-channel.js';
import {
  DEFAULT_STREAM_CHANNEL_COMPLETE,
  DEFAULT_STREAM_CHANNEL_MODE,
  DEFAULT_STREAM_REPLAY_POLICY,
  type StreamSpec,
} from '../types/data-contract.js';

// ── Fixtures ────────────────────────────────────────────────────────

const BARE_SPEC: StreamSpec = {
  tick: {
    schema: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    },
  },
};

const DECORATED_SPEC: StreamSpec = {
  snapshot: {
    description: 'replace-mode current total',
    schema: {
      type: 'object',
      properties: { total: { type: 'number' } },
      required: ['total'],
    },
    example: { total: 42 },
    mode: 'replace',
    replay: 'latest',
    complete: true,
  },
};

// ── Absence cases ───────────────────────────────────────────────────

describe('resolveStreamChannel — absence cases', () => {
  it('returns undefined when spec is undefined', () => {
    expect(resolveStreamChannel(undefined, 'tick')).toBeUndefined();
  });

  it('returns undefined when channel is not declared', () => {
    expect(resolveStreamChannel(BARE_SPEC, 'unknown')).toBeUndefined();
  });
});

// ── Default application ─────────────────────────────────────────────

describe('resolveStreamChannel — DEFAULT_STREAM_* application', () => {
  it('applies DEFAULT_STREAM_CHANNEL_MODE when mode is omitted', () => {
    const resolved = resolveStreamChannel(BARE_SPEC, 'tick');
    expect(resolved).toBeDefined();
    expect(resolved!.mode).toBe(DEFAULT_STREAM_CHANNEL_MODE);
  });

  it('applies DEFAULT_STREAM_REPLAY_POLICY when replay is omitted', () => {
    const resolved = resolveStreamChannel(BARE_SPEC, 'tick');
    expect(resolved!.replay).toBe(DEFAULT_STREAM_REPLAY_POLICY);
  });

  it('applies DEFAULT_STREAM_CHANNEL_COMPLETE when complete is omitted', () => {
    const resolved = resolveStreamChannel(BARE_SPEC, 'tick');
    expect(resolved!.complete).toBe(DEFAULT_STREAM_CHANNEL_COMPLETE);
  });

  it('sets name from the lookup key', () => {
    const resolved = resolveStreamChannel(BARE_SPEC, 'tick');
    expect(resolved!.name).toBe('tick');
  });

  it('copies schema without mutation', () => {
    const resolved = resolveStreamChannel(BARE_SPEC, 'tick');
    expect(resolved!.schema).toBe(BARE_SPEC.tick!.schema);
  });

  it('omits description/example when absent on entry (not forced to null)', () => {
    const resolved = resolveStreamChannel(BARE_SPEC, 'tick');
    expect(resolved!).not.toHaveProperty('description');
    expect(resolved!).not.toHaveProperty('example');
  });
});

// ── Explicit pass-through ───────────────────────────────────────────

describe('resolveStreamChannel — explicit field pass-through', () => {
  it('passes through mode / replay / complete when set', () => {
    const resolved = resolveStreamChannel(DECORATED_SPEC, 'snapshot');
    expect(resolved!.mode).toBe('replace');
    expect(resolved!.replay).toBe('latest');
    expect(resolved!.complete).toBe(true);
  });

  it('passes through description + example when set', () => {
    const resolved = resolveStreamChannel(DECORATED_SPEC, 'snapshot');
    expect(resolved!.description).toBe('replace-mode current total');
    expect(resolved!.example).toEqual({ total: 42 });
  });

  it('ResolvedStreamChannel type exposes all expected fields', () => {
    const resolved = resolveStreamChannel(
      DECORATED_SPEC,
      'snapshot',
    ) as ResolvedStreamChannel;
    // Compile-time assertion — if the interface changed the field
    // names, this block would fail typecheck on the missing property.
    const {
      name,
      schema,
      mode,
      replay,
      complete,
      description,
      example,
    } = resolved;
    expect(name).toBe('snapshot');
    expect(schema).toBe(DECORATED_SPEC.snapshot!.schema);
    expect(mode).toBe('replace');
    expect(replay).toBe('latest');
    expect(complete).toBe(true);
    expect(description).toBe('replace-mode current total');
    expect(example).toEqual({ total: 42 });
  });
});

// ── Stability under repeated calls ──────────────────────────────────

describe('resolveStreamChannel — referential properties', () => {
  it('does not mutate the source spec on lookup', () => {
    const frozen: StreamSpec = Object.freeze({
      tick: Object.freeze({
        schema: Object.freeze({ type: 'object' as const }),
      }),
    });
    expect(() => resolveStreamChannel(frozen, 'tick')).not.toThrow();
  });

  it('returns a fresh object per call (no shared mutable state)', () => {
    const a = resolveStreamChannel(BARE_SPEC, 'tick');
    const b = resolveStreamChannel(BARE_SPEC, 'tick');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
