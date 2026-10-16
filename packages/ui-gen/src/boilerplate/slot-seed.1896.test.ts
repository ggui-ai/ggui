// ggui#1896 — a context slot starts at the contract's default, never at a prop. A slot seeded from a
// prop in `useEffect` lets the first frame paint the default (measured: 10 of 20 headless loads), and
// `useLayoutEffect` never does (0 of 20). The prompt teaches the layout effect for that seed, the
// boilerplate's DO-NOT-EDIT React import carries it, and the evaluator's seeded check accepts it.
import { describe, expect, it } from 'vitest';
import { generateBoilerplate } from './generate';
import { CONTEXT_SPEC_SECTION } from './hard-sections';

describe('a slot seeded from a prop uses useLayoutEffect (ggui#1896)', () => {
  it("the boilerplate's React import carries useLayoutEffect", () => {
    const b = generateBoilerplate('test prompt', { contextSpec: { name: { schema: { type: 'string' } } } }, 'fullscreen', 'desktop');
    const line = b.split('\n').find((l) => l.startsWith('import React, {'));
    expect(line).toBeDefined();
    expect(line).toMatch(/[{,]\s*useLayoutEffect\s*[,}]/);
  });

  it("the contextSpec section teaches the layout effect for a prop seed, and says why", () => {
    const flat = CONTEXT_SPEC_SECTION.replace(/\s+/g, ' ');
    expect(flat).toContain("useLayoutEffect(() => setName(props.name ?? ''), [props.name])");
    expect(flat).toContain('`useLayoutEffect`, not `useEffect`');
    expect(flat).toContain('first frame paint the empty default');
  });
});
