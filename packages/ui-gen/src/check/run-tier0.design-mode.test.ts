/**
 * Tier-0 gating per `designMode`.
 *
 * `free` gates OFF only the design-VOCABULARY legs (`raw-spacing`,
 * `raw-pixels`, `numeric-spacing-prop`, `stack-row-*`, `clickable-wrapper`)
 * and retargets the double-wired-action detector at raw elements; every
 * contract leg (color tokens, fallback ban, manifest, imports, security,
 * Props / default export, wire_*) fires in BOTH modes. `constrained`
 * (the default) is byte-identical to the pre-`designMode` gate — the
 * same fixtures run through it unchanged.
 */
import { describe, expect, it } from 'vitest';
import { runTier0Checks } from './run-tier0.js';
import type { EvalIssue } from '../evaluation/types-public.js';

const fails = (issues: EvalIssue[]): string[] =>
  issues.filter((i) => i.result === 'fail').map((i) => `${i.category}:${i.subcategory ?? ''}`);
const subcats = (issues: EvalIssue[], result: 'fail' | 'warn'): string[] =>
  issues.filter((i) => i.result === result).map((i) => i.subcategory ?? '');

/**
 * A free-design component: raw HTML + inline CSS + a `<style>` block with
 * a media query, one optional design primitive with a LITERAL gap, and
 * every color on a bare `var(--ggui-color-*)` manifest token.
 */
const FREE_DESIGN_FIXTURE = `
import React, { useState } from 'react';
import { Stack } from '@ggui-ai/design';

interface Props {
  title: string;
  items?: Array<{ id: string; label: string }>;
}

export default function Component(props: Props) {
  const [open, setOpen] = useState(false);
  const items = props.items ?? [];
  return (
    <section className="root" style={{ width: '100%', padding: '20px', background: 'var(--ggui-color-ground)', color: 'var(--ggui-color-onGround)' }}>
      <style>{\`
        .root { font-family: var(--ggui-font-family-sans); border-radius: 14px; }
        .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
        @media (min-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); } }
        .tile { border: 1px solid var(--ggui-color-outline); padding: 16px; border-radius: 10px; }
        .tile:focus-visible { outline: 2px solid var(--ggui-color-primary-500); }
      \`}</style>
      <h1 style={{ fontSize: 'clamp(1.25rem, 2vw, 2rem)', margin: 0 }}>{props.title}</h1>
      <Stack gap="12px">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ padding: '8px 14px', background: 'var(--ggui-color-primary-600)', color: 'var(--ggui-color-onPrimary)', border: 'none', borderRadius: 8 }}>
          {open ? 'Hide' : 'Show'} details
        </button>
        {open && (
          <ul className="grid" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((it) => (
              <li key={it.id} className="tile">{it.label}</li>
            ))}
          </ul>
        )}
      </Stack>
    </section>
  );
}
`;

/** Same component, one hex literal in the `<style>` block. */
const HEX_VARIANT = FREE_DESIGN_FIXTURE.replace(
  "border: 1px solid var(--ggui-color-outline);",
  'border: 1px solid #e5e7eb;',
);

/** Raw double-fire: `<button onClick>` inside a `<div onClick>` — both dispatch the same `useAction` binding. */
const RAW_DOUBLE_FIRE = `
import React from 'react';
import { useAction } from '@ggui-ai/wire';

interface Props { todos: Array<{ id: string; title: string }> }

export default function Component(props: Props) {
  const toggle = useAction('toggleTodo');
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {(props.todos ?? []).map((t) => (
        <li key={t.id}>
          <div role="button" tabIndex={0} onClick={() => toggle({ id: t.id })} style={{ padding: '12px', color: 'var(--ggui-color-onSurface)' }}>
            <span>{t.title}</span>
            <button type="button" aria-label="Toggle" onClick={() => toggle({ id: t.id })}>✓</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
`;

/** Design-package double-fire (the scenario-7 shape) — fails in both modes. */
const PRIMITIVE_DOUBLE_FIRE = `
import React from 'react';
import { Card, Clickable, Checkbox, Stack } from '@ggui-ai/design';
import { useAction } from '@ggui-ai/wire';

interface Props { todos: Array<{ id: string }> }

export default function Component(props: Props) {
  const toggle = useAction('toggleTodo');
  return (
    <Stack>
      {(props.todos ?? []).map((t) => (
        <Card as={Clickable} onClick={() => toggle({ id: t.id })} key={t.id}>
          <Checkbox checked={false} onChange={() => toggle({ id: t.id })} />
        </Card>
      ))}
    </Stack>
  );
}
`;

const CONTRACT = {
  actionSpec: { toggleTodo: { label: 'Toggle', schema: { type: 'object', properties: { id: { type: 'string' } } } } },
} as const;

describe('runTier0Checks — designMode gating', () => {
  it('free-design fixture: PASSES in free mode, FAILS in constrained on raw-spacing', async () => {
    const free = await runTier0Checks(FREE_DESIGN_FIXTURE, undefined, undefined, undefined, 'free');
    expect(fails(free)).toEqual([]);
    // The gated legs are silent in free mode — not even as warnings.
    for (const gated of ['raw-spacing', 'raw-pixels', 'numeric-spacing-prop', 'clickable-wrapper', 'stack-row-padding']) {
      expect(free.map((i) => i.subcategory)).not.toContain(gated);
    }

    const constrained = await runTier0Checks(FREE_DESIGN_FIXTURE);
    expect(fails(constrained)).toContain('tokens:raw-spacing');
    expect(subcats(constrained, 'warn')).toContain('raw-pixels');
    // Explicit-default call is the same gate.
    const explicit = await runTier0Checks(FREE_DESIGN_FIXTURE, undefined, undefined, undefined, 'constrained');
    expect(fails(explicit)).toEqual(fails(constrained));
  }, 60_000);

  it('hex-color variant FAILS in both modes (color stays tokenized)', async () => {
    const free = await runTier0Checks(HEX_VARIANT, undefined, undefined, undefined, 'free');
    const constrained = await runTier0Checks(HEX_VARIANT);
    expect(fails(free)).toContain('tokens:hex-color');
    expect(fails(constrained)).toContain('tokens:hex-color');
  }, 60_000);

  it('token-fallback, named-color and off-manifest-token FAIL in both modes', async () => {
    const src = `
interface Props { x: string }
export default function Component(props: Props) {
  return (
    <div style={{ color: 'var(--ggui-color-onSurface, #111)', background: 'var(--ggui-color-nope-500)' }}>
      <span style={{ color: 'red' }}>{props.x}</span>
    </div>
  );
}`;
    for (const mode of ['constrained', 'free'] as const) {
      const issues = await runTier0Checks(src, undefined, undefined, undefined, mode);
      const f = fails(issues);
      expect(f).toContain('tokens:token-fallback');
      expect(f).toContain('tokens:named-color');
      expect(f).toContain('tokens:off-manifest-token');
    }
  }, 60_000);

  it('raw double-fire (button inside a clickable div, same binding) FAILS in free mode with the retargeted detector', async () => {
    const free = await runTier0Checks(RAW_DOUBLE_FIRE, CONTRACT, undefined, undefined, 'free');
    const certain = free.filter((i) => i.subcategory === 'double-wired-action:certain');
    expect(certain).toHaveLength(1);
    expect(certain[0]!.result).toBe('fail');
    expect(certain[0]!.severity).toBe('critical');
    expect(certain[0]!.description).toContain('outer <div>');
    expect(certain[0]!.description).toContain('inner <button>');
    expect(certain[0]!.fix).toContain('ONE gesture surface');
    expect(certain[0]!.fix).not.toContain('as={...}');
  }, 60_000);

  it('raw double-fire in constrained mode keeps the pre-designMode verdict (warn-level broad detector only — INVARIANT 1)', async () => {
    // The constrained detector only recognises the design-package host
    // tags (`Card|Box|Stack|Row as={Clickable}`), so a raw `<div onClick>`
    // host is NOT a `:certain` fail there — it never was. Making it one
    // would change constrained tier-0 output, which INVARIANT 1 forbids.
    const constrained = await runTier0Checks(RAW_DOUBLE_FIRE, CONTRACT);
    expect(constrained.filter((i) => i.subcategory === 'double-wired-action:certain')).toHaveLength(0);
    const broad = constrained.filter((i) => i.subcategory === 'double-wired-action');
    expect(broad).toHaveLength(1);
    expect(broad[0]!.result).toBe('warn');
  }, 60_000);

  it('design-package double-fire (Card as={Clickable} + Checkbox, same binding) FAILS in both modes', async () => {
    for (const mode of ['constrained', 'free'] as const) {
      const issues = await runTier0Checks(PRIMITIVE_DOUBLE_FIRE, CONTRACT, undefined, undefined, mode);
      const certain = issues.filter((i) => i.subcategory === 'double-wired-action:certain');
      expect(certain, mode).toHaveLength(1);
      expect(certain[0]!.result).toBe('fail');
    }
  }, 60_000);

  it('free mode catches the double-fire on the BOILERPLATE-shaped generic hook line `useAction<T>(…)`; constrained never collected that binding (pre-existing gap, kept for INVARIANT 1)', async () => {
    const generic = RAW_DOUBLE_FIRE.replace(
      "const toggle = useAction('toggleTodo');",
      "type ActionToggleTodoPayload = { id: string };\n  const toggle = useAction<ActionToggleTodoPayload>('toggleTodo');",
    );
    const free = await runTier0Checks(generic, CONTRACT, undefined, undefined, 'free');
    expect(free.filter((i) => i.subcategory === 'double-wired-action:certain')).toHaveLength(1);
    const constrained = await runTier0Checks(generic, CONTRACT);
    expect(constrained.filter((i) => i.subcategory?.startsWith('double-wired-action'))).toHaveLength(0);
  }, 60_000);

  it('free mode still fails the contract legs: imports, security, Props, default export, wire_undeclared', async () => {
    const src = `
import lodash from 'lodash';
export function NotDefault() {
  fetch('/x');
  return <div />;
}`;
    const issues = await runTier0Checks(src, {}, undefined, undefined, 'free');
    const f = fails(issues);
    expect(f).toContain('imports:');
    expect(f).toContain('security:fetch');
    expect(f).toContain('types:props-interface');
    expect(f).toContain('compile:default-export');

    const undeclared = `
import { useAction } from '@ggui-ai/wire';
interface Props { x: string }
export default function Component(props: Props) {
  const go = useAction('ghost');
  return <button type="button" onClick={() => go()}>{props.x}</button>;
}`;
    const u = await runTier0Checks(undeclared, {}, undefined, undefined, 'free');
    expect(fails(u)).toContain('contract:wire_undeclared:action:ghost');
  }, 60_000);

  it('raw-pixels fix string no longer suggests a literal fallback (constrained)', async () => {
    const src = `
interface Props { x: string }
export default function C(props: Props) {
  return <div style={{ padding: '16px' }}>{props.x}</div>;
}`;
    const issues = await runTier0Checks(src);
    const px = issues.find((i) => i.subcategory === 'raw-pixels');
    expect(px).toBeDefined();
    expect(px!.fix).not.toContain(', fallback)');
    expect(px!.fix).toContain('no literal fallback');
  }, 60_000);
});
