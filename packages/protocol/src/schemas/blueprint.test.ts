// Protocol-side schema tests for `blueprintVarianceSchema` — the single
// shared variance schema reused by every seam that accepts a variance
// block (handshake draft, render-decision override, operator blueprint
// tools). Pinning its parse + strict behavior here means every
// downstream consumer inherits the same rule.

import { describe, it, expect } from 'vitest';
import { blueprintVarianceSchema } from './blueprint';

describe('blueprintVarianceSchema', () => {
  it('parses persona/aesthetic/context/seedPrompt and is strict', () => {
    const v = {
      persona: 'minimalist',
      aesthetic: 'calm',
      context: { situation: 'sad' },
      seedPrompt: 's',
    };
    expect(blueprintVarianceSchema.parse(v)).toEqual(v);
    expect(() => blueprintVarianceSchema.parse({ persona: 'x', bogus: 1 })).toThrow();
  });

  it('accepts an empty variance (every field optional)', () => {
    expect(blueprintVarianceSchema.parse({})).toEqual({});
  });
});
