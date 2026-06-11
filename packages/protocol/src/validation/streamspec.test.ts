/**
 * streamSpec coverage — locks the post-rewrite shape.
 *
 * `StreamSpec.channels` is a map of named channels, each declaring a
 * payload `schema` plus optional runtime semantics (`mode` / `replay` /
 * `complete`). `validateStreamData` enforces the payload schema ONLY —
 * the semantics fields are declarations that consumers honor at their
 * own boundary, they never influence shape validation.
 *
 * See the design-lock block in `data-contract.ts` for the invariants
 * these tests encode.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  validateStreamData,
  validateContractStructure,
} from './contract-validator.js';
import {
  DEFAULT_STREAM_CHANNEL_COMPLETE,
  DEFAULT_STREAM_CHANNEL_MODE,
  DEFAULT_STREAM_REPLAY_POLICY,
  type DataContract,
  type StreamChannelEntry,
  type StreamChannelMode,
  type StreamReplayPolicy,
  type StreamSpec,
} from '../types/data-contract.js';

// ── Fixtures ────────────────────────────────────────────────────────

const SINGLE_CHANNEL_SPEC: StreamSpec = {
  tick: {
    description: 'append-mode counter channel',
    schema: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    },
  },
};

const MULTI_SEMANTIC_SPEC: StreamSpec = {
  tick: {
    schema: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    },
    mode: 'append',
    replay: 'latest',
    complete: false,
  },
  snapshot: {
    description: 'replace-mode single-latest-value rendering',
    schema: {
      type: 'object',
      properties: { total: { type: 'number' } },
      required: ['total'],
    },
    mode: 'replace',
    replay: 'latest',
  },
  finale: {
    description: 'completable channel with terminal marker opt-in',
    schema: {
      type: 'object',
      properties: { token: { type: 'string' } },
      required: ['token'],
    },
    mode: 'append',
    complete: true,
  },
};

// ── Locked defaults ─────────────────────────────────────────────────

describe('streamSpec — locked defaults', () => {
  it('exports DEFAULT_STREAM_CHANNEL_MODE = "append"', () => {
    expect(DEFAULT_STREAM_CHANNEL_MODE).toBe('append');
  });

  it('exports DEFAULT_STREAM_REPLAY_POLICY = "none"', () => {
    expect(DEFAULT_STREAM_REPLAY_POLICY).toBe('none');
  });

  it('exports DEFAULT_STREAM_CHANNEL_COMPLETE = false', () => {
    expect(DEFAULT_STREAM_CHANNEL_COMPLETE).toBe(false);
  });
});

// ── validateStreamData enforces payload schema on channels ─────────

describe('streamSpec — validateStreamData', () => {
  it('accepts matching payload on a declared channel', () => {
    const result = validateStreamData(
      'tick',
      { count: 7 },
      SINGLE_CHANNEL_SPEC,
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects undeclared channel names with channel-vocabulary error', () => {
    const result = validateStreamData('mystery', {}, SINGLE_CHANNEL_SPEC);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].field).toBe('channel');
    expect(result.violations[0].message).toContain("Unknown stream channel 'mystery'");
    expect(result.violations[0].message).toContain('Declared channels');
  });

  it('rejects payload-shape violations against channels[channel].schema', () => {
    const result = validateStreamData('tick', {}, SINGLE_CHANNEL_SPEC);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].field).toBe('tick.payload.count');
  });

  it('does not reject any semantics field — mode/replay/complete never affect validation', () => {
    expect(
      validateStreamData('snapshot', { total: 42 }, MULTI_SEMANTIC_SPEC).valid,
    ).toBe(true);
    expect(
      validateStreamData('snapshot', {}, MULTI_SEMANTIC_SPEC).valid,
    ).toBe(false);

    // Shape-equivalent spec w/o any semantics fields behaves identically.
    const schemaOnlySpec: StreamSpec = {
      snapshot: { schema: MULTI_SEMANTIC_SPEC.snapshot!.schema },
    };
    expect(
      validateStreamData('snapshot', { total: 42 }, schemaOnlySpec),
    ).toEqual(
      validateStreamData('snapshot', { total: 42 }, MULTI_SEMANTIC_SPEC),
    );
    expect(validateStreamData('snapshot', {}, schemaOnlySpec)).toEqual(
      validateStreamData('snapshot', {}, MULTI_SEMANTIC_SPEC),
    );
  });

  describe('reserved-channel bypass', () => {
    // `_ggui:*` is the server-owned namespace. Agents can't declare
    // them in streamSpec (enforced by `validateContractStructure`), but
    // the runtime emits on them (e.g. `_ggui:preview` for provisional
    // A2UI assembly). Without a bypass here, every such delivery into
    // a render whose active render carries any user streamSpec
    // would synthesize a false "Unknown stream channel" violation and
    // block the preview pipeline — this test pins the symmetry with
    // the declaration-side rejection + the client-side bypass in
    // `GguiRender`.
    it('passes a reserved channel name even when spec declares unrelated channels', () => {
      const result = validateStreamData(
        '_ggui:preview',
        { anything: 'goes' },
        SINGLE_CHANNEL_SPEC,
      );
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('REJECTS unrecognized reserved-prefix channel names (F10 closed-set)', () => {
      // Pre-F10 this test asserted the bypass covered ANY `_ggui:*`
      // name, which silently swallowed typos (`_ggui:preveiw`) and
      // hypothetical-future names the runtime didn't actually emit
      // on. F10 tightened the bypass to a closed set:
      // KNOWN_RESERVED_CHANNELS ({PREVIEW_CHANNEL, LIFECYCLE_CHANNEL}).
      // Anything else in
      // the reserved namespace falls through to normal
      // "Unknown stream channel" rejection so the bug surfaces at
      // the emission site instead of the receiver.
      const result = validateStreamData(
        '_ggui:future-server-channel',
        { shape: 'unvalidated' },
        SINGLE_CHANNEL_SPEC,
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].field).toBe('channel');
      expect(result.violations[0].message).toContain('Unknown stream channel');
    });

    it('REJECTS typos inside the reserved namespace (F10 closed-set)', () => {
      // Load-bearing F10 guarantee — `_ggui:preveiw` is NOT
      // recognized, so the typo is surfaced as an unknown-channel
      // violation at the validator boundary.
      const result = validateStreamData(
        '_ggui:preveiw',
        {},
        SINGLE_CHANNEL_SPEC,
      );
      expect(result.valid).toBe(false);
      expect(result.violations[0].field).toBe('channel');
    });

    it('passes reserved channel even with a null / undefined payload', () => {
      // Matches the runner's terminal `{payload: null, complete: true}`
      // envelope — the bypass must hold even when there's literally
      // no payload to schema-check.
      const nullResult = validateStreamData(
        '_ggui:preview',
        null,
        SINGLE_CHANNEL_SPEC,
      );
      expect(nullResult.valid).toBe(true);
      const undefResult = validateStreamData(
        '_ggui:preview',
        undefined,
        SINGLE_CHANNEL_SPEC,
      );
      expect(undefResult.valid).toBe(true);
    });

    it('non-reserved channel starting with underscore still hits the declared-channel check', () => {
      // Guard against someone collapsing the bypass to a looser prefix.
      // `_internal` isn't in the `_ggui:` namespace and therefore does
      // NOT bypass — it's a genuinely undeclared channel, so validation
      // should produce the ordinary "Unknown stream channel" violation.
      const result = validateStreamData(
        '_internal',
        {},
        SINGLE_CHANNEL_SPEC,
      );
      expect(result.valid).toBe(false);
      expect(result.violations[0].message).toContain(
        "Unknown stream channel '_internal'",
      );
    });
  });
});

// ── validateContractStructure walks channels ───────────────────────

describe('streamSpec — validateContractStructure', () => {
  it('accepts a contract with all semantics fields set on channels', () => {
    const contract: DataContract = {
      streamSpec: MULTI_SEMANTIC_SPEC,
    };
    const result = validateContractStructure(contract);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('reports channel vocabulary in error field when a channel omits its schema', () => {
    const contract: DataContract = {
      streamSpec: {
        broken: {
          // schema missing — required field, error must reference the channel path.
          mode: 'append',
        } as unknown as StreamChannelEntry,
      },
    };
    const result = validateContractStructure(contract);
    expect(result.valid).toBe(false);
    expect(
      result.violations.some(
        (v) => v.field === 'streamSpec.broken' && v.message.includes("Stream channel 'broken'"),
      ),
    ).toBe(true);
  });
});

// ── Type-level smoke ────────────────────────────────────────────────

describe('streamSpec — type-level smoke', () => {
  it('narrows mode / replay to declared literal unions', () => {
    expectTypeOf<StreamChannelMode>().toEqualTypeOf<'append' | 'replace'>();
    expectTypeOf<StreamReplayPolicy>().toEqualTypeOf<'latest' | 'all' | 'none'>();
  });

  it('StreamChannelEntry accepts semantics fields', () => {
    const entry: StreamChannelEntry = {
      schema: { type: 'object' },
      mode: 'replace',
      replay: 'latest',
      complete: true,
    };
    expect(entry.mode).toBe('replace');
    expect(entry.replay).toBe('latest');
    expect(entry.complete).toBe(true);
  });

  it('StreamChannelEntry accepts schema-only entries (semantics optional)', () => {
    const entry: StreamChannelEntry = {
      schema: { type: 'object' },
    };
    expect(entry.mode).toBeUndefined();
    expect(entry.replay).toBeUndefined();
    expect(entry.complete).toBeUndefined();
  });
});
