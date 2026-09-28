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
    const read = (file: string): string => readFileSync(resolve(here, '..', file), 'utf8');
    // The ladder set builds every registry the runtime binds (ggui#1496),
    // one per credential; runtime.ts builds none of its own.
    expect(read('runtime.ts').split('new ChannelRegistry({').length - 1).toBe(0);
    const ladders = read('ladders.ts');
    expect(ladders.split('new ChannelRegistry({').length - 1).toBe(1);
    // Its per-ladder classifier observes the frame, then answers with this
    // one's verdict, and that classifier is what the registry is given.
    expect(ladders.split('return classifyChannelFrame(frame);').length - 1).toBe(1);
    expect(ladders.split('      classifyFrame,\n').length - 1).toBe(1);
  });
});
