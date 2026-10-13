// ggui#1849 (follow-up) — a near-miss literal on a design-primitive prop blocks.
// When a bad string is close to a valid one, TypeScript reports the "did you mean
// '…'?" form of the assignability error, TS2820, instead of TS2322. The checker
// filed TS2820 as a non-blocking warning, so `surface="heros"` (or a tint step one
// digit off) passed tier-0 while `surface="banana"` failed.
import { describe, expect, it } from 'vitest';
import { typecheck } from './type-checker.js';

const card = (attr: string): string => `import React from 'react';
import { Box, Stack, Text } from '@ggui-ai/design';

interface Props {
  label: string;
}

export default function Component(props: Props) {
  return (
    <Stack gap="md">
      <Box ${attr} padding="md">
        <Text>{props.label}</Text>
      </Box>
    </Stack>
  );
}
`;

describe('a near-miss literal on a primitive prop is a blocking error (ggui#1849)', () => {
  it('surface="heros" (did you mean "hero"?) blocks', async () => {
    const r = await typecheck(card('surface="heros"'));
    expect(r.errors.some((e) => e.code === 2820 && e.message.includes('heros'))).toBe(true);
    expect(r.warnings.some((w) => w.code === 2820)).toBe(false);
  });

  it('control: surface="hero" is clean', async () => {
    expect((await typecheck(card('surface="hero"'))).errors).toEqual([]);
  });
});
