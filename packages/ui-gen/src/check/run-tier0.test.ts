import { describe, it, expect } from 'vitest';
import { runTier0Checks, runTier0 } from './run-tier0.js';
import {
  isBlocked,
  getActionableIssues,
  DEFAULT_QUALITY_CONFIG,
  type EvalResult,
} from '../evaluation/types-public.js';
import type { DataContract } from '@ggui-ai/protocol';

// =============================================================================
// Helpers
// =============================================================================

/** Minimal valid component source code that passes all tier 0 checks. */
const CLEAN_SOURCE = `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';

interface Props {
  title: string;
  count?: number;
}

export default function MyComponent({ title, count = 0 }: Props) {
  return (
    <div style={{ padding: 'var(--ggui-spacing-md, 16px)' }}>
      <h1 style={{ color: 'var(--ggui-color-onSurface, #1a1a2e)' }}>{title}</h1>
      <Button>{count}</Button>
    </div>
  );
}
`;

const COMPILED_OUTPUT = '/* compiled JS output */';

// =============================================================================
// runTier0Checks — clean code
// =============================================================================

describe('runTier0Checks', () => {
  // The first runTier0Checks call in the file bears a one-time
  // cold-start cost (module + check-harness warm-up). The default 5s
  // timeout flakes under CI load — give it generous headroom.
  it('clean code produces no fail issues', async () => {
    const issues = await runTier0Checks(CLEAN_SOURCE, COMPILED_OUTPUT);
    const fails = issues.filter(i => i.result === 'fail');
    expect(fails).toHaveLength(0);
  }, 30_000);

  // ── Security ────────────────────────────────────────────

  it('fails on eval()', async () => {
    const code = `
interface Props { x: string }
export default function C(props: Props) {
  const result = eval("1+1");
  return <div>{result}</div>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const evalIssues = issues.filter(i => i.category === 'security' && i.subcategory === 'eval');
    expect(evalIssues).toHaveLength(1);
    expect(evalIssues[0].result).toBe('fail');
    expect(evalIssues[0].severity).toBe('critical');
    expect(evalIssues[0].line).toBeDefined();
  });

  it('fails on fetch()', async () => {
    const code = `
interface Props { url: string }
export default function C(props: Props) {
  fetch("/api/data").then(r => r.json());
  return <div>loading</div>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const fetchIssues = issues.filter(i => i.category === 'security' && i.subcategory === 'fetch');
    expect(fetchIssues).toHaveLength(1);
    expect(fetchIssues[0].result).toBe('fail');
    expect(fetchIssues[0].severity).toBe('critical');
  });

  // ── Imports ─────────────────────────────────────────────

  it('fails on forbidden imports (e.g., axios)', async () => {
    const code = `
import axios from 'axios';
interface Props { x: string }
export default function C(props: Props) { return <div />; }`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const importIssues = issues.filter(i => i.category === 'imports');
    expect(importIssues).toHaveLength(1);
    expect(importIssues[0].result).toBe('fail');
    expect(importIssues[0].description).toContain('axios');
  });

  it('allows react imports', async () => {
    const code = `
import React, { useState } from 'react';
interface Props { x: string }
export default function C(props: Props) { return <div />; }`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const importIssues = issues.filter(i => i.category === 'imports');
    expect(importIssues).toHaveLength(0);
  });

  it('allows @ggui-ai/design imports', async () => {
    const code = `
import { Button } from '@ggui-ai/design/primitives';
interface Props { x: string }
export default function C(props: Props) { return <Button />; }`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const importIssues = issues.filter(i => i.category === 'imports');
    expect(importIssues).toHaveLength(0);
  });

  it('allows @ggui-ai/wire imports', async () => {
    const code = `
import { useWire } from '@ggui-ai/wire';
interface Props { x: string }
export default function C(props: Props) { return <div />; }`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const importIssues = issues.filter(i => i.category === 'imports');
    expect(importIssues).toHaveLength(0);
  });

  // ── Design tokens ───────────────────────────────────────

  it('FAILS self-check on hardcoded hex colors (promoted from warn 2026-05-07)', async () => {
    const code = `
interface Props { x: string }
export default function C(props: Props) {
  return <div style={{ color: '#ff0000' }}>red</div>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const hexIssues = issues.filter(i => i.category === 'tokens' && i.subcategory === 'hex-color');
    expect(hexIssues).toHaveLength(1);
    expect(hexIssues[0].result).toBe('fail');
    expect(hexIssues[0].severity).toBe('critical');
    expect(hexIssues[0].description).toContain('#ff0000');
    expect(hexIssues[0].description).toContain('breaks theme switching');
  });

  it('allows hex in CSS variable fallbacks', async () => {
    const code = `
interface Props { x: string }
export default function C(props: Props) {
  return <div style={{ color: 'var(--ggui-color-primary, #0284c7)' }}>blue</div>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const hexIssues = issues.filter(i => i.category === 'tokens' && i.subcategory === 'hex-color');
    expect(hexIssues).toHaveLength(0);
  });

  it('FAILS self-check on a raw CSS length in a spacing prop (D4)', async () => {
    const code = `
interface Props { x: string }
export default function C(props: Props) {
  return <Stack gap="8px"><Text>{props.x}</Text></Stack>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const spacing = issues.filter(i => i.category === 'tokens' && i.subcategory === 'raw-spacing');
    expect(spacing).toHaveLength(1);
    expect(spacing[0].result).toBe('fail');
    expect(spacing[0].description).toContain('raw CSS length');
  });

  it('allows a spacing-scale name and a numeric escape', async () => {
    const code = `
interface Props { x: string }
export default function C(props: Props) {
  return <Stack gap="md"><Card padding={12}>{props.x}</Card></Stack>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const spacing = issues.filter(i => i.category === 'tokens' && i.subcategory === 'raw-spacing');
    expect(spacing).toHaveLength(0);
  });

  it('warns on raw pixel values in spacing', async () => {
    const code = `
interface Props { x: string }
export default function C(props: Props) {
  return <div style={{ padding: '16px' }}>spaced</div>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const pxIssues = issues.filter(i => i.category === 'tokens' && i.subcategory === 'raw-pixels');
    expect(pxIssues).toHaveLength(1);
    expect(pxIssues[0].result).toBe('warn');
  });

  it('warns (broad regex) AND fails (narrow AST) on Card as={Clickable} + Checkbox onChange same binding', async () => {
    // The scenario-7 bug shape. Both rules fire:
    //   - broad regex `double-wired-action` → WARN (FP-prone detector,
    //     teaches the LLM toward cleaner patterns)
    //   - narrow AST `double-wired-action:certain` → FAIL + critical
    //     (near-zero FP, blocks gen) — the runtime dedup in @ggui-ai/wire
    //     catches the SYMPTOM; this catches the CAUSE one turn earlier
    //     so the broken a11y nest never ships.
    const code = `
import { useAction } from '@ggui-ai/wire';
interface Props { todos: Array<{ id: string }> }
export default function C(props: Props) {
  const toggle = useAction('toggleTodo');
  return (
    <Stack>
      {props.todos.map((t) => (
        <Card as={Clickable} onClick={() => toggle({ id: t.id })} key={t.id}>
          <Checkbox checked={false} onChange={() => toggle({ id: t.id })} />
        </Card>
      ))}
    </Stack>
  );
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const dwWarn = issues.filter((i) => i.subcategory === 'double-wired-action');
    expect(dwWarn).toHaveLength(1);
    expect(dwWarn[0].result).toBe('warn');

    const dwFail = issues.filter(
      (i) => i.subcategory === 'double-wired-action:certain',
    );
    expect(dwFail).toHaveLength(1);
    expect(dwFail[0].result).toBe('fail');
    expect(dwFail[0].severity).toBe('critical');
    expect(dwFail[0].category).toBe('interactivity');
    // Diagnostic names the outer + inner tags so the LLM has a precise
    // remediation target.
    expect(dwFail[0].description).toContain('Card');
    expect(dwFail[0].description).toContain('Checkbox');
    expect(dwFail[0].description).toContain('toggle');
  });

  it('narrow AST: catches Box as={Pressable} + Button onClick same binding', async () => {
    const code = `
import { useAction } from '@ggui-ai/wire';
interface Props { id: string }
export default function C(props: Props) {
  const submit = useAction('submit');
  return (
    <Box as={Pressable} onPress={() => submit({ id: props.id })}>
      <Button onClick={() => submit({ id: props.id })}>Confirm</Button>
    </Box>
  );
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const dwFail = issues.filter(
      (i) => i.subcategory === 'double-wired-action:certain',
    );
    expect(dwFail).toHaveLength(1);
    expect(dwFail[0].result).toBe('fail');
  });

  it('narrow AST: deeply nested inner interactive (Card > Stack > Row > Checkbox) still caught', async () => {
    const code = `
import { useAction } from '@ggui-ai/wire';
interface Props { id: string }
export default function C(props: Props) {
  const toggle = useAction('toggle');
  return (
    <Card as={Clickable} onClick={() => toggle({ id: props.id })}>
      <Stack>
        <Row>
          <Checkbox checked={false} onChange={() => toggle({ id: props.id })} />
        </Row>
      </Stack>
    </Card>
  );
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const dwFail = issues.filter(
      (i) => i.subcategory === 'double-wired-action:certain',
    );
    expect(dwFail).toHaveLength(1);
    expect(dwFail[0].result).toBe('fail');
  });

  it('narrow AST: does NOT fire when outer Card has NO as={Trait}', async () => {
    // Plain Card is not a trait host — no click semantics on the
    // outer. Inner Checkbox owns the gesture cleanly.
    const code = `
import { useAction } from '@ggui-ai/wire';
interface Props { id: string }
export default function C(props: Props) {
  const toggle = useAction('toggle');
  return (
    <Card onClick={() => toggle({ id: props.id })}>
      <Checkbox checked={false} onChange={() => toggle({ id: props.id })} />
    </Card>
  );
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const dwFail = issues.filter(
      (i) => i.subcategory === 'double-wired-action:certain',
    );
    expect(dwFail).toHaveLength(0);
  });

  it('narrow AST: does NOT fire when outer + inner call DIFFERENT useAction bindings', async () => {
    // Two distinct gestures, different actions. No double-fire.
    const code = `
import { useAction } from '@ggui-ai/wire';
interface Props { id: string }
export default function C(props: Props) {
  const select = useAction('select');
  const toggle = useAction('toggle');
  return (
    <Card as={Clickable} onClick={() => select({ id: props.id })}>
      <Checkbox checked={false} onChange={() => toggle({ id: props.id })} />
    </Card>
  );
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const dwFail = issues.filter(
      (i) => i.subcategory === 'double-wired-action:certain',
    );
    expect(dwFail).toHaveLength(0);
  });

  it('narrow AST: does NOT fire when inner is non-interactive (Text / Heading)', async () => {
    // Card as={Clickable} wrapping a Text label — no bubble path,
    // gesture lives on the Card alone.
    const code = `
import { useAction } from '@ggui-ai/wire';
interface Props { id: string }
export default function C(props: Props) {
  const select = useAction('select');
  return (
    <Card as={Clickable} onClick={() => select({ id: props.id })}>
      <Text>Select me</Text>
    </Card>
  );
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const dwFail = issues.filter(
      (i) => i.subcategory === 'double-wired-action:certain',
    );
    expect(dwFail).toHaveLength(0);
  });

  it('narrow AST: does NOT fire on sibling buttons that share a binding (no nesting)', async () => {
    // Two distinct interactive surfaces, neither nests in the other —
    // the bubble bug cannot manifest here even with the same binding.
    const code = `
import { useAction } from '@ggui-ai/wire';
interface Props { id: string }
export default function C(props: Props) {
  const submit = useAction('submit');
  return (
    <Stack>
      <Button onClick={() => submit({ id: props.id })}>Yes</Button>
      <Button onClick={() => submit({ id: props.id })}>No</Button>
    </Stack>
  );
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const dwFail = issues.filter(
      (i) => i.subcategory === 'double-wired-action:certain',
    );
    expect(dwFail).toHaveLength(0);
    // Broad regex still warns about 2+ call sites — that's its job.
    const dwWarn = issues.filter(
      (i) => i.subcategory === 'double-wired-action',
    );
    expect(dwWarn).toHaveLength(1);
    expect(dwWarn[0].result).toBe('warn');
  });

  it('narrow AST: does NOT fire when handler indirects through a helper (runtime dedup catches at runtime)', async () => {
    // Same source-level callee identifier ('fire') in both handlers,
    // but it's a helper, not a useAction binding. The detector should
    // skip — only outerCallee that matches a registered useAction
    // binding qualifies. The runtime dedup remains the structural
    // backstop for this and similar indirection patterns.
    const code = `
import { useAction } from '@ggui-ai/wire';
interface Props { id: string }
export default function C(props: Props) {
  const toggle = useAction('toggle');
  const fire = (id) => toggle({ id });
  return (
    <Card as={Clickable} onClick={() => fire(props.id)}>
      <Checkbox checked={false} onChange={() => fire(props.id)} />
    </Card>
  );
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const dwFail = issues.filter(
      (i) => i.subcategory === 'double-wired-action:certain',
    );
    expect(dwFail).toHaveLength(0);
  });

  it('does NOT flag a useAction callback wired to exactly one surface', async () => {
    const code = `
import { useAction } from '@ggui-ai/wire';
interface Props { todos: Array<{ id: string }> }
export default function C(props: Props) {
  const toggle = useAction('toggleTodo');
  return (
    <Stack>
      {props.todos.map((t) => (
        <Card key={t.id}>
          <Checkbox checked={false} onChange={() => toggle({ id: t.id })} />
        </Card>
      ))}
    </Stack>
  );
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    expect(
      issues.filter((i) => i.subcategory === 'double-wired-action'),
    ).toHaveLength(0);
  });

  it('FAILS self-check on hardcoded rgba()/hsl() color functions (promoted from warn 2026-05-07)', async () => {
    const code = `
interface Props { x: string }
export default function C(props: Props) {
  return <div style={{ background: 'rgba(0, 0, 0, 0.5)' }}>overlay</div>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const colorFnIssues = issues.filter(i => i.category === 'tokens' && i.subcategory === 'hardcoded-color-fn');
    expect(colorFnIssues).toHaveLength(1);
    expect(colorFnIssues[0].result).toBe('fail');
    expect(colorFnIssues[0].severity).toBe('critical');
    expect(colorFnIssues[0].description).toContain('breaks theme switching');
  });

  describe('Box assetColor + assetSemantic typed escape (T-4)', () => {
    it('FAILS on hex outside assetColor (style override)', async () => {
      const code = `
import { Box } from '@ggui-ai/design/primitives';
interface Props { x: string }
export default function C(props: Props) {
  return <Box style={{ background: '#FF0000' }}>x</Box>;
}`;
      const issues = await runTier0Checks(code, COMPILED_OUTPUT);
      const hexIssues = issues.filter(
        (i) => i.category === 'tokens' && i.subcategory === 'hex-color',
      );
      expect(hexIssues).toHaveLength(1);
      expect(hexIssues[0].result).toBe('fail');
    });

    it('FAILS on assetColor without assetSemantic', async () => {
      const code = `
import { Box } from '@ggui-ai/design/primitives';
interface Props { x: string }
export default function C(props: Props) {
  return <Box assetColor="#FF0000">x</Box>;
}`;
      const issues = await runTier0Checks(code, COMPILED_OUTPUT);
      const pairIssues = issues.filter(
        (i) => i.category === 'tokens' && i.subcategory === 'asset-color-pair',
      );
      expect(pairIssues).toHaveLength(1);
      expect(pairIssues[0].result).toBe('fail');
      expect(pairIssues[0].severity).toBe('critical');
    });

    it('FAILS on assetColor with empty assetSemantic', async () => {
      const code = `
import { Box } from '@ggui-ai/design/primitives';
interface Props { x: string }
export default function C(props: Props) {
  return <Box assetColor="#FF0000" assetSemantic="">x</Box>;
}`;
      const issues = await runTier0Checks(code, COMPILED_OUTPUT);
      const pairIssues = issues.filter(
        (i) => i.category === 'tokens' && i.subcategory === 'asset-color-pair',
      );
      expect(pairIssues).toHaveLength(1);
      expect(pairIssues[0].result).toBe('fail');
    });

    it('PASSES on assetColor + non-empty assetSemantic (typed escape allows hex)', async () => {
      const code = `
import { Box } from '@ggui-ai/design/primitives';
interface Props { x: string }
export default function C(props: Props) {
  return <Box assetColor="#FF0000" assetSemantic="brand-stripe-purple">x</Box>;
}`;
      const issues = await runTier0Checks(code, COMPILED_OUTPUT);
      const tokenIssues = issues.filter((i) => i.category === 'tokens');
      // No hex / pair / colorFn / named-color failures from the typed escape.
      expect(tokenIssues.filter((i) => i.result === 'fail')).toHaveLength(0);
    });

    it('PASSES even when the assetColor + assetSemantic span multiple lines', async () => {
      const code = `
import { Box } from '@ggui-ai/design/primitives';
interface Props { x: string }
export default function C(props: Props) {
  return (
    <Box
      assetColor="#635BFF"
      assetSemantic="stripe-brand-purple"
    >
      x
    </Box>
  );
}`;
      const issues = await runTier0Checks(code, COMPILED_OUTPUT);
      const tokenIssues = issues.filter(
        (i) => i.category === 'tokens' && i.result === 'fail',
      );
      expect(tokenIssues).toHaveLength(0);
    });
  });

  describe('named-color CSS keywords (T-5 residual-escape closer)', () => {
    it.each([
      ['lime',     `<div style={{ color: 'lime' }}>green</div>`],
      ['red',      `<div style={{ background: 'red' }}>red</div>`],
      ['royalblue',`<div style={{ color: 'royalblue' }}>blue</div>`],
      ['black',    `<div style={{ backgroundColor: 'black' }}>dark</div>`],
      ['purple',   `<div style={{ borderColor: 'purple' }}>edge</div>`],
    ])('FAILS self-check on style={{ ...: %s }} (named-color "%s")', async (named, jsx) => {
      const code = `
interface Props { x: string }
export default function C(props: Props) { return ${jsx}; }`;
      const issues = await runTier0Checks(code, COMPILED_OUTPUT);
      const namedIssues = issues.filter(i => i.category === 'tokens' && i.subcategory === 'named-color');
      expect(namedIssues).toHaveLength(1);
      expect(namedIssues[0].result).toBe('fail');
      expect(namedIssues[0].description).toContain(named);
    });

    it.each([
      ['inherit'],
      ['currentColor'],
      ['transparent'],
      ['none'],
    ])('ALLOWS keyword "%s" (legitimate semantic value)', async (keyword) => {
      const code = `
interface Props { x: string }
export default function C(props: Props) {
  return <div style={{ color: '${keyword}' }}>x</div>;
}`;
      const issues = await runTier0Checks(code, COMPILED_OUTPUT);
      const namedIssues = issues.filter(i => i.category === 'tokens' && i.subcategory === 'named-color');
      expect(namedIssues).toHaveLength(0);
    });

    it('does NOT flag a non-named-color string (token-name like "primary" is caught by a different validator)', async () => {
      const code = `
interface Props { x: string }
export default function C(props: Props) {
  return <div style={{ color: 'primary' }}>x</div>;
}`;
      const issues = await runTier0Checks(code, COMPILED_OUTPUT);
      const namedIssues = issues.filter(i => i.category === 'tokens' && i.subcategory === 'named-color');
      expect(namedIssues).toHaveLength(0);
    });
  });

  // ── Compile check ───────────────────────────────────────

  it('fails on null compiledCode ONLY when buildErrors were captured', async () => {
    // Pre-S6 behavior: `compiledCode === null` alone pushed a fail. That
    // treated "compile not attempted" identically to "compile failed",
    // which broke the S6 createUiGenerator wiring (that seam doesn't
    // compile in-process — the separate `withBrowserCompile` wrapper
    // does). Fix: fail only when the caller indicates compile was
    // attempted by passing a non-empty `buildErrors` array.
    const withErrors = await runTier0Checks(CLEAN_SOURCE, null, undefined, [
      '<stdin>:10:5: ERROR: Unexpected token',
    ]);
    const withErrorsCompile = withErrors.filter((i) => i.category === 'compile');
    expect(withErrorsCompile).toHaveLength(1);
    expect(withErrorsCompile[0].result).toBe('fail');
    expect(withErrorsCompile[0].severity).toBe('critical');
    expect(withErrorsCompile[0].description).toContain('Line 10: Unexpected token');

    // Without buildErrors → no compile fail (compile not attempted).
    const withoutErrors = await runTier0Checks(CLEAN_SOURCE, null);
    const withoutErrorsCompile = withoutErrors.filter((i) => i.category === 'compile');
    expect(withoutErrorsCompile).toHaveLength(0);
  });

  // ── Types ───────────────────────────────────────────────

  it('fails when Props interface is missing', async () => {
    const code = `
export default function C() {
  return <div>no props</div>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const typeIssues = issues.filter(i => i.category === 'types' && i.subcategory === 'props-interface');
    expect(typeIssues).toHaveLength(1);
    expect(typeIssues[0].result).toBe('fail');
  });

  it('fails when default export is missing', async () => {
    const code = `
interface Props { x: string }
function C(props: Props) {
  return <div>{props.x}</div>;
}`;
    const issues = await runTier0Checks(code, COMPILED_OUTPUT);
    const exportIssues = issues.filter(i => i.category === 'compile' && i.subcategory === 'default-export');
    expect(exportIssues).toHaveLength(1);
    expect(exportIssues[0].result).toBe('fail');
  });

  // ── Contract validation ─────────────────────────────────

  it('reports contract errors as fail issues', async () => {
    const code = `
interface Props {
  name: string;
}
export default function C({ name }: Props) {
  return <div>{name}</div>;
}`;
    const contract: DataContract = {
      propsSpec: {
        properties: {
          name: { schema: { type: 'string' }, required: true },
          email: { schema: { type: 'string' }, required: true },
        },
      },
    };
    const issues = await runTier0Checks(code, COMPILED_OUTPUT, contract);
    const contractIssues = issues.filter(i => i.category === 'contract');
    // Should flag missing required field 'email'
    expect(contractIssues.length).toBeGreaterThanOrEqual(1);
    const emailIssue = contractIssues.find(i => i.subcategory === 'email');
    expect(emailIssue).toBeDefined();
    expect(emailIssue!.result).toBe('fail');
  });

  it('reports contract warnings as warn issues', async () => {
    const code = `
interface Props {
  name: string;
}
export default function C({ name }: Props) {
  return <div>{name}</div>;
}`;
    const contract: DataContract = {
      propsSpec: {
        properties: {
          name: { schema: { type: 'string' }, required: true },
          bio: { schema: { type: 'string' }, required: false },
        },
      },
    };
    const issues = await runTier0Checks(code, COMPILED_OUTPUT, contract);
    const contractWarnings = issues.filter(i => i.category === 'contract' && i.result === 'warn');
    const bioWarning = contractWarnings.find(i => i.subcategory === 'bio');
    expect(bioWarning).toBeDefined();
    expect(bioWarning!.severity).toBe('major');
  });

  // ── Wire preservation (rule 14) ───

  it('fails with wire_preservation:action:<name> when contract declares an action but no useAction call exists', async () => {
    const code = `
import React from 'react';
import { useAction } from '@ggui-ai/wire';

interface Props { title: string }

export default function Component(props: Props) {
  // LLM dropped the useAction('submit') call but left a stray comment
  // referencing the name — the old substring check would miss this.
  // submit is mentioned here but never wired.
  return <div>{props.title}</div>;
}`;
    const contract: DataContract = {
      actionSpec: {
        submit: { label: 'Submit', description: 'form submit' },
      },
    };
    const issues = await runTier0Checks(code, COMPILED_OUTPUT, contract);
    const wireIssues = issues.filter(
      i => i.category === 'contract' && i.subcategory === 'wire_preservation:action:submit',
    );
    expect(wireIssues).toHaveLength(1);
    expect(wireIssues[0].result).toBe('fail');
    expect(wireIssues[0].severity).toBe('critical');
    expect(wireIssues[0].description).toContain("useAction('submit')");
    expect(wireIssues[0].fix).toContain("useAction('submit')");
  });

  it('does not fire wire_preservation when the useAction call is present', async () => {
    const code = `
import React from 'react';
import { useAction } from '@ggui-ai/wire';

interface Props { title: string }

export default function Component(props: Props) {
  const submit = useAction('submit');
  return <button onClick={() => submit()}>{props.title}</button>;
}`;
    const contract: DataContract = {
      actionSpec: {
        submit: { label: 'Submit', description: 'form submit' },
      },
    };
    const issues = await runTier0Checks(code, COMPILED_OUTPUT, contract);
    const wireIssues = issues.filter(
      i => i.category === 'contract' && typeof i.subcategory === 'string' && i.subcategory.startsWith('wire_preservation:'),
    );
    expect(wireIssues).toHaveLength(0);
  });

  it('fails wire_preservation for every contract-declared wire kind that is missing', async () => {
    // Only `foo` action is wired; stream + context slot are missing.
    // agentTools is intentionally present but should NOT generate a
    // wire_preservation finding — it is a catalog, not a hook surface.
    const code = `
import React from 'react';
import { useAction } from '@ggui-ai/wire';

interface Props { title: string }

export default function Component(props: Props) {
  const foo = useAction('foo');
  return <button onClick={() => foo()}>{props.title}</button>;
}`;
    const contract: DataContract = {
      actionSpec: { foo: { label: 'Foo' } },
      streamSpec: { bar: { description: 'bar channel', schema: { type: 'object' } } },
      contextSpec: { view: { schema: { type: 'string' }, default: 'list' } },
      agentCapabilities: { tools: { baz: { description: 'baz tool' } } },
    };
    const issues = await runTier0Checks(code, COMPILED_OUTPUT, contract);
    const wireIssues = issues.filter(
      i => i.category === 'contract' && typeof i.subcategory === 'string' && i.subcategory.startsWith('wire_preservation:'),
    );
    const subcats = wireIssues.map(i => i.subcategory).sort();
    expect(subcats).toEqual([
      'wire_preservation:context:view',
      'wire_preservation:stream:bar',
    ]);
    for (const issue of wireIssues) {
      expect(issue.result).toBe('fail');
    }
  });

  // ── All issues have tier 0 ──────────────────────────────

  it('all returned issues have tier = 0', async () => {
    const code = `
import axios from 'axios';
export default function C() {
  eval("bad");
  return <div style={{ color: '#f00' }}>x</div>;
}`;
    const issues = await runTier0Checks(code, null);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.tier).toBe(0);
    }
  });
});

// =============================================================================
// runTier0 — full EvalResult
// =============================================================================

describe('runTier0', () => {
  it('clean code has no fail issues and core categories pass', async () => {
    const result = await runTier0(CLEAN_SOURCE, COMPILED_OUTPUT);
    const fails = result.issues.filter(i => i.result === 'fail');
    expect(fails).toHaveLength(0);
    expect(result.pass).toContain('compile');
    expect(result.pass).toContain('security');
    expect(result.pass).toContain('imports');
    expect(result.pass).toContain('contract');
    // Note: 'types' and 'tokens' may have warns from sandboxed type checker
  });

  // Bench surfaced a recurring LLM hedge: when the
  // boilerplate's static `import { useLeafletMap } from
  // '@ggui-samples/gadget-leaflet'` is present, the model removes
  // the import and substitutes `require('@ggui-samples/gadget-leaflet').useLeafletMap()`
  // inline. Browser ESM has no `require`, and the import-rewriter
  // can't attach a shim without a static specifier — so the component
  // would crash on mount. The tier-0 check below flags this pattern
  // with a clear remediation message so the LLM's next-turn patch
  // converts back to a static import.
  it('rejects require() on @-scoped packages with a clear remediation', async () => {
    const code = `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  const { useLeafletMap } = require('@ggui-samples/gadget-leaflet');
  const map = useLeafletMap();
  return <Button>{props.center.join(',')}</Button>;
}
`;
    const result = await runTier0(code, COMPILED_OUTPUT);
    const requireIssue = result.issues.find(
      (i) => i.subcategory === 'require_disallowed:@ggui-samples/gadget-leaflet',
    );
    expect(requireIssue).toBeDefined();
    expect(requireIssue?.result).toBe('fail');
    expect(requireIssue?.severity).toBe('critical');
    expect(requireIssue?.fix).toContain('@ggui-samples/gadget-leaflet');
    expect(requireIssue?.fix).toContain('static');
    expect(requireIssue?.fix).toContain('import');
  });

  it('flags both STDLIB and wrapper require() patterns in the same component', async () => {
    // Two separate require() calls on @-scoped packages → two separate
    // issues, dedup'd by package. Caught even when both share the same
    // bad pattern.
    const code = `
export default function C() {
  const { useGeolocation } = require('@ggui-ai/gadgets');
  const { useLeafletMap } = require('@ggui-samples/gadget-leaflet');
  const a = useGeolocation();
  const b = useLeafletMap();
  return null;
}
`;
    const result = await runTier0(code, COMPILED_OUTPUT);
    const packages = result.issues
      .filter((i) => i.subcategory?.startsWith('require_disallowed:'))
      .map((i) => i.subcategory);
    expect(packages).toContain(
      'require_disallowed:@ggui-ai/gadgets',
    );
    expect(packages).toContain(
      'require_disallowed:@ggui-samples/gadget-leaflet',
    );
  });

  it('does NOT flag require() on non-@-scoped packages (CJS bare requires are out of scope)', async () => {
    // Hypothetical edge case — `require('fs')` etc. The check is
    // scoped to @-prefixed packages because that's the LLM's typical
    // hedge specifier shape. Bare `require()` calls on CJS-only
    // packages would be caught by a different lint (no-restricted-syntax).
    const code = `
export default function C() {
  const fs = require('fs');
  return null;
}
`;
    const result = await runTier0(code, COMPILED_OUTPUT);
    const issues = result.issues.filter((i) =>
      i.subcategory?.startsWith('require_disallowed:'),
    );
    expect(issues).toHaveLength(0);
  });

  // Preservation check adapted. `loadGadgets()` is RETIRED:
  // the boilerplate now DIRECT-imports each gadget export
  // (`import { useFoo } from '<package>'`), and the import IS the
  // runtime resolution anchor. The check FAILs when the source does
  // not import the contract-declared hook from its package, and
  // PASSes when the direct import is present.
  it('rejects a component that does not import the gadget hook from its package', async () => {
    const code = `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  // gadget import removed entirely, useLeafletMap still referenced
  const map = useLeafletMap();
  return <Button>{map ? 'ok' : props.center.join(',')}</Button>;
}
`;
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
        },
      },
    };
    const result = await runTier0(code, COMPILED_OUTPUT, contract);
    const issue = result.issues.find(
      (i) => i.subcategory === 'gadget_preservation:useLeafletMap',
    );
    expect(issue).toBeDefined();
    expect(issue?.result).toBe('fail');
    expect(issue?.severity).toBe('critical');
    expect(issue?.description).toContain(
      "does not import `useLeafletMap` from `@ggui-samples/gadget-leaflet`",
    );
  });

  it('rejects a component that imports the hook from the WRONG package', async () => {
    // The hook name appears in an import, but from a different package.
    // The direct-import anchor must point at the registered package.
    const code = `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';
import { useLeafletMap } from '@ggui-ai/gadgets';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  const map = useLeafletMap();
  return <Button>{map ? 'ok' : props.center.join(',')}</Button>;
}
`;
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
        },
      },
    };
    const result = await runTier0(code, COMPILED_OUTPUT, contract);
    const issue = result.issues.find(
      (i) => i.subcategory === 'gadget_preservation:useLeafletMap',
    );
    expect(issue).toBeDefined();
    expect(issue?.result).toBe('fail');
  });

  it('fix message names the direct-import statement and its package', async () => {
    const code = `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  return <Button>{props.center.join(',')}</Button>;
}
`;
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
        },
      },
    };
    const result = await runTier0(code, COMPILED_OUTPUT, contract);
    const issue = result.issues.find(
      (i) => i.subcategory === 'gadget_preservation:useLeafletMap',
    );
    expect(issue).toBeDefined();
    expect(issue?.fix).toContain(
      "import { useLeafletMap } from '@ggui-samples/gadget-leaflet';",
    );
    // The fix's example call site uses the derived binding name
    // (`useLeafletMap` → `leafletMap`).
    expect(issue?.fix).toContain('const leafletMap = useLeafletMap(');
  });

  it('passes when the contract-declared hook is direct-imported from its package', async () => {
    const code = `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';
import { useLeafletMap } from '@ggui-samples/gadget-leaflet';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  const map = useLeafletMap();
  return <Button>{map ? 'ok' : props.center.join(',')}</Button>;
}
`;
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
        },
      },
    };
    const result = await runTier0(code, COMPILED_OUTPUT, contract);
    const preservationFails = result.issues.filter((i) =>
      i.subcategory?.startsWith('gadget_preservation:'),
    );
    expect(preservationFails).toHaveLength(0);
  });

  it('accepts the import-alias form (`import { useFoo as foo }`)', async () => {
    // The check matches the SOURCE name (left of `as`), so an alias on
    // the direct import still preserves the gadget binding.
    const code = `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';
import { useLeafletMap as map } from '@ggui-samples/gadget-leaflet';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  const m = map();
  return <Button>{m ? 'ok' : props.center.join(',')}</Button>;
}
`;
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
        },
      },
    };
    const result = await runTier0(code, COMPILED_OUTPUT, contract);
    const preservationFails = result.issues.filter((i) =>
      i.subcategory?.startsWith('gadget_preservation:'),
    );
    expect(preservationFails).toHaveLength(0);
  });

  it('rejects a COMPONENT gadget when its import is missing, with a RENDER fix', async () => {
    const code = `
import React from 'react';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  // component import removed; LeafletMap still referenced as JSX
  return <div><LeafletMap center={props.center} zoom={12} /></div>;
}
`;
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-leaflet': { LeafletMap: {} },
        },
      },
    };
    const result = await runTier0(code, COMPILED_OUTPUT, contract);
    const issue = result.issues.find(
      (i) => i.subcategory === 'gadget_preservation:LeafletMap',
    );
    expect(issue).toBeDefined();
    expect(issue?.result).toBe('fail');
    expect(issue?.severity).toBe('critical');
    // A component is RENDERED, not called — the fix must teach JSX.
    expect(issue?.fix).toContain('RENDER `<LeafletMap');
    expect(issue?.fix).not.toContain('CALL `LeafletMap(');
  });

  it('passes when the contract-declared COMPONENT is direct-imported', async () => {
    const code = `
import React from 'react';
import { LeafletMap } from '@ggui-samples/gadget-leaflet';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  return <LeafletMap center={props.center} zoom={12} />;
}
`;
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-leaflet': { LeafletMap: {} },
        },
      },
    };
    const result = await runTier0(code, COMPILED_OUTPUT, contract);
    const preservationFails = result.issues.filter((i) =>
      i.subcategory?.startsWith('gadget_preservation:'),
    );
    expect(preservationFails).toHaveLength(0);
  });

  it('allowlists a contract-declared gadget package as an import source', async () => {
    // Generated code direct-imports gadget exports, so every
    // `clientCapabilities.gadgets[*].package` is a permitted import
    // source — not just the STDLIB `@ggui-ai/gadgets`. A direct import
    // from `@scope/leaflet` must NOT raise a forbidden-import failure
    // when `@scope/leaflet` is declared on the contract.
    const code = `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';
import { useX } from '@scope/leaflet';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  const x = useX();
  return <Button>{x ? 'ok' : props.center.join(',')}</Button>;
}
`;
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@scope/leaflet': { useX: {} },
        },
      },
    };
    const result = await runTier0(code, COMPILED_OUTPUT, contract);
    const importFails = result.issues.filter(
      (i) => i.category === 'imports' && i.result === 'fail',
    );
    expect(importFails).toHaveLength(0);
  });

  it('still rejects an import from a package NOT declared on the contract', async () => {
    // Sanity counterpart: a gadget-shaped import from an UNDECLARED
    // package is still a forbidden import.
    const code = `
import React from 'react';
import { Button } from '@ggui-ai/design/primitives';
import { useX } from '@scope/leaflet';
interface Props { center: number[] }
export default function MyComponent(props: Props) {
  const x = useX();
  return <Button>{x ? 'ok' : props.center.join(',')}</Button>;
}
`;
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: {} },
        },
      },
    };
    const result = await runTier0(code, COMPILED_OUTPUT, contract);
    const importFails = result.issues.filter(
      (i) => i.category === 'imports' && i.result === 'fail',
    );
    expect(importFails.length).toBeGreaterThanOrEqual(1);
    expect(
      importFails.some((i) => i.description.includes('@scope/leaflet')),
    ).toBe(true);
  });

  it('failed category is not in pass list', async () => {
    const code = `
interface Props { x: string }
export default function C(props: Props) {
  eval("bad");
  return <div />;
}`;
    const result = await runTier0(code, COMPILED_OUTPUT);
    expect(result.pass).not.toContain('security');
    expect(result.pass).toContain('compile');
    expect(result.pass).toContain('imports');
  });
});

// =============================================================================
// isBlocked
// =============================================================================

describe('isBlocked', () => {
  it('returns true when there are fail issues', () => {
    const result: EvalResult = {
      issues: [
        { tier: 0, result: 'fail', category: 'security', description: 'eval', fix: 'remove' },
      ],
      pass: [],
    };
    expect(isBlocked(result)).toBe(true);
  });

  it('returns false when there are only warn issues', () => {
    const result: EvalResult = {
      issues: [
        { tier: 0, result: 'warn', category: 'tokens', description: 'hex', fix: 'use token' },
      ],
      pass: ['compile', 'security'],
    };
    expect(isBlocked(result)).toBe(false);
  });

  it('returns false when there are no issues', () => {
    const result: EvalResult = {
      issues: [],
      pass: ['compile', 'security', 'types', 'imports', 'tokens', 'contract'],
    };
    expect(isBlocked(result)).toBe(false);
  });
});

// =============================================================================
// getActionableIssues
// =============================================================================

describe('getActionableIssues', () => {
  const mixedResult: EvalResult = {
    issues: [
      { tier: 0, result: 'fail', category: 'security', description: 'eval found', fix: 'remove eval' },
      { tier: 0, result: 'warn', category: 'tokens', description: 'hex color', fix: 'use token' },
      { tier: 0, result: 'pass', category: 'compile', description: 'compiled ok', fix: '' },
    ],
    pass: ['compile'],
  };

  it('fast mode returns only fail issues', () => {
    const actionable = getActionableIssues(mixedResult, 'fast');
    expect(actionable).toHaveLength(1);
    expect(actionable[0].result).toBe('fail');
  });

  it('auto-improve mode returns fails + warns', () => {
    const actionable = getActionableIssues(mixedResult, 'auto-improve');
    expect(actionable).toHaveLength(2);
    expect(actionable.map(i => i.result)).toContain('fail');
    expect(actionable.map(i => i.result)).toContain('warn');
  });

  it('high-quality mode returns fails + warns', () => {
    const actionable = getActionableIssues(mixedResult, 'high-quality');
    expect(actionable).toHaveLength(2);
  });
});

// =============================================================================
// DEFAULT_QUALITY_CONFIG
// =============================================================================

describe('DEFAULT_QUALITY_CONFIG', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_QUALITY_CONFIG.quality).toBe('fast');
    expect(DEFAULT_QUALITY_CONFIG.visualEval).toBe(false);
    expect(DEFAULT_QUALITY_CONFIG.maxCostPerGeneration).toBe(3);
  });
});
