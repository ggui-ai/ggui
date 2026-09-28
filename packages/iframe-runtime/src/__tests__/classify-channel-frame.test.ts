/**
 * ggui#1496 — the iframe's verdict on channel frames for the WebSocket
 * retry budget. An `ack` is an accepted subscription; an `error` whose
 * code is one of the pre-ack auth codes (the same single list the
 * handshake's classification uses) is a refusal no retry of the same
 * credential can fix. Everything else says nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { classifyChannelFrame } from '../registry-subscribe.js';

describe('classifyChannelFrame (ggui#1496)', () => {
  it('an ack is an accepted subscription', () => {
    expect(classifyChannelFrame({ type: 'ack', payload: { sessionId: 's' } })).toBe('accepted');
  });

  it('an error carrying any pre-ack auth code is terminal', () => {
    for (const code of [
      'SESSION_NOT_FOUND',
      'BOOTSTRAP_EXPIRED',
      'BOOTSTRAP_INVALID',
      'BOOTSTRAP_SESSION_MISMATCH',
      'BOOTSTRAP_APP_MISMATCH',
      'UNAUTHENTICATED',
    ]) {
      expect(classifyChannelFrame({ type: 'error', payload: { code, message: 'no' } }), code).toBe('refused-terminal');
    }
  });

  it('any other error, a malformed error, or another frame type says nothing', () => {
    expect(classifyChannelFrame({ type: 'error', payload: { code: 'UPGRADE_REQUIRED' } })).toBeUndefined();
    expect(classifyChannelFrame({ type: 'error', payload: { message: 'no code' } })).toBeUndefined();
    expect(classifyChannelFrame({ type: 'error', payload: null })).toBeUndefined();
    expect(classifyChannelFrame({ type: 'props_update', payload: { code: 'BOOTSTRAP_EXPIRED' } })).toBeUndefined();
  });

  it('every ChannelRegistry the runtime builds is given the classifier', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '..', 'runtime.ts'), 'utf8');
    const builds = src.split('new ChannelRegistry({').length - 1;
    const given = src.split('classifyFrame: classifyChannelFrame').length - 1;
    expect(builds).toBeGreaterThan(0);
    expect(given).toBe(builds);
  });
});
