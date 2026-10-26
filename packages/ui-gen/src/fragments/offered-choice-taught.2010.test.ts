// ggui#2010 — the no-truncate fix names the chip example only where the prompt taught it. Whether it did is read off
// the harness the generation ran with (`how.fragments`, what reached the prompt), never re-derived from the vector.
import { describe, expect, it } from 'vitest';
import { createHarness } from '../create-harness.js';
import type { Classification } from '../classifier/index.js';
import type { ChoiceShape } from '../classifier/axes.js';
import { offeredChoiceTaught } from './index.js';

function classification(choice: ChoiceShape): Classification {
  return {
    vector: { render: 'static', state: 'none', writes: 'submit', writeTrigger: 'click', realtime: 'none', fetch: 'none', layout: 'single', tooling: 'none', choice },
    provenance: { render: 'default', state: 'default', writes: 'default', writeTrigger: 'default', realtime: 'default', fetch: 'default', layout: 'default', tooling: 'default', choice: 'contract' },
    riskTier: 'low',
  };
}

describe('offeredChoiceTaught (ggui#2010)', () => {
  it('is true for a harness whose prompt carries the offered-items choice fragment', () => {
    const harness = createHarness({ classification: classification('offered-items'), contract: {}, prompt: 'pick one' });
    expect(offeredChoiceTaught(harness.how.fragments)).toBe(true);
    expect(harness.how.systemPrompt).toContain('## Choice: offered items');
  });

  it('is false for a harness without it', () => {
    const harness = createHarness({ classification: classification('none'), contract: {}, prompt: 'pick one' });
    expect(offeredChoiceTaught(harness.how.fragments)).toBe(false);
    expect(harness.how.systemPrompt).not.toContain('## Choice: offered items');
  });
});
