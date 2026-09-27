// ggui#1436 — the selector's inputs are read from what the harness already has: the classifier's tier and axes, the
// contract's actions, the theme's chroma off its tokens, the profile's presence, the shell as named, the caller's kind.
import { describe, expect, it } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { classifyAxes } from '../../classifier/classifier.js';
import { chromaOfCssTokens, criteriaContextFor } from './context.js';

const withActions: DataContract = {
  propsSpec: { properties: { title: { schema: { type: 'string' }, required: true } } },
  actionSpec: { confirm: { label: 'Confirm', description: 'Places the reservation', example: { id: 'x' } } },
};
const noActions: DataContract = { propsSpec: { properties: { title: { schema: { type: 'string' }, required: true } } } };

describe('chromaOfCssTokens (ggui#1436)', () => {
  it('reads the primary at its 500 step: a grey is achromatic, a hue is chromatic, 3-digit hex counts, no token → unknown', () => {
    expect(chromaOfCssTokens(':root{--ggui-color-primary-500: #777777;}')).toBe('achromatic');
    expect(chromaOfCssTokens(':root{--ggui-color-primary-500: #2a6df4;}')).toBe('chromatic');
    expect(chromaOfCssTokens(':root{--ggui-color-primary-500: #888;}')).toBe('achromatic');
    expect(chromaOfCssTokens(':root{--ggui-color-primary-500: #f00;}')).toBe('chromatic');
    expect(chromaOfCssTokens(':root{--ggui-color-primary-400: #2a6df4;}')).toBe('unknown');
    expect(chromaOfCssTokens(undefined)).toBe('unknown');
  });
});

describe('criteriaContextFor (ggui#1436)', () => {
  it('hasActions from the contract, tier + axes from the classifier, chroma from the tokens, the shell and kind as given', () => {
    const classification = classifyAxes({ contract: withActions, prompt: 'A booking confirmation card' });
    const ctx = criteriaContextFor({
      classification,
      contract: withActions,
      cssTokens: ':root{--ggui-color-primary-500: #2a6df4;}',
      profile: { aesthetic: { id: 'finished' } },
      shell: 'chat',
      kind: 'hello',
    });
    expect(ctx.hasActions).toBe(true);
    expect(ctx.riskTier).toBe(classification.riskTier);
    expect(ctx.axes).toEqual({
      render: classification.vector.render,
      state: classification.vector.state,
      writes: classification.vector.writes,
      fetch: classification.vector.fetch,
      layout: classification.vector.layout,
    });
    expect(ctx.chroma).toBe('chromatic');
    expect(ctx.profilePresent).toBe(true);
    expect(ctx.shell).toBe('chat');
    expect(ctx.kind).toBe('hello');
    expect(ctx.preset).toBe('finished');
  });
  it('no actions, no tokens, no profile, no kind → false / unknown / false / no kind or preset key', () => {
    const ctx = criteriaContextFor({ classification: classifyAxes({ contract: noActions }), contract: noActions, cssTokens: undefined, profile: undefined, shell: 'unknown' });
    expect(ctx.hasActions).toBe(false);
    expect(ctx.chroma).toBe('unknown');
    expect(ctx.profilePresent).toBe(false);
    expect('kind' in ctx).toBe(false);
    expect('preset' in ctx).toBe(false);
    expect(criteriaContextFor({ classification: classifyAxes({ contract: undefined }), contract: undefined, cssTokens: undefined, profile: undefined, shell: 'x' }).hasActions).toBe(false);
  });
});
