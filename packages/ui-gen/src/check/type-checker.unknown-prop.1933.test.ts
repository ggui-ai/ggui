// ggui#1933 — a prop the design primitive does not take (`<Stack spacing="md">`): TypeScript says the prop does
// not exist, never what the component accepts, so the generic text sent the model guessing and a fast arm looped.
// The fix text now lists the props the component's own props type declares, and names the meant prop only when
// that prop is in the list.
import { describe, expect, it } from 'vitest';
import { typecheck, unknownPropFix } from './type-checker.js';

const card = (jsx: string): string => `import React from 'react';
import { Stack, Text } from '@ggui-ai/design';

export default function Component() {
  return (
    ${jsx}
  );
}
`;

async function fixes(src: string): Promise<{ code: number; fix: string }[]> {
  const r = await typecheck(src);
  return r.errors.map((e) => ({ code: e.code, fix: e.fix }));
}

describe('an unknown prop on a design primitive names the props it takes (ggui#1933)', () => {
  it('<Stack spacing> lists Stack props and names gap', async () => {
    const f = await fixes(card('<Stack spacing="md"><Text>x</Text></Stack>'));
    const hit = f.find((e) => e.fix.includes('takes no `spacing` prop'));
    expect(hit, JSON.stringify(f)).toBeDefined();
    expect(hit?.fix).toContain('`<Stack>` takes `gap`');
    for (const p of ['gap', 'direction', 'align']) expect(hit?.fix).toContain(`\`${p}\``);
    expect(hit?.fix).not.toContain('`children`');
  });

  it('<Text color> names tone, read from Text props', async () => {
    const f = await fixes(card('<Text color="muted">x</Text>'));
    const hit = f.find((e) => e.fix.includes('takes no `color` prop'));
    expect(hit, JSON.stringify(f)).toBeDefined();
    expect(hit?.fix).toContain('`<Text>` takes `tone`');
    expect(hit?.fix).toContain('`size`');
  });

  it('a prop with no alias lists the props and names nothing', async () => {
    const f = await fixes(card('<Stack wobble="md"><Text>x</Text></Stack>'));
    const hit = f.find((e) => e.fix.includes('takes no `wobble` prop'));
    expect(hit, JSON.stringify(f)).toBeDefined();
    expect(hit?.fix).not.toContain('in other kits');
  });

  it('control: valid props raise nothing', async () => {
    expect(await fixes(card('<Stack gap="md"><Text tone="muted">x</Text></Stack>'))).toEqual([]);
  });

  it('fail-closed: the alias is named only when the target is in the accepted list', () => {
    expect(unknownPropFix('Box', 'spacing', ['padding', 'style'], '')).not.toContain('in other kits');
    expect(unknownPropFix('Stack', 'spacing', ['gap'], '')).toContain('`<Stack>` takes `gap`');
  });
});
