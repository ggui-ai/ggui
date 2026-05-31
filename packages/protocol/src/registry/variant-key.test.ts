import { describe, it, expect } from 'vitest';
import { variantKey } from './variant-key.js';
import type { BlueprintVariance } from '../types/blueprint.js';

describe('variantKey', () => {
  it('is a 16-char lowercase hex string', () => {
    expect(variantKey({ persona: 'minimalist' })).toMatch(/^[0-9a-f]{16}$/);
  });

  it('undefined / {} / {persona:""} / all-empty collapse to one sentinel (D9)', () => {
    const sentinel = variantKey(undefined);
    expect(variantKey({})).toBe(sentinel);
    expect(variantKey({ persona: '' })).toBe(sentinel);
    expect(
      variantKey({ persona: '', aesthetic: '', seedPrompt: '', context: {} }),
    ).toBe(sentinel);
  });

  it('differing persona produces a differing key', () => {
    expect(variantKey({ persona: 'data-dense' })).not.toBe(
      variantKey({ persona: 'minimalist' }),
    );
  });

  it('differing aesthetic produces a differing key', () => {
    expect(variantKey({ aesthetic: 'glassmorphic' })).not.toBe(
      variantKey({ aesthetic: 'brutalist' }),
    );
  });

  it('differing seedPrompt produces a differing key (prose is load-bearing)', () => {
    expect(variantKey({ seedPrompt: 'calm' })).not.toBe(
      variantKey({ seedPrompt: 'busy' }),
    );
  });

  it('is key-order invariant', () => {
    const a: BlueprintVariance = { persona: 'minimalist', aesthetic: 'x' };
    const b: BlueprintVariance = { aesthetic: 'x', persona: 'minimalist' };
    expect(variantKey(a)).toBe(variantKey(b));
  });

  it('is NFC invariant (precomposed === decomposed)', () => {
    // Explicit \u escapes — JS source files in some editors silently
    // re-normalize literal accented characters.
    const precomposed = 'caf\u00e9'; // \u00e9 as one code point
    const decomposed = 'cafe\u0301'; // e + combining acute (two code points)
    expect(precomposed).not.toBe(decomposed);
    expect(variantKey({ persona: precomposed, aesthetic: 'x' })).toBe(
      variantKey({ aesthetic: 'x', persona: decomposed }),
    );
  });

  it('is deterministic across repeated calls', () => {
    const v: BlueprintVariance = { persona: 'data-dense', seedPrompt: 'grid' };
    expect(variantKey(v)).toBe(variantKey(v));
  });
});
