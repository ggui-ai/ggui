/**
 * Precedence pin for the RN provider's TERMINAL-consumer ladder
 * (adversarial-cycle ruling, ggui#598 leg 4): embedder prop > OS
 * scheme > terminal default 'light'. The terminal default is legal
 * HERE — nothing sits below the native chrome painter — and this pin
 * plus the docstring is what distinguishes a documented terminal
 * consumer from the banned mid-ladder defaulting.
 */
import { describe, expect, it } from 'vitest';
import { resolveNativeScheme } from '../ThemeProvider';

describe('resolveNativeScheme — terminal-consumer ladder', () => {
  it('embedder prop wins over the OS scheme', () => {
    expect(resolveNativeScheme('dark', 'light')).toBe('dark');
    expect(resolveNativeScheme('light', 'dark')).toBe('light');
  });

  it('OS scheme fills when the prop is absent', () => {
    expect(resolveNativeScheme(undefined, 'dark')).toBe('dark');
  });

  it('terminal default fires ONLY when both layers are absent', () => {
    expect(resolveNativeScheme(undefined, null)).toBe('light');
    expect(resolveNativeScheme(undefined, undefined)).toBe('light');
  });
});
