import { describe, it, expect } from 'vitest';
import { accessibility, focusRing, reducedMotion, highContrast } from './accessibility';

describe('accessibility tokens', () => {
  it('exports focusRing with sky blue color', () => {
    expect(focusRing.color).toBe('#0284c7');
    expect(focusRing.width).toBe('2px');
    expect(focusRing.offset).toBe('2px');
    expect(focusRing.style).toBe('solid');
  });

  it('exports reducedMotion with zero duration', () => {
    expect(reducedMotion.duration).toBe('0ms');
    expect(reducedMotion.transition).toBe('none');
  });

  it('exports highContrast overrides', () => {
    expect(highContrast.borderWidth).toBe('2px');
    expect(highContrast.textColor).toBe('#000000');
    expect(highContrast.backgroundColor).toBe('#ffffff');
    expect(highContrast.linkColor).toBe('#0369a1');
  });

  it('groups all a11y tokens under accessibility', () => {
    expect(accessibility.focusRing).toBe(focusRing);
    expect(accessibility.reducedMotion).toBe(reducedMotion);
    expect(accessibility.highContrast).toBe(highContrast);
  });
});
