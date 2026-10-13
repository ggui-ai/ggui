// ggui#1849 — the sandbox loads React's types, so a JSX prop on a design primitive is
// actually checked. `@types/react` 19.2+ ships an `exports` map with only `types`
// conditions, which `require.resolve` refuses for every subpath; the resolver returned
// null, the sandbox ran without React, and every primitive prop degraded to `any`.
// The older "should resolve react imports" test passed vacuously: it looked for TS2307
// among errors, and this checker files TS2307 as a warning.
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

describe('the typecheck sandbox has React’s types (ggui#1849)', () => {
  it("resolves 'react' — no TS2307 among errors OR warnings", async () => {
    const r = await typecheck(card('surface="hero"'));
    expect([...r.errors, ...r.warnings].filter((d) => d.code === 2307)).toEqual([]);
  });

  it('a wrong prop value on a design primitive is a blocking TS2322', async () => {
    const r = await typecheck(card('surface="banana"'));
    expect(r.errors.some((e) => e.code === 2322 && e.message.includes('banana'))).toBe(true);
  });

  it('control: a valid prop value is clean', async () => {
    const r = await typecheck(card('surface="hero"'));
    expect(r.errors).toEqual([]);
  });
});
