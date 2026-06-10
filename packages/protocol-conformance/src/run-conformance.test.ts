/**
 * Runner unit tests — the fixture-directive validating narrower and
 * the WS-endpoint derivation. Pure unit-level: no transport, no
 * server, no host.
 *
 * `parseSetupStep` is the seam where the closed setup vocabulary is
 * enforced: every directive the shipped catalog authors MUST parse,
 * and unknown / malformed directives MUST throw a descriptive
 * fixture-authoring error (never a silent skip). The
 * parse-the-whole-catalog case doubles as the drift-catch between the
 * fixture JSON and the `SetupStep` union.
 */
import { describe, expect, it } from 'vitest';

import { allFixtures } from './fixtures/index.js';
import { deriveWsUrl, parseSetupStep } from './run-conformance.js';

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
