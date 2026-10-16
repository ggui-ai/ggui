// ggui#1871 — tier-0's sandbox loads `csstype`, which `@types/react` imports for `CSSProperties`.
// Without it every `style={{…}}` went unchecked: `style={{ color: 42 }}` passed. A pre-check over
// 168 retained generated sources found no new blocking error and no new warning with it loaded.
import { describe, expect, it } from 'vitest';
import { typecheck } from './type-checker.js';

// No `import React` here: the sandbox supplies one, and a second is its own warning (TS2300).
const card = (style: string, tag = 'Heading'): string => `import { Box, Heading } from '@ggui-ai/design';

export default function Component() {
  return (
    <Box padding="md">
      <${tag} style={${style}}>Title</${tag}>
    </Box>
  );
}
`;

describe('style objects are type-checked (ggui#1871)', () => {
  it('a number on a property that takes no number blocks (TS2322)', async () => {
    const r = await typecheck(card("{ color: 42 }"));
    expect(r.errors.some((e) => e.code === 2322)).toBe(true);
  });

  it('a style object on a trait-composed primitive is checked too', async () => {
    const r = await typecheck(card("{ color: 42 }", 'Box'));
    expect(r.errors.some((e) => e.code === 2322)).toBe(true);
  });

  it('a misspelled key stays a non-blocking warning (TS2561)', async () => {
    const r = await typecheck(card("{ colr: 'red' }"));
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.code === 2561)).toBe(true);
  });

  it('control: valid style values are clean, theme variables included', async () => {
    const r = await typecheck(card("{ color: 'var(--ggui-color-primary-600)', width: '14px', opacity: 0.25, gridColumn: 3, display: 'flex' }"));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});
