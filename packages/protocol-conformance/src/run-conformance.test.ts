/**
 * Runner unit tests — the fixture-directive validating narrower, the
 * input-envelope dispatch classifier, the session-state grading seam,
 * and the WS-endpoint derivation. Pure unit-level: no transport, no
 * server; hosts are in-memory mocks.
 *
 * `parseSetupStep` / `parseInputEnvelope` are the seams where the
 * closed vocabularies are enforced: every directive / dispatchable
 * envelope the shipped catalog authors MUST parse, and unknown /
 * malformed ones MUST throw a descriptive fixture-authoring error
 * (never a silent skip). The parse-the-whole-catalog cases double as
 * the drift-catch between the fixture JSON and the authored unions.
 *
 * `matchSessionState` is the kit's third grading mechanism — a
 * post-observation-window GguiSession-field read-back via
 * `ConformanceHost.readSessionField`. The pass / fail / absent-host /
 * absent-method / throwing-read verdicts are pinned here with mock
 * hosts.
 */
import { describe, expect, it } from 'vitest';

import type { ConformanceHost } from './conformance-host.js';
import { allFixtures } from './fixtures/index.js';
import {
  deriveWsUrl,
  matchSessionState,
  parseInputEnvelope,
  parseSetupStep,
} from './run-conformance.js';

describe('parseSetupStep — the shipped catalog parses against the closed union', () => {
  it('every setup directive of every fixture parses', () => {
    for (const fixture of allFixtures) {
      for (const step of fixture.setup) {
        const parsed = parseSetupStep(fixture.name, step);
        expect(typeof parsed.kind).toBe('string');
      }
    }
  });

  it('no fixture authors a teardown directive (the teardown vocabulary is empty)', () => {
    for (const fixture of allFixtures) {
      expect(fixture.teardown === undefined || fixture.teardown.length === 0).toBe(true);
    }
  });

  it('translates the JSON `type` discriminator to the host `kind` discriminator verbatim', () => {
    const parsed = parseSetupStep('t', {
      type: 'create-session',
      sessionId: 'rnd-1',
      actionSpec: { toggleTask: {} },
    });
    expect(parsed).toEqual({
      kind: 'create-session',
      sessionId: 'rnd-1',
      actionSpec: { toggleTask: {} },
    });
  });

  it('preserves the fixture-authored field names on the override directives', () => {
    expect(
      parseSetupStep('t', {
        type: 'server-version-override',
        sessionId: 'rnd-1',
        advertiseVersion: '99.99-unsupported',
      }),
    ).toEqual({
      kind: 'server-version-override',
      sessionId: 'rnd-1',
      advertiseVersion: '99.99-unsupported',
    });
    expect(
      parseSetupStep('t', {
        type: 'ui-initialize-response-override',
        sessionId: 'rnd-1',
        override: { toolOutput: { _meta: { ggui: {} } } },
      }),
    ).toEqual({
      kind: 'ui-initialize-response-override',
      sessionId: 'rnd-1',
      override: { toolOutput: { _meta: { ggui: {} } } },
    });
  });
});

describe('parseSetupStep — unknown / malformed directives throw fixture-authoring errors', () => {
  it('throws on an unknown directive type, naming the closed vocabulary', () => {
    // The closed union makes a typo'd directive a compile-time error
    // for TS authors; the JSON catalog enters through a cast, so the
    // runtime parse (typed `unknown` — it IS the trust boundary) is
    // the enforcement seam.
    const typo = { type: 'seed-channel', sessionId: 'rnd-1', channel: 'c', value: 1 };
    expect(() => parseSetupStep('fixture-x', typo)).toThrowError(
      /unknown setup directive type='seed-channel'.*create-session/s,
    );
  });

  it('throws when a required string field is missing', () => {
    const missingUrl = { type: 'renderer-url-override', sessionId: 'rnd-1' };
    expect(() => parseSetupStep('fixture-x', missingUrl)).toThrowError(
      /'url' must be a non-empty string/,
    );
  });

  it('throws when server-version-override authors the wrong field name', () => {
    // `version` was a host-facing alias once tolerated by the
    // reference host's dual-read; the fixture-authored name
    // `advertiseVersion` is canonical and the only accepted spelling.
    const wrongName = {
      type: 'server-version-override',
      sessionId: 'rnd-1',
      version: '99.99',
    };
    expect(() => parseSetupStep('fixture-x', wrongName)).toThrowError(
      /'advertiseVersion' must be a non-empty string/,
    );
  });

  it('throws when emit-envelope omits the payload body', () => {
    const noPayload = { type: 'emit-envelope', channel: '_ggui:props' };
    expect(() => parseSetupStep('fixture-x', noPayload)).toThrowError(
      /missing the 'payload' envelope body/,
    );
  });

  it('throws on a non-object step', () => {
    expect(() => parseSetupStep('fixture-x', 'create-session')).toThrowError(
      /malformed setup directive/,
    );
  });
});

describe('parseInputEnvelope — the closed input-envelope dispatch vocabulary', () => {
  it('every shipped fixture inputEnvelope parses (drift-catch)', () => {
    for (const fixture of allFixtures) {
      const dispatch = parseInputEnvelope(fixture.name, fixture.inputEnvelope);
      expect(['action', 'host_context_observed', 'none']).toContain(dispatch.kind);
    }
  });

  it('classifies an action envelope for verbatim dispatch', () => {
    const envelope = {
      type: 'action',
      requestId: 'action-req-1',
      payload: { sessionId: 'rnd-1', type: 'data:submit', payload: { action: 'save' } },
    };
    const dispatch = parseInputEnvelope('t', envelope);
    expect(dispatch.kind).toBe('action');
    if (dispatch.kind !== 'action') return;
    // Verbatim — the kit never pre-validates the action body; the
    // server's recognition/rejection path is what's under test.
    expect(dispatch.envelope).toBe(envelope);
  });

  it('classifies a well-formed host_context_observed envelope into the typed arm', () => {
    const dispatch = parseInputEnvelope('t', {
      type: 'host_context_observed',
      payload: {
        sessionId: 'rnd-hc-1',
        hostContext: {
          availableDisplayModes: ['inline', 'pip', 'fullscreen'],
          currentDisplayMode: 'inline',
          containerDimensions: { maxWidth: 720, height: 480 },
          platform: 'web',
          deviceCapabilities: { touch: false, hover: true },
          locale: 'en-US',
          timeZone: 'America/Los_Angeles',
        },
      },
    });
    expect(dispatch.kind).toBe('host_context_observed');
    if (dispatch.kind !== 'host_context_observed') return;
    expect(dispatch.envelope).toEqual({
      type: 'host_context_observed',
      payload: {
        sessionId: 'rnd-hc-1',
        hostContext: {
          availableDisplayModes: ['inline', 'pip', 'fullscreen'],
          currentDisplayMode: 'inline',
          containerDimensions: { maxWidth: 720, height: 480 },
          platform: 'web',
          deviceCapabilities: { touch: false, hover: true },
          locale: 'en-US',
          timeZone: 'America/Los_Angeles',
        },
      },
    });
  });

  it('accepts an empty hostContext projection (every field is optional)', () => {
    const dispatch = parseInputEnvelope('t', {
      type: 'host_context_observed',
      payload: { sessionId: 'rnd-hc-1', hostContext: {} },
    });
    expect(dispatch.kind).toBe('host_context_observed');
  });

  it('does not dispatch non-C→S envelope types (render is driven by the subscribe)', () => {
    expect(
      parseInputEnvelope('t', { type: 'render', sessionId: 'test-r1', resource: {} }).kind,
    ).toBe('none');
    expect(parseInputEnvelope('t', 'not-an-object').kind).toBe('none');
    expect(parseInputEnvelope('t', null).kind).toBe('none');
  });

  it('throws when payload.sessionId is missing', () => {
    expect(() =>
      parseInputEnvelope('fixture-x', {
        type: 'host_context_observed',
        payload: { hostContext: {} },
      }),
    ).toThrowError(/'payload\.sessionId' must be a non-empty string/);
  });

  it('throws when hostContext is not an object', () => {
    expect(() =>
      parseInputEnvelope('fixture-x', {
        type: 'host_context_observed',
        payload: { sessionId: 'rnd-hc-1', hostContext: 'inline' },
      }),
    ).toThrowError(/'payload\.hostContext' must be an object/);
  });

  it("throws on a key outside the live HostContextProjection (the retired 'theme' field)", () => {
    // Theme flows through ggui's theming pipeline, not host context —
    // a fixture authoring it would assert state no conformant server
    // is obligated to read back.
    expect(() =>
      parseInputEnvelope('fixture-x', {
        type: 'host_context_observed',
        payload: {
          sessionId: 'rnd-hc-1',
          hostContext: { currentDisplayMode: 'inline', theme: 'light' },
        },
      }),
    ).toThrowError(/unknown key 'theme'.*availableDisplayModes, currentDisplayMode/s);
  });

  it('throws when a recognized hostContext field carries the wrong shape', () => {
    expect(() =>
      parseInputEnvelope('fixture-x', {
        type: 'host_context_observed',
        payload: {
          sessionId: 'rnd-hc-1',
          hostContext: { currentDisplayMode: 'cinema' },
        },
      }),
    ).toThrowError(/'hostContext\.currentDisplayMode' must be 'inline' \| 'fullscreen' \| 'pip'/);
    expect(() =>
      parseInputEnvelope('fixture-x', {
        type: 'host_context_observed',
        payload: {
          sessionId: 'rnd-hc-1',
          hostContext: { containerDimensions: { width: '720' } },
        },
      }),
    ).toThrowError(/'hostContext\.containerDimensions\.width' must be a number/);
  });
});

describe('matchSessionState — the post-dispatch GguiSession-field read-back', () => {
  const behavior = {
    kind: 'session-state',
    field: 'hostContext',
    expected: { currentDisplayMode: 'inline', platform: 'web' },
  } as const;

  /** Mock host whose readSessionField returns `value`. */
  function hostReading(value: unknown): ConformanceHost {
    return {
      dispatchSetup: () => Promise.resolve(),
      dispatchTeardown: () => Promise.resolve(),
      readSessionField: () => Promise.resolve(value),
    };
  }

  it('passes when the read-back deep-equals the expected value', async () => {
    const result = await matchSessionState(
      behavior,
      'rnd-hc-1',
      hostReading({ currentDisplayMode: 'inline', platform: 'web' }),
    );
    expect(result.kind).toBe('pass');
  });

  it('fails (deep equality, not subset) when the read-back differs', async () => {
    const result = await matchSessionState(
      behavior,
      'rnd-hc-1',
      hostReading({ currentDisplayMode: 'fullscreen', platform: 'web' }),
    );
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    expect(result.expected).toEqual({
      field: 'hostContext',
      value: { currentDisplayMode: 'inline', platform: 'web' },
    });
    expect(result.received).toEqual({
      field: 'hostContext',
      value: { currentDisplayMode: 'fullscreen', platform: 'web' },
    });
    expect(result.message).toContain("session field 'hostContext'");
  });

  it('fails when the field was never written (undefined read-back)', async () => {
    const result = await matchSessionState(behavior, 'rnd-hc-1', hostReading(undefined));
    expect(result.kind).toBe('fail');
  });

  it('skips when no host was provided', async () => {
    const result = await matchSessionState(behavior, 'rnd-hc-1', undefined);
    expect(result.kind).toBe('unmatchable-on-ws');
    if (result.kind !== 'unmatchable-on-ws') return;
    expect(result.reason).toContain('no host was provided');
  });

  it('skips when the host does not implement readSessionField', async () => {
    const hostWithoutRead: ConformanceHost = {
      dispatchSetup: () => Promise.resolve(),
      dispatchTeardown: () => Promise.resolve(),
    };
    const result = await matchSessionState(behavior, 'rnd-hc-1', hostWithoutRead);
    expect(result.kind).toBe('unmatchable-on-ws');
    if (result.kind !== 'unmatchable-on-ws') return;
    expect(result.reason).toContain('does not implement it');
    expect(result.reason).toContain('SKIP, not a pass');
  });

  it('skips with the error message when readSessionField throws — a host that cannot read state cannot grade it', async () => {
    const throwingHost: ConformanceHost = {
      dispatchSetup: () => Promise.resolve(),
      dispatchTeardown: () => Promise.resolve(),
      readSessionField: () => Promise.reject(new Error("field 'hostContext' is not exposed")),
    };
    const result = await matchSessionState(behavior, 'rnd-hc-1', throwingHost);
    expect(result.kind).toBe('unmatchable-on-ws');
    if (result.kind !== 'unmatchable-on-ws') return;
    expect(result.reason).toContain('a host that cannot read state cannot grade it');
    expect(result.reason).toContain("field 'hostContext' is not exposed");
  });
});

describe('deriveWsUrl — bare origins get /ws, explicit paths are used as given', () => {
  it('appends /ws to a bare http origin and derives ws://', () => {
    expect(deriveWsUrl('http://localhost:3000')).toBe('ws://localhost:3000/ws');
  });

  it('appends /ws to a bare https origin and derives wss://', () => {
    expect(deriveWsUrl('https://example.com')).toBe('wss://example.com/ws');
  });

  it('treats a trailing slash as a bare origin', () => {
    expect(deriveWsUrl('ws://localhost:3000/')).toBe('ws://localhost:3000/ws');
  });

  it('uses a URL that already ends in /ws exactly as given (no double-append)', () => {
    expect(deriveWsUrl('ws://localhost:3000/ws')).toBe('ws://localhost:3000/ws');
  });

  it('uses a non-default mount path exactly as given', () => {
    expect(deriveWsUrl('wss://example.com/live-channel')).toBe(
      'wss://example.com/live-channel',
    );
  });

  it('assumes ws:// for a scheme-less origin', () => {
    expect(deriveWsUrl('localhost:3000')).toBe('ws://localhost:3000/ws');
  });
});
