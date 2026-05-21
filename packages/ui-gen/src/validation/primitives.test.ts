import { describe, it, expect } from 'vitest';
import { getPrimitives, PRIMITIVES_DOCUMENTATION, VALID_PRIMITIVES, isValidPrimitive } from './primitives.js';

describe('getPrimitives', () => {
  it('should return the primitives list', () => {
    const result = getPrimitives();
    expect(result).toBe(PRIMITIVES_DOCUMENTATION);
  });

  it('should include layout primitives', () => {
    const result = getPrimitives();
    expect(result).toContain('Container');
    expect(result).toContain('Card');
    expect(result).toContain('Stack');
    expect(result).toContain('Divider');
    expect(result).toContain('Spacer');
  });

  it('should include typography primitives', () => {
    const result = getPrimitives();
    expect(result).toContain('Text');
    expect(result).toContain('Heading');
  });

  it('should include form control primitives', () => {
    const result = getPrimitives();
    expect(result).toContain('Button');
    expect(result).toContain('Input');
    expect(result).toContain('TextArea');
    expect(result).toContain('Select');
    expect(result).toContain('Checkbox');
    expect(result).toContain('RadioGroup');
    expect(result).toContain('Slider');
  });

  it('should include media primitives', () => {
    const result = getPrimitives();
    expect(result).toContain('Image');
    expect(result).toContain('Icon');
  });

  it('should include design system reference header', () => {
    const result = getPrimitives();
    expect(result).toContain('ggui Primitives');
    // D1: the catalog teaches the single `@ggui-ai/design` barrel,
    // not the retired `/primitives` `/components` … subpaths.
    expect(result).toContain('@ggui-ai/design');
    expect(result).not.toContain('@ggui-ai/design/primitives');
  });

  it('should include onChange behavior section', () => {
    const result = getPrimitives();
    expect(result).toContain('onChange Behavior (CRITICAL)');
    expect(result).toContain('VALUE DIRECTLY');
  });

  it('should include compositions', () => {
    const result = getPrimitives();
    expect(result).toContain('FileUploader');
    expect(result).toContain('Modal');
    expect(result).toContain('Header');
  });
});

describe('VALID_PRIMITIVES', () => {
  it('should include all primitive exports', () => {
    expect(VALID_PRIMITIVES).toContain('Container');
    expect(VALID_PRIMITIVES).toContain('Button');
    expect(VALID_PRIMITIVES).toContain('MotionKeyframes');
  });

  it('should include component exports', () => {
    expect(VALID_PRIMITIVES).toContain('SearchField');
    expect(VALID_PRIMITIVES).toContain('Dropdown');
  });

  it('should include composition exports', () => {
    expect(VALID_PRIMITIVES).toContain('Header');
    expect(VALID_PRIMITIVES).toContain('Modal');
    expect(VALID_PRIMITIVES).toContain('MarketingHero');
  });
});

describe('isValidPrimitive', () => {
  it('returns true for valid primitives', () => {
    expect(isValidPrimitive('Button')).toBe(true);
    expect(isValidPrimitive('Container')).toBe(true);
  });

  it('returns false for invalid primitives', () => {
    expect(isValidPrimitive('NonExistent')).toBe(false);
    expect(isValidPrimitive('DatePicker')).toBe(false);
  });
});
