// ggui#1929 — a React hook the boilerplate always imports goes missing (`Cannot find name 'useMemo'`):
// the DO NOT EDIT React import line was dropped or rewritten. The generic TS2304 text sent the model
// to props and removed helpers instead, and a fast arm looped to 30 turns. The fix text now names the
// import line, from the same list the boilerplate writes it from.
import { describe, expect, it } from 'vitest';
import { typecheck } from './type-checker.js';
import { BOILERPLATE_REACT_HOOKS, BOILERPLATE_REACT_IMPORT } from '../boilerplate/react-hooks.js';

const HOOK_DOOR = 'is a React hook, and the boilerplate\'s React import lists it';

const card = (importLine: string, body: string): string => `${importLine}
import { Box, Text } from '@ggui-ai/design';

export default function Component() {
  ${body}
  return (
    <Box padding="md">
      <Text>x</Text>
    </Box>
  );
}
`;

async function fixes2304(src: string): Promise<string[]> {
  const r = await typecheck(src);
  return r.errors.filter((e) => e.code === 2304).map((e) => e.fix);
}

const use = (hook: string): string => {
  switch (hook) {
    case 'useState':
      return 'const [n] = useState(0); void n;';
    case 'useRef':
      return 'const r = useRef(null); void r;';
    case 'useMemo':
      return 'const v = useMemo(() => 1, []); void v;';
    case 'useCallback':
      return 'const f = useCallback(() => 1, []); void f;';
    default:
      return `${hook}(() => {}, []);`;
  }
};

describe('the boilerplate React import, pinned as a literal (one list, two consumers)', () => {
  it('is byte-for-byte the line the boilerplate has always written', () => {
    // A reorder or a drop in BOILERPLATE_REACT_HOOKS changes every generated boilerplate; this literal
    // is the receipt that the move to one list left the bytes unchanged.
    expect(BOILERPLATE_REACT_IMPORT).toBe("import React, { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react';");
  });
});

describe('a missing boilerplate React hook names the DO NOT EDIT import (ggui#1929)', () => {
  it.each([...BOILERPLATE_REACT_HOOKS])('%s, with the React import reduced to the default', async (hook) => {
    const fixes = await fixes2304(card("import React from 'react';", use(hook)));
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.every((f) => f.includes(HOOK_DOOR))).toBe(true);
    expect(fixes[0]).toContain(BOILERPLATE_REACT_IMPORT);
    expect(fixes[0]).toContain(`\`${hook}\``);
  });

  it('control: with the boilerplate import intact, a hook raises nothing', async () => {
    expect(await fixes2304(card(BOILERPLATE_REACT_IMPORT, use('useMemo')))).toEqual([]);
  });

  it('a missing name that is not a boilerplate hook keeps the generic text', async () => {
    const fixes = await fixes2304(card(BOILERPLATE_REACT_IMPORT, 'const v = notDeclared + 1; void v;'));
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.some((f) => f.includes(HOOK_DOOR))).toBe(false);
  });

  it('a user hook shaped like a React one (useFoo) keeps the generic text', async () => {
    const fixes = await fixes2304(card(BOILERPLATE_REACT_IMPORT, 'useFoo();'));
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.some((f) => f.includes(HOOK_DOOR))).toBe(false);
  });
});
