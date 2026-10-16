// ggui#1846 — a categorical tint passed to `surface` gets fix text that names both doors.
// TypeScript's message lists the seven surface slots and never names the prop, so the generic
// 2322 text sent the model guessing: one run spent its turns on `surface={tint as any}`, which
// type-checks and paints nothing (the surface switch has no tint case). The text now says that
// `surface` takes a layout slot and a data category takes `tint`, built from `TINT_STEPS`.
import { describe, expect, it } from 'vitest';
import { TINT_STEPS } from '@ggui-ai/design';
import { typecheck } from './type-checker.js';

const TINT_UNION = TINT_STEPS.map((s) => `'${s}'`).join(' | ');

const card = (pre: string, attrs: string, tag = 'Box'): string => `import React from 'react';
import { Box, Card, Text } from '@ggui-ai/design';

export default function Component() {
  ${pre}
  return (
    <${tag}
      padding="md"
      ${attrs}
    >
      <Text>x</Text>
    </${tag}>
  );
}
`;

const TWO_DOOR = '`surface` takes a layout slot only';

async function fixesFor(src: string): Promise<string[]> {
  const r = await typecheck(src);
  return r.errors.filter((e) => e.code === 2322 || e.code === 2820).map((e) => e.fix);
}

describe('surface given a tint: the fix text names surface and tint (ggui#1846)', () => {
  const cases: Array<[string, string, string, string?]> = [
    ['a bare tint literal on Box', '', 'surface="tint-3"'],
    ['a bare tint literal on Card', '', 'surface="tint-3"', 'Card'],
    ['a string from a Map<string, string>', "const m = new Map<string, string>(); const tint = m.get('a') ?? 'tint-1';", 'surface={tint}'],
    ['a string | undefined from a map', "const m = new Map<string, string>(); const tint = m.get('a');", 'surface={tint}'],
    ['a variable typed as the tint union', `const tint: ${TINT_UNION} = 'tint-2';`, 'surface={tint}'],
    ['a variable typed as the tint union, on Card', `const tint: ${TINT_UNION} = 'tint-2';`, 'surface={tint}', 'Card'],
    ['a value that is no slot and no tint', '', 'surface="primary"'],
  ];
  for (const [name, pre, attrs, tag] of cases) {
    it(name, async () => {
      const fixes = await fixesFor(card(pre, attrs, tag));
      expect(fixes.length).toBeGreaterThan(0);
      for (const fix of fixes) {
        expect(fix).toContain(TWO_DOOR);
        for (const step of TINT_STEPS) expect(fix).toContain(`tint="${step}"`);
        expect(fix).toContain(TINT_UNION);
        expect(fix).toContain('Never cast it.');
      }
    });
  }

  it('a near-miss slot (TS2820, "did you mean") also gets it', async () => {
    const r = await typecheck(card('', 'surface="heros"'));
    const near = r.errors.filter((e) => e.code === 2820);
    expect(near.length).toBeGreaterThan(0);
    for (const e of near) expect(e.fix).toContain(TWO_DOOR);
  });
});

describe('controls: other assignability errors keep the generic text (ggui#1846)', () => {
  it('a prop that does not exist (gap={42}) on its own line', async () => {
    const fixes = await fixesFor(card('', 'gap={42}'));
    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) expect(fix).not.toContain(TWO_DOOR);
  });

  it('a wrong literal on another prop (Card shadow="huge")', async () => {
    const fixes = await fixesFor(card('', 'shadow="huge"', 'Card'));
    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) expect(fix).not.toContain(TWO_DOOR);
  });

  it('a wrong prop beside a valid surface on one line keeps the generic text', async () => {
    const fixes = await fixesFor(card('', 'surface="sunken" gap={42}'));
    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) expect(fix).not.toContain(TWO_DOOR);
  });

  it('a string-typed tint beside a valid surface on one line keeps the generic text (the tint errored)', async () => {
    const fixes = await fixesFor(card("const m = new Map<string, string>(); const group = m.get('a') ?? 'tint-1';", 'surface="sunken" tint={group}'));
    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) expect(fix).not.toContain(TWO_DOOR);
  });

  it('a tint on surface beside a valid tint on one line still gets the two-door text (the surface errored)', async () => {
    const fixes = await fixesFor(card('', 'surface="tint-3" tint="tint-4"'));
    expect(fixes.length).toBeGreaterThan(0);
    for (const fix of fixes) expect(fix).toContain(TWO_DOOR);
  });

  it('a valid surface and a valid tint are clean', async () => {
    expect((await typecheck(card('', 'surface="sunken" tint="tint-4"'))).errors).toEqual([]);
  });
});
