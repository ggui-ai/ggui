import { describe, expect, it } from 'vitest';

import { parsePendingEnvelope } from './envelope-adapters';

describe('parsePendingEnvelope — a drained row is parsed, never cast (ggui#817 part C2)', () => {
  const ENTRY = {
    type: 'action',
    sessionId: 'render_1',
    intent: 'submit',
    actionData: null,
    uiContext: {},
    actionId: 'act_1',
    firedAt: '2026-09-05T00:00:00.000Z',
  };

  it('returns a well-formed entry unchanged', () => {
    expect(parsePendingEnvelope(JSON.stringify(ENTRY))).toEqual(ENTRY);
  });

  it('refuses a malformed row at the seam instead of shipping it to the agent', () => {
    const { actionId: _dropped, ...noId } = ENTRY;
    expect(() => parsePendingEnvelope(JSON.stringify(noId))).toThrow();
    expect(() => parsePendingEnvelope(JSON.stringify({ ...ENTRY, type: 'stream' }))).toThrow();
  });
});
