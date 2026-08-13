/**
 * Design Token Sync Tests
 *
 * Verifies that RN tokens stay consistent with the design package values.
 */

import { describe, it, expect } from 'vitest';
import { colors, semantic, focusRing, highContrast } from '@ggui-ai/design/tokens';
import {
  rnColors,
  rnSemantic,
  rnAccessibility,
} from '../tokens';

describe('Design token sync', () => {
  it('rnColors.primary matches design package colors.primary', () => {
    expect(rnColors.primary).toEqual(colors.primary);
  });

  it('rnColors.gray matches design package colors.gray', () => {
    expect(rnColors.gray).toEqual(colors.gray);
  });

  it('rnColors contains all status palettes', () => {
    expect(rnColors.success).toEqual(colors.success);
    expect(rnColors.warning).toEqual(colors.warning);
    expect(rnColors.error).toEqual(colors.error);
    expect(rnColors.info).toEqual(colors.info);
  });

  it('rnSemantic matches design package semantic tokens', () => {
    expect(rnSemantic).toEqual(semantic);
  });

  it('rnAccessibility.focusRing color matches design package', () => {
    expect(rnAccessibility.focusRing.color).toBe(focusRing.color);
  });

  it('rnAccessibility.focusRing width is numeric version of design value', () => {
    expect(rnAccessibility.focusRing.width).toBe(parseFloat(focusRing.width));
  });

  it('rnAccessibility.focusRing offset is numeric version of design value', () => {
    expect(rnAccessibility.focusRing.offset).toBe(parseFloat(focusRing.offset));
  });

  it('rnAccessibility.reducedMotion.duration is 0', () => {
    expect(rnAccessibility.reducedMotion.duration).toBe(0);
  });

  it('rnAccessibility.highContrast matches design package values', () => {
    expect(rnAccessibility.highContrast.borderWidth).toBe(parseFloat(highContrast.borderWidth));
    expect(rnAccessibility.highContrast.textColor).toBe(highContrast.textColor);
    expect(rnAccessibility.highContrast.backgroundColor).toBe(highContrast.backgroundColor);
    expect(rnAccessibility.highContrast.linkColor).toBe(highContrast.linkColor);
  });
});
