/**
 * Stability tests for `hashContract`.
 *
 * `hashContract` is a **cache identity**: two contracts that hash to the
 * same value are treated as the same generated component. Any change to
 * the hash breaks every live cache entry in prod (S3 Vectors, the
 * private pool, warm blueprint caches) and causes silent
 * regenerate-on-next-push storms. So the contract is pinned three ways:
 *
 * 1. **Goldens** — exact hash strings for canonical shapes. These are
 *    the literal bytes stored in DDB `contractHash` columns and the
 *    RAG key in S3 Vectors today; changing them is a production
 *    migration event, not a code cleanup.
 * 2. **Invariants** — "only intent contributes to the hash" is the
 *    cache-identity contract today (the legacy `interaction` field on
 *    `DataContract` was retired in pre-launch cleanup; the four-spec
 *    surface — props/action/context/stream — describes the wire
 *    exhaustively, and none of those fields perturb the hash either).
 * 3. **Canonicalization** — RFC 8785 key-ordering + number-normalization
 *    is what makes two semantically-equal contracts collide. Exercise
 *    the boundaries that historically drift (prop order, +0/−0,
 *    undefined stripping).
 *
 * If one of these tests fails on a seemingly-innocent refactor, that is
 * the signal to STOP and bump a protocol version — do not "fix" the
 * golden unless you are intentionally invalidating every cache.
 *
 * `hashContract` takes `(contract, intent)` because `DataContract`
 * does not carry an `intent` field — the outer pipeline owns intent
 * (`story.intent` on `ggui_push`, the operator prompt for harness
 * benchmarks).
 */

import { describe, it, expect } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { hashContract, buildVariant } from './contract-hash.js';

describe('hashContract — goldens', () => {
  it('pins the weather-card canonical hash', () => {
    const contract: DataContract = {};
    const intent = 'Display current weather conditions for a quick daily check';
    expect(hashContract(contract, intent)).toBe('ch_96066bf30d1db334');
  });

  it('pins the survey-form canonical hash', () => {
    const contract: DataContract = {};
    const intent = 'Collect user feedback via a multi-field survey form';
    expect(hashContract(contract, intent)).toBe('ch_97110aa97816f5ec');
  });

  it('pins the stock-ticker canonical hash', () => {
    const contract: DataContract = {};
    const intent = 'Show real-time stock prices with live updates';
    expect(hashContract(contract, intent)).toBe('ch_7fe1d2e60a37aa9d');
  });

  it('pins the degenerate-input hash (documentary)', () => {
    // hashContract is defensive against malformed input: a caller that
    // passes an empty contract AND an empty intent still gets a stable
    // hash. The empty `{}` canonical input collides predictably.
    expect(hashContract({} as DataContract, '')).toBe('ch_44136fa355b3678a');
  });

  it('always emits the ch_ prefix + 16 lowercase hex chars', () => {
    const h = hashContract({}, 'x');
    expect(h).toMatch(/^ch_[0-9a-f]{16}$/);
  });
});

describe('hashContract — invariants (only intent contributes)', () => {
  const base: DataContract = {};
  const baseIntent = 'Display current weather conditions for a quick daily check';
  const baseHash = 'ch_96066bf30d1db334';

  it('props do NOT perturb the hash', () => {
    const withProps: DataContract = {
      ...base,
      propsSpec: {
        properties: {
          city: {
            description: 'city',
            schema: { type: 'string' },
            required: true,
          },
        },
      },
    };
    expect(hashContract(withProps, baseIntent)).toBe(baseHash);
  });

  it('actions do NOT perturb the hash', () => {
    const withActions: DataContract = {
      ...base,
      actionSpec: {
        refresh: { label: 'Refresh' },
      },
    };
    expect(hashContract(withActions, baseIntent)).toBe(baseHash);
  });

  it('stream blocks (including per-channel source) do NOT perturb the hash', () => {
    const withStream: DataContract = {
      ...base,
      streamSpec: {
        temperature: {
          description: 'temp',
          schema: { type: 'number' },
          source: { tool: 'weather_fetch', args: { interval: 30 } },
        },
      },
    };
    expect(hashContract(withStream, baseIntent)).toBe(baseHash);
  });

  it('all irrelevant fields combined do NOT perturb the hash', () => {
    const maximal: DataContract = {
      ...base,
      propsSpec: { properties: { city: { description: 'c', schema: { type: 'string' } } } },
      actionSpec: { refresh: { label: 'R' } },
      streamSpec: {
        t: { description: 't', schema: { type: 'number' }, source: { tool: 'w' } },
      },
    };
    expect(hashContract(maximal, baseIntent)).toBe(baseHash);
  });

  it('intent change produces a DIFFERENT hash', () => {
    expect(hashContract(base, 'Display weather for Tokyo')).not.toBe(baseHash);
  });
});

describe('hashContract — canonicalization stability', () => {
  it('stable across construction (empty contracts collide regardless of authored shape)', () => {
    const a = hashContract(
      {},
      'Display current weather conditions for a quick daily check',
    );
    const b = hashContract(
      {} as DataContract,
      'Display current weather conditions for a quick daily check',
    );
    expect(a).toBe(b);
  });

  it('stable when extra ignored fields are present in any order', () => {
    const a = hashContract(
      {
        propsSpec: { properties: {} },
      },
      'x',
    );
    const b = hashContract(
      {
        propsSpec: { properties: {} },
      } as DataContract,
      'x',
    );
    expect(a).toBe(b);
  });

  it('identical across repeated calls (determinism)', () => {
    const c: DataContract = {};
    const hashes = Array.from({ length: 10 }, () => hashContract(c, 'x'));
    expect(new Set(hashes).size).toBe(1);
  });

  it('whitespace + unicode + emoji in intent are preserved (not normalized)', () => {
    // Documentary: the hash deliberately does NOT collapse whitespace or
    // normalize unicode. An agent that emits "Show weather " with a
    // trailing space gets a DIFFERENT cache key from "Show weather".
    // That is the current behavior; any future normalization is a
    // protocol migration, not a transparent fix.
    const a = hashContract({}, 'Show weather');
    const b = hashContract({}, 'Show weather ');
    const c = hashContract({}, 'Show weather  🌤️');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});

describe('buildVariant', () => {
  it('builds default variant when no args', () => {
    expect(buildVariant()).toBe('universal:universal');
  });

  it('builds shell-only variant', () => {
    expect(buildVariant('fullscreen')).toBe('fullscreen:universal');
  });

  it('builds device-only variant', () => {
    expect(buildVariant(undefined, 'mobile')).toBe('universal:mobile');
  });

  it('builds full variant', () => {
    expect(buildVariant('chat', 'desktop')).toBe('chat:desktop');
  });
});
