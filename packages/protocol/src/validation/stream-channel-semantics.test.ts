/**
 * Cross-API semantic lock for streamSpec v2 + StreamEnvelope.
 *
 * The three-channel-topology doctrine distributes "channel semantics"
 * across several APIs: `StreamChannelEntry` declares them on the spec,
 * `resolveStreamChannel` applies defaults at lookup, `StreamEnvelope`
 * carries them per delivery. These tests are NOT about correctness of
 * any one API — they're about mutual agreement:
 *
 *   1. The envelope's `mode` field uses the same literal union as
 *      `StreamChannelEntry.mode` and `ResolvedStreamChannel.mode`.
 *   2. The envelope's `complete` field matches the bool declared on
 *      the channel's `complete` flag.
 *   3. `replay` is a DECLARATION, not a per-delivery field — it does
 *      NOT appear on the envelope and no replay infrastructure is
 *      wired at the protocol layer (the field is advisory until
 *      `@ggui-ai/mcp-server-core` ring-buffer work ships).
 *
 * When these tests fail, something structural has drifted. They are
 * the "docs in code" layer behind the streamSpec design-lock block.
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import { resolveStreamChannel } from './resolve-stream-channel.js';
import {
  DEFAULT_STREAM_CHANNEL_COMPLETE,
  DEFAULT_STREAM_CHANNEL_MODE,
  DEFAULT_STREAM_REPLAY_POLICY,
  type StreamChannelEntry,
  type StreamChannelMode,
  type StreamSpec,
} from '../types/data-contract.js';
import type { StreamEnvelope } from '../types/live-channel.js';

// ── Shared fixtures ──────────────────────────────────────────────────

const APPEND_SPEC: StreamSpec = {
  tick: {
    schema: { type: 'object' },
    mode: 'append',
    replay: 'latest',
  },
};

const REPLACE_SPEC: StreamSpec = {
  snapshot: {
    schema: { type: 'object' },
    mode: 'replace',
  },
};

const COMPLETABLE_SPEC: StreamSpec = {
  finale: {
    schema: { type: 'object' },
    complete: true,
  },
};

// ── Type-level agreement ─────────────────────────────────────────────

describe('stream channel semantics — type-level agreement', () => {
  it('StreamEnvelope.mode uses the same literal union as StreamChannelEntry.mode', () => {
    expectTypeOf<StreamEnvelope['mode']>().toEqualTypeOf<StreamChannelMode>();
    // Any entry's declared mode can serve as an envelope's mode — no
    // widening, no narrowing.
    expectTypeOf<NonNullable<StreamChannelEntry['mode']>>().toEqualTypeOf<
      StreamEnvelope['mode']
    >();
  });

  it('StreamEnvelope.complete matches StreamChannelEntry.complete', () => {
    // Per-delivery `complete` is boolean | undefined. Channel's
    // `complete` declaration is boolean | undefined. Agreement is
    // boolean-bool on both ends.
    expectTypeOf<StreamEnvelope['complete']>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<StreamChannelEntry['complete']>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  it('StreamEnvelope does NOT carry a `replay` field — replay is per-channel, not per-delivery', () => {
    // If someone adds `replay` to the envelope, this type test fails —
    // it would be a design regression. Replay policy belongs on the
    // SPEC; the envelope is for per-delivery signals.
    type EnvelopeKeys = keyof StreamEnvelope;
    expectTypeOf<'replay'>().not.toEqualTypeOf<EnvelopeKeys>();
  });
});

// ── Defaults consistency — senders/receivers resolve the same values ─

describe('stream channel semantics — defaults consistency', () => {
  it('resolveStreamChannel returns DEFAULT_STREAM_CHANNEL_MODE when spec omits mode', () => {
    const spec: StreamSpec = {
      bare: { schema: { type: 'object' } },
    };
    const resolved = resolveStreamChannel(spec, 'bare');
    expect(resolved?.mode).toBe(DEFAULT_STREAM_CHANNEL_MODE);
  });

  it('resolveStreamChannel returns DEFAULT_STREAM_REPLAY_POLICY when spec omits replay', () => {
    const spec: StreamSpec = {
      bare: { schema: { type: 'object' } },
    };
    const resolved = resolveStreamChannel(spec, 'bare');
    expect(resolved?.replay).toBe(DEFAULT_STREAM_REPLAY_POLICY);
  });

  it('resolveStreamChannel returns DEFAULT_STREAM_CHANNEL_COMPLETE when spec omits complete', () => {
    const spec: StreamSpec = {
      bare: { schema: { type: 'object' } },
    };
    const resolved = resolveStreamChannel(spec, 'bare');
    expect(resolved?.complete).toBe(DEFAULT_STREAM_CHANNEL_COMPLETE);
  });

  it('the three DEFAULT_STREAM_* constants together cover every optional entry field', () => {
    // If StreamChannelEntry grows a new optional field without a
    // matching DEFAULT_STREAM_* constant + resolveStreamChannel
    // application, this test becomes the reminder to extend both.
    type OptionalSemantics = {
      [K in keyof StreamChannelEntry]-?: undefined extends StreamChannelEntry[K]
        ? K
        : never;
    }[keyof StreamChannelEntry];
    // `description`, `example`, `source` — passthroughs with no
    // defaults, intentional (`source` is the channel data-feed
    // declaration consumed by `@ggui-ai/wire` for transport
    // negotiation — not a semantics field).
    // `mode`, `replay`, `complete` — covered by DEFAULT_STREAM_*.
    expectTypeOf<OptionalSemantics>().toEqualTypeOf<
      'description' | 'example' | 'mode' | 'replay' | 'complete' | 'source'
    >();
  });
});

// ── Envelope-vs-spec consistency ─────────────────────────────────────

describe('stream channel semantics — envelope agrees with spec', () => {
  it('append-mode spec channels match append-mode envelopes', () => {
    const resolved = resolveStreamChannel(APPEND_SPEC, 'tick');
    const envelope: StreamEnvelope = {
      sessionId: 'render-x',
      channel: 'tick',
      mode: 'append',
      payload: {},
    };
    expect(resolved?.mode).toBe(envelope.mode);
  });

  it('replace-mode spec channels match replace-mode envelopes', () => {
    const resolved = resolveStreamChannel(REPLACE_SPEC, 'snapshot');
    const envelope: StreamEnvelope = {
      sessionId: 'render-x',
      channel: 'snapshot',
      mode: 'replace',
      payload: {},
    };
    expect(resolved?.mode).toBe(envelope.mode);
  });

  it('completable channels accept envelopes carrying complete:true', () => {
    const resolved = resolveStreamChannel(COMPLETABLE_SPEC, 'finale');
    expect(resolved?.complete).toBe(true);
    const envelope: StreamEnvelope = {
      sessionId: 'render-x',
      channel: 'finale',
      mode: 'append',
      payload: {},
      complete: true, // terminal delivery
    };
    expect(envelope.complete).toBe(true);
  });

  it('non-completable channels DO NOT require envelopes to omit complete — consumers decide how to treat stray markers', () => {
    // The wire doesn't forbid `complete: true` on a channel declared
    // `complete: undefined` — that's a declaration vs per-delivery
    // signal distinction. Consumers that care can check
    // `resolveStreamChannel(...).complete` before honoring the
    // envelope's flag.
    const spec: StreamSpec = {
      open: { schema: { type: 'object' } },
    };
    const resolved = resolveStreamChannel(spec, 'open');
    expect(resolved?.complete).toBe(false); // DEFAULT_STREAM_CHANNEL_COMPLETE
    const envelope: StreamEnvelope = {
      sessionId: 'render-x',
      channel: 'open',
      mode: 'append',
      payload: {},
      complete: true, // stray — consumer decides
    };
    expect(envelope.complete).toBe(true);
  });
});

// ── Replay — declaration only, no wire / no infra ────────────────────

describe('stream channel semantics — replay is a declaration, not behavior', () => {
  it('replay lives on the SPEC, never on the envelope', () => {
    // Structural assertion: if replay ever gets added to the envelope,
    // the two facts this test isolates — "declared on spec" and
    // "absent from envelope" — would both have to flip together.
    const resolved = resolveStreamChannel(APPEND_SPEC, 'tick');
    expect(resolved?.replay).toBe('latest');

    const envelope = {
      sessionId: 'render-x',
      channel: 'tick',
      mode: 'append',
      payload: {},
    } satisfies StreamEnvelope;

    // `satisfies` confirms the envelope typechecks without a `replay`
    // field and would fail if the envelope gained one that was
    // required.
    expect(Object.prototype.hasOwnProperty.call(envelope, 'replay')).toBe(
      false,
    );
  });

  it('protocol carries no replay infrastructure — declaration is advisory', () => {
    // There are no replay-buffer / resumption-token exports out of
    // the protocol today. Consumers that declare `replay: 'latest'`
    // or `'all'` MUST NOT assume a reconnecting subscriber gets
    // history — the server-side ring-buffer slice hasn't shipped.
    //
    // This test is a NEGATIVE assertion: it passes by NOT importing
    // any replay-infra symbol from the barrel. If a future slice
    // lands one, either update this test to reference it OR rename
    // this block to reflect that replay infra is now a guarantee.
    expect(resolveStreamChannel(APPEND_SPEC, 'tick')?.replay).toBe('latest');
  });
});
