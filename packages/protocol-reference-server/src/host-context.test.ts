/**
 * `host_context_observed` handling + the `readSessionField`
 * introspection seam — the negative space the kit's
 * `host-context-observed-persists` fixture does NOT grade.
 *
 * The conformance suite (`conformance.test.ts`) proves the happy path
 * end-to-end over a real WS: well-formed frame in → projection
 * persisted → `readSessionField('hostContext')` deep-equals. This
 * file pins the package-internal contract edges:
 *
 *   - the validating narrower's drop posture (malformed frames,
 *     non-projection keys like `theme`, mistyped fields → `undefined`,
 *     nothing persisted);
 *   - idempotent overwrite on re-delivery (protocol: replace, never
 *     merge);
 *   - `readSessionField`'s honest-grade contract: true value back
 *     (including `undefined` when nothing was persisted — a FAIL for
 *     the kit, not a skip), throw with a clear message on unknown
 *     fields / unknown renders (a SKIP for the kit, never a pass).
 */
import { describe, expect, it } from 'vitest';

import { createReferenceConformanceHost } from './conformance-host.js';
import {
  handleHostContextObserved,
  parseHostContextObservedFrame,
} from './host-context.js';
import { ReferenceServer } from './server.js';

/** The full-projection body the kit's fixture also authors. */
const fullProjection = {
  availableDisplayModes: ['inline', 'fullscreen'],
  currentDisplayMode: 'inline',
  containerDimensions: { maxWidth: 480, height: 320 },
  platform: 'web',
  deviceCapabilities: { touch: false, hover: true },
  locale: 'en-US',
  timeZone: 'America/Los_Angeles',
} as const;

function frameWith(hostContext: unknown, sessionId = 'hc-1'): unknown {
  return {
    type: 'host_context_observed',
    payload: { sessionId, hostContext },
  };
}

describe('parseHostContextObservedFrame', () => {
  it('accepts the canonical frame and returns the typed projection verbatim', () => {
    const parsed = parseHostContextObservedFrame(frameWith(fullProjection));
    expect(parsed).toBeDefined();
    expect(parsed?.payload.sessionId).toBe('hc-1');
    expect(parsed?.payload.hostContext).toEqual(fullProjection);
  });

  it('accepts an empty projection — every field is optional per the protocol', () => {
    const parsed = parseHostContextObservedFrame(frameWith({}));
    expect(parsed?.payload.hostContext).toEqual({});
  });

  it('preserves a string requestId and drops the frame on a non-string one', () => {
    const base = frameWith(fullProjection) as Record<string, unknown>;
    expect(
      parseHostContextObservedFrame({ ...base, requestId: 'req-1' })?.requestId,
    ).toBe('req-1');
    expect(parseHostContextObservedFrame({ ...base, requestId: 42 })).toBeUndefined();
  });

  it('drops frames whose hostContext carries a non-projection key (theme flows through theming, not host context)', () => {
    expect(
      parseHostContextObservedFrame(
        frameWith({ ...fullProjection, theme: 'dark' }),
      ),
    ).toBeUndefined();
  });

  it.each([
    ['currentDisplayMode outside the literal set', { currentDisplayMode: 'sidebar' }],
    ['availableDisplayModes carrying a non-mode', { availableDisplayModes: ['inline', 'modal'] }],
    ['containerDimensions with an unknown dimension key', { containerDimensions: { depth: 3 } }],
    ['containerDimensions with a non-numeric value', { containerDimensions: { maxWidth: '480' } }],
    ['platform outside the literal set', { platform: 'tv' }],
    ['deviceCapabilities with a non-boolean', { deviceCapabilities: { touch: 'yes' } }],
    ['empty locale', { locale: '' }],
    ['non-string timeZone', { timeZone: 7 }],
    ['non-object hostContext', 'inline'],
  ])('drops the frame on %s', (_label, hostContext) => {
    expect(parseHostContextObservedFrame(frameWith(hostContext))).toBeUndefined();
  });

  it('drops frames missing the payload sessionId', () => {
    expect(
      parseHostContextObservedFrame({
        type: 'host_context_observed',
        payload: { hostContext: fullProjection },
      }),
    ).toBeUndefined();
  });

  it('drops non-host_context_observed and non-object frames', () => {
    expect(parseHostContextObservedFrame({ type: 'action', payload: {} })).toBeUndefined();
    expect(parseHostContextObservedFrame(null)).toBeUndefined();
    expect(parseHostContextObservedFrame('host_context_observed')).toBeUndefined();
  });
});

describe('handleHostContextObserved + readSessionField', () => {
  it('persists the projection and overwrites idempotently on re-delivery (replace, never merge)', () => {
    const server = new ReferenceServer({ port: 0 });
    const render = server.renders.create('hc-2', 'conformance');

    const first = parseHostContextObservedFrame(frameWith(fullProjection, 'hc-2'));
    expect(first).toBeDefined();
    if (first === undefined) throw new Error('unreachable — asserted defined above');
    handleHostContextObserved(first, render);
    expect(render.hostContext).toEqual(fullProjection);

    // Re-delivery with a NARROWER projection replaces the stored value
    // entirely — fields absent from the new delivery do not survive.
    const second = parseHostContextObservedFrame(
      frameWith({ currentDisplayMode: 'fullscreen' }, 'hc-2'),
    );
    expect(second).toBeDefined();
    if (second === undefined) throw new Error('unreachable — asserted defined above');
    handleHostContextObserved(second, render);
    expect(render.hostContext).toEqual({ currentDisplayMode: 'fullscreen' });
  });

  it('readSessionField returns the true stored value — undefined when nothing was persisted', async () => {
    const server = new ReferenceServer({ port: 0 });
    const host = createReferenceConformanceHost({ serverInstance: server });
    await host.dispatchSetup({ kind: 'create-session', sessionId: 'hc-3' });

    // Nothing persisted yet — the honest read-back is `undefined`, so
    // the kit's deep-equal FAILS a server that drops the message
    // (never a skip, never a fabricated pass).
    await expect(host.readSessionField?.('hc-3', 'hostContext')).resolves.toBeUndefined();

    const render = server.renders.get('hc-3');
    expect(render).toBeDefined();
    if (render === undefined) throw new Error('unreachable — asserted defined above');
    const parsed = parseHostContextObservedFrame(frameWith(fullProjection, 'hc-3'));
    if (parsed === undefined) throw new Error('unreachable — canonical frame parses');
    handleHostContextObserved(parsed, render);

    await expect(host.readSessionField?.('hc-3', 'hostContext')).resolves.toEqual(
      fullProjection,
    );
  });

  it('readSessionField throws a clear message on an unknown field — the kit records an honest SKIP', async () => {
    const server = new ReferenceServer({ port: 0 });
    const host = createReferenceConformanceHost({ serverInstance: server });
    await host.dispatchSetup({ kind: 'create-session', sessionId: 'hc-4' });

    await expect(host.readSessionField?.('hc-4', 'consumeBuffer')).rejects.toThrow(
      /does not expose GguiSession field 'consumeBuffer'.*readable fields: hostContext/,
    );
  });

  it('readSessionField throws on an unknown render', async () => {
    const server = new ReferenceServer({ port: 0 });
    const host = createReferenceConformanceHost({ serverInstance: server });

    await expect(host.readSessionField?.('never-created', 'hostContext')).rejects.toThrow(
      /no GguiSession 'never-created'/,
    );
  });
});
