// ggui#1846 — an out-of-range categorical tint fails tier-0, the check every commit
// runs on the served path, through the prop's own type (`tint?: TintStep`, from
// `TINT_STEPS` in @ggui-ai/design). No duplicate list of step names lives here: the
// union is the contract. A control on a real step passes.
import { describe, expect, it } from 'vitest';
import { TINT_STEPS } from '@ggui-ai/design';
import { runTier0Checks } from './run-tier0.js';

const source = (tint: string): string => `import React from 'react';
import { Box, Stack, Text } from '@ggui-ai/design';

interface Props {
  label: string;
}

export default function Component(props: Props) {
  return (
    <Stack gap="md">
      <Box tint="${tint}" padding="md">
        <Text>{props.label}</Text>
      </Box>
    </Stack>
  );
}
`;

const typeFails = async (tint: string) =>
  (await runTier0Checks(source(tint))).filter((i) => i.result === 'fail' && i.category === 'types');

describe('a categorical tint outside the eight steps fails tier-0 (ggui#1846)', () => {
  it('tint="tint-9" fails the typecheck leg', async () => {
    const fails = await typeFails('tint-9');
    expect(fails.length).toBeGreaterThan(0);
    expect(fails.some((i) => i.description.includes('tint-9'))).toBe(true);
  });

  it('control: every one of the eight steps passes the typecheck leg', async () => {
    for (const step of TINT_STEPS) expect(await typeFails(step), step).toEqual([]);
  });
});

describe('a theme token through the brand-color escape fails, and the repair names tint (ggui#1846)', () => {
  const escape = (assetColor: string) => `import React from 'react';
import { Box, Text } from '@ggui-ai/design';

export default function Component() {
  return (
    <Box assetColor=${assetColor} assetSemantic="element-category">
      <Text>H</Text>
    </Box>
  );
}
`;
  const theme = async (assetColor: string) =>
    (await runTier0Checks(escape(assetColor))).filter((i) => i.result === 'fail' && i.subcategory === 'asset-color-theme-token');

  it('a literal theme token fails, with tint and surface in the repair', async () => {
    const fails = await theme('"var(--ggui-color-error-500)"');
    expect(fails).toHaveLength(1);
    expect(fails[0]?.fix).toContain('tint="tint-1"');
    expect(fails[0]?.fix).toContain('surface=');
  });

  it('an expression carrying a theme token fails too', async () => {
    expect(await theme("{'var(--ggui-color-tint-2)'}")).toHaveLength(1);
  });

  it('control: an exact brand hex with its semantic is the escape working as meant', async () => {
    expect(await theme('"#635BFF"')).toEqual([]);
  });
});

