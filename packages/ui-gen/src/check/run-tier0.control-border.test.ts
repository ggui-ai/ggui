// ggui#1697 — a kit control's boundary is the kit's: an inline border on a kit control is a tier-0 fail, enforcing the
// prompt's rule 5. Read brace-aware, so an attribute holding `=>` before the style does not hide it.
import { describe, expect, it } from 'vitest';
import { runTier0Checks } from './run-tier0.js';

const card = (body: string, extra = ''): string => `
import React from 'react';
import { Button, Input } from '@ggui-ai/design/primitives';

interface Props {
  title: string;
}
${extra}
export default function MyComponent({ title }: Props) {
  return (
    <div style={{ padding: 'var(--ggui-spacing-md)' }}>
      <h1 style={{ color: 'var(--ggui-color-onContainer)' }}>{title}</h1>
      ${body}
    </div>
  );
}
`;

const fires = async (source: string, mode?: 'constrained' | 'free') =>
  (await runTier0Checks(source, undefined, undefined, undefined, mode)).filter((i) => i.subcategory === 'control-inline-border');

describe('control-inline-border (ggui#1697)', () => {
  it('flags the served hello chip: an inline borderColor after an onClick arrow, on a multi-line style', async () => {
    const chip = `<Button
        variant="outline"
        onClick={() => {
          console.log(title);
        }}
        style={{
          borderRadius: 'var(--ggui-shape-radius-full)',
          borderColor: 'var(--ggui-color-primary-200)',
        }}
      >
        Get started
      </Button>`;
    const hit = await fires(card(chip));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ result: 'fail', severity: 'critical', category: 'tokens' });
    // The description starts with the check's id, so a host's logged violation lines can be counted per generation.
    expect(hit[0]?.description.startsWith('control-inline-border:')).toBe(true);
    expect(hit[0]?.description).toContain('borderColor');
  }, 60_000);

  it('reads a style object declared in the same file', async () => {
    const hit = await fires(card('<Button variant="outline" style={chipStyle}>Go</Button>', "const chipStyle = { borderRadius: '999px', border: '1px solid var(--ggui-color-primary-200)' };"));
    expect(hit.map((i) => i.description)).toEqual([expect.stringContaining('`border`')]);
  }, 60_000);

  it('a radius, a non-control element, or a control with no border passes', async () => {
    expect(await fires(card(`<Button variant="outline" style={{ borderRadius: 'var(--ggui-shape-radius-full)' }}>Go</Button>`))).toHaveLength(0);
    expect(await fires(card(`<div style={{ borderColor: 'var(--ggui-color-primary-200)' }}>rule</div>`))).toHaveLength(0);
    expect(await fires(card(`<Input placeholder="Name" />`))).toHaveLength(0);
  }, 60_000);

  it('other kit controls are covered too', async () => {
    const hit = await fires(card(`<Input placeholder="Name" style={{ borderWidth: 2 }} />`));
    expect(hit).toHaveLength(1);
  }, 60_000);

  it('the free design mode, where inline CSS is first-class, does not run it', async () => {
    expect(await fires(card(`<Button style={{ borderColor: 'var(--ggui-color-primary-200)' }}>Go</Button>`), 'free')).toHaveLength(0);
  }, 60_000);
});
