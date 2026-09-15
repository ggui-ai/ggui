// The compiles-but-renders-nothing class (ggui#1119).
//
// `base.tsx.tmpl` / `base-free.tsx.tmpl` hand the model `return (` …
// `);` around `{{LAYOUT}}`. A model rewriting the root block can delete
// those two lines with it — and bare JSX at statement position is legal
// TSX: it parses, esbuild compiles it, `typecheck()` passes it, and the
// component renders a blank frame. The fixture below is the shape of
// the take that bought this check (ggui#1113 A/B, `xs-chat-card`, run 2:
// the judge spent a screenshot and an LLM call to say "The screenshot is
// completely blank with no visible content whatsoever." and scored 0).
//
// The detector is deliberately conservative: it reports only when it
// positively identified a block-bodied default-export component that
// never returns a value. Every shape it cannot resolve stays silent —
// a false fail costs a real generation a repair turn.
import { describe, expect, it } from 'vitest';
import { runTier0Checks } from './run-tier0.js';
import type { EvalIssue } from '../evaluation/types-public.js';

/** The observed defect, verbatim in shape: no `return`, JSX as a statement. */
const NEVER_RETURNS = `import React from 'react';
import { Stack, Container, Heading, Text } from '@ggui-ai/design';

interface Props {
  heading: string;
}

export default function Component(props: Props) {
  const label = props.heading;

    <Stack gap="lg" align="center">
      <Container maxWidth="sm">
        <Heading level={1}>{label}</Heading>
      </Container>
    </Stack>
}
`;

const RETURNS = NEVER_RETURNS.replace('    <Stack', '  return (\n    <Stack').replace(
  '    </Stack>\n}',
  '    </Stack>\n  );\n}',
);

const rendersNothing = (issues: readonly EvalIssue[]): EvalIssue[] =>
  issues.filter((i) => i.category === 'compile' && i.subcategory === 'renders-nothing');

describe('tier-0 compile/renders-nothing', () => {
  it('fires on a component whose tree sits at statement position, and names the line the fix belongs on', async () => {
    const issues = await runTier0Checks(NEVER_RETURNS);
    const found = rendersNothing(issues);
    expect(found.length).toBe(1);
    const issue = found[0]!;
    expect(issue.result).toBe('fail');
    expect(issue.severity).toBe('critical');
    // Line 11 is the `<Stack` that is built and thrown away.
    expect(issue.line).toBe(11);
    expect(issue.description).toContain('line 11');
    expect(issue.fix).toContain('return (');
  }, 60_000);

  it('is silent once the same source returns that tree — the check reads the return, not the JSX', async () => {
    expect(RETURNS).toContain('return (');
    expect(rendersNothing(await runTier0Checks(RETURNS))).toEqual([]);
  }, 60_000);

  it.each([
    [
      'a concise arrow body returns by construction',
      `import React from 'react';\ninterface Props { a: string }\nexport default (props: Props) => <div>{props.a}</div>;\n`,
    ],
    [
      'a named const arrow with a parenthesised body',
      `import React from 'react';\ninterface Props { a: string }\nconst Component = (props: Props) => (\n  <div>{props.a}</div>\n);\nexport default Component;\n`,
    ],
    [
      'an expression the detector cannot resolve to a function stays its own business',
      `import React from 'react';\nimport { memo } from 'react';\ninterface Props { a: string }\nfunction Inner(props: Props) {\n  return <div>{props.a}</div>;\n}\nexport default memo(Inner);\n`,
    ],
    [
      'a return with no parentheses',
      `import React from 'react';\ninterface Props { a: string }\nexport default function Component(props: Props) {\n  return <div>{props.a}</div>;\n}\n`,
    ],
    [
      'an early return is still a return',
      `import React from 'react';\ninterface Props { a?: string }\nexport default function Component(props: Props) {\n  if (!props.a) return null;\n  return <div>{props.a}</div>;\n}\n`,
    ],
  ])('stays silent: %s', async (_name, source) => {
    expect(rendersNothing(await runTier0Checks(source))).toEqual([]);
  }, 60_000);

  it("a helper's return is not the component's own — the walk stops at every nested function boundary", async () => {
    const source = `import React from 'react';
interface Props { a: string }
export default function Component(props: Props) {
  function Row() {
    return <span>{props.a}</span>;
  }

  <div><Row /></div>
}
`;
    const found = rendersNothing(await runTier0Checks(source));
    expect(found.length).toBe(1);
    expect(found[0]!.line).toBe(8);
  }, 60_000);

  it('documented miss: one own-level value return anywhere satisfies the check, even when the tree below it is dropped', async () => {
    // Conservatism has a price and this is it. A false fail costs a real
    // generation a repair turn, so the rule asks for a return and stops
    // there rather than reasoning about which return is the component's
    // real one. If this shape ever shows up in a take, tighten HERE.
    const source = `import React from 'react';
interface Props { a?: string }
export default function Component(props: Props) {
  if (!props.a) return null;

  <div>{props.a}</div>
}
`;
    expect(rendersNothing(await runTier0Checks(source))).toEqual([]);
  }, 60_000);
});
