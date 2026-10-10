// ggui#1794 — the open-source default model has one source: a generator built with no `model`
// carries @ggui-ai/protocol's DEFAULT_MODEL, so a default switch can never move one and miss the other.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL } from '@ggui-ai/protocol';
import { createUiGenerator } from './create-ui-generator.js';

describe('createUiGenerator default model (ggui#1794)', () => {
  it("is @ggui-ai/protocol's DEFAULT_MODEL when no model is passed", () => {
    expect(createUiGenerator().model).toBe(DEFAULT_MODEL);
  });

  it('an explicit model still wins', () => {
    expect(createUiGenerator({ model: 'anthropic/claude-opus-5' }).model).toBe('anthropic/claude-opus-5');
  });
});
