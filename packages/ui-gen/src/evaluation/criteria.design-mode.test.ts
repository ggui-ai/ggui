/**
 * Evaluator criteria per `designMode` — the triad's third leg moves WITH
 * the prompt (constraint alignment: what the prompt says, the eval
 * checks, and nothing more).
 *
 *   - constrained: `criteriaFor()` IS `CRITERIA`; the coding summary and
 *     the mother prompt are byte-identical to the pre-`designMode` text.
 *   - free: `tokens` narrows to COLOR only; `visual` becomes arm-neutral;
 *     the mother prompt's "Design System Rules" block becomes arm-neutral
 *     "Styling Rules"; functionality / crash / interactivity / loading /
 *     layout / accessibility are shared verbatim.
 */
import { describe, expect, it } from 'vitest';
import {
  CRITERIA,
  buildCodingCriteriaSummary,
  criteriaFor,
  getCriterionById,
  getLLMCriteria,
} from './types-public.js';
import { buildMotherPrompt } from './llm-evaluator.js';

describe('criteriaFor — constrained is the unchanged registry', () => {
  it('returns the CRITERIA array itself for the default mode', () => {
    expect(criteriaFor()).toBe(CRITERIA);
    expect(criteriaFor('constrained')).toBe(CRITERIA);
  });

  it('coding summary is byte-identical whether the mode is omitted or explicit', () => {
    expect(buildCodingCriteriaSummary('constrained')).toBe(buildCodingCriteriaSummary());
  });

  it('getCriterionById defaults to constrained', () => {
    expect(getCriterionById('tokens')).toBe(getCriterionById('tokens', 'constrained'));
    expect(getCriterionById('tokens')!.name).toBe('Design system tokens');
  });
});

describe('criteriaFor — free relaxes only tokens + visual', () => {
  it('keeps every other criterion identical, in order', () => {
    const free = criteriaFor('free');
    expect(free.map((c) => c.id)).toEqual(CRITERIA.map((c) => c.id));
    for (const [i, c] of CRITERIA.entries()) {
      if (c.id === 'tokens' || c.id === 'visual') continue;
      expect(free[i]).toBe(c);
    }
  });

  it('tokens narrows to color (no spacing / px flags), same priority and tier', () => {
    const tokens = getCriterionById('tokens', 'free')!;
    expect(tokens.name).toBe('Color tokens');
    expect(tokens.priority).toBe('P1');
    expect(tokens.tier).toBe(0);
    expect(tokens.evalInstruction).toContain('Do NOT flag literal spacing');
    expect(tokens.codingGuidance).toContain('var(--ggui-color-*)');
    expect(tokens.codingGuidance).not.toContain('gap="md"');
  });

  it('visual is arm-neutral — composition, hierarchy, fit to canvas; no design-system reward', () => {
    const visual = getCriterionById('visual', 'free')!;
    expect(visual.name).toBe('Visual composition');
    expect(visual.evalInstruction).toContain('Do NOT reward or penalise the use of design-system primitives');
    expect(visual.evalInstruction).toContain('fit to the canvas');
    expect(visual.evalInstruction).not.toContain('t-shirt scale');
    expect(getLLMCriteria('free').map((c) => c.id)).toEqual(getLLMCriteria().map((c) => c.id));
  });

  it('the free coding summary teaches the color rule and drops the spacing-scale rule', () => {
    const summary = buildCodingCriteriaSummary('free');
    expect(summary).toContain('Every color is a bare var(--ggui-color-*)');
    expect(summary).not.toContain('use the spacing scale for gap/padding/margin');
    expect(summary).toContain('## Priority (P0 first, then P1, then P2)');
  });
});

describe('buildMotherPrompt — per designMode', () => {
  const ctx = { originalPrompt: 'a kanban board', contract: { actionSpec: { move: { label: 'Move' } } } };

  it('constrained is unchanged (Design System Rules block, primitive-ARIA allowlist, design-system framing)', () => {
    const p = buildMotherPrompt(ctx);
    expect(p).toBe(buildMotherPrompt({ ...ctx, designMode: 'constrained' }));
    expect(p).toContain('built with the ggui design system');
    expect(p).toContain('## Design System Rules (important for evaluation)');
    expect(p).toContain('**visual**: Design system consistency.');
    expect(p).toContain('without `as={Clickable}`');
  });

  it('free swaps in arm-neutral styling rules + visual reference and keeps the shared blocks', () => {
    const p = buildMotherPrompt({ ...ctx, designMode: 'free' });
    expect(p).toContain('composed freely');
    expect(p).toContain('## Styling Rules (important for evaluation)');
    expect(p).not.toContain('## Design System Rules');
    expect(p).toContain('MAY be literals');
    expect(p).toContain('**visual**: Visual composition.');
    expect(p).not.toContain('**visual**: Design system consistency.');
    // Shared blocks survive verbatim.
    for (const shared of ['## Issue-array discipline', '## Data Contract (JSON Schema → TypeScript types)', '**functionality**:', '**crash**:', '**accessibility**:', '## Primitive Accessibility (built-in — do NOT flag as missing)']) {
      expect(p).toContain(shared);
    }
    // Raw-element a11y gap rewritten: a real <button> is never a gap.
    expect(p).toContain('a real `<button>` / `<a href>` is the');
    expect(p).not.toContain('without `as={Clickable}`');
  });
});
