/**
 * Variance prompt-building — deterministic shape tests.
 *
 * The LLM-driven "does the generated component visually reflect the
 * declared persona/aesthetic" is a bench concern (requires a paid LLM
 * call + visual eval). What we pin here is the WIRING: variance
 * inputs land in the prompt structure correctly and the helpers are
 * pure-deterministic so future regressions surface immediately.
 */
import { describe, expect, it } from 'vitest';
import type { BlueprintVariance } from '@ggui-ai/protocol';
import {
  buildVarianceContext,
  injectVariance,
} from './contract-context.js';

describe('buildVarianceContext', () => {
  it('returns empty string when no fields are populated', () => {
    expect(buildVarianceContext({})).toBe('');
  });

  it('renders persona-only block', () => {
    const out = buildVarianceContext({ persona: 'data-analyst' });
    expect(out).toContain('## Variance');
    expect(out).toContain('**Persona**: data-analyst');
    expect(out).not.toContain('**Aesthetic**');
    expect(out).not.toContain('**Seed prompt**');
    expect(out).not.toContain('**Context**');
  });

  it('renders aesthetic-only block', () => {
    const out = buildVarianceContext({ aesthetic: 'glassmorphic' });
    expect(out).toContain('**Aesthetic**: glassmorphic');
    expect(out).not.toContain('**Persona**');
  });

  it('renders all four fields when present', () => {
    const variance: BlueprintVariance = {
      persona: 'mobile-first reader',
      aesthetic: 'editorial',
      seedPrompt: 'a serene reading view',
      context: { theme: 'sepia', density: 'comfortable' },
    };
    const out = buildVarianceContext(variance);
    expect(out).toContain('**Persona**: mobile-first reader');
    expect(out).toContain('**Aesthetic**: editorial');
    expect(out).toContain('**Seed prompt**: a serene reading view');
    expect(out).toContain('"theme":"sepia"');
    expect(out).toContain('"density":"comfortable"');
  });

  it('treats empty-string fields as absent (no rendering)', () => {
    const out = buildVarianceContext({
      persona: '',
      aesthetic: 'minimal',
    });
    expect(out).toContain('**Aesthetic**: minimal');
    expect(out).not.toContain('**Persona**');
  });

  it('treats empty context object as absent', () => {
    const out = buildVarianceContext({
      aesthetic: 'minimal',
      context: {},
    });
    expect(out).toContain('**Aesthetic**');
    expect(out).not.toContain('**Context**');
  });

  it('frames variance as styling-only, not contract drift', () => {
    const out = buildVarianceContext({ persona: 'x' });
    // The disclaimer line is load-bearing — it teaches the LLM that
    // variance must not reshape contracts. Pin it explicitly.
    expect(out).toContain('Honor them in');
    expect(out).toContain('the visual treatment');
    expect(out).toContain('contract shape');
  });
});

describe('injectVariance', () => {
  it('returns prompt unchanged when variance is absent', () => {
    const prompt = 'Build a counter widget';
    expect(injectVariance(prompt, undefined)).toBe(prompt);
  });

  it('returns prompt unchanged when variance has no populated fields', () => {
    const prompt = 'Build a counter widget';
    expect(injectVariance(prompt, {})).toBe(prompt);
  });

  it('appends the variance block with a blank line separator', () => {
    const prompt = 'Build a counter widget';
    const out = injectVariance(prompt, { persona: 'developer' });
    expect(out.startsWith(prompt + '\n\n')).toBe(true);
    expect(out).toContain('**Persona**: developer');
  });

  it('preserves prompt text verbatim when variance is appended', () => {
    const prompt = 'Build a counter widget\n\nWith a reset button.';
    const out = injectVariance(prompt, { aesthetic: 'brutalist' });
    expect(out).toContain(prompt);
    expect(out.indexOf(prompt)).toBe(0);
  });
});
