// ggui#1846 — the categorical tint's usage rules warn (never fail) with a repair line
// in the kit's voice. Each has a firing case and a control.
import { describe, expect, it } from 'vitest';
import { TINT_CHECKS, findTintedElements } from './tint.js';
import type { AxisCheckInput } from '../types.js';
import type { Classification } from '../../../classifier/axes.js';

const classification: Classification = {
  vector: { render: 'grid', state: 'none', writes: 'none', writeTrigger: 'click', realtime: 'none', fetch: 'none', layout: 'single', tooling: 'none' },
  provenance: { render: 'default', state: 'default', writes: 'default', writeTrigger: 'default', realtime: 'default', fetch: 'default', layout: 'default', tooling: 'default' },
  riskTier: 'low',
};
const run = (id: string, sourceCode: string) => {
  const check = TINT_CHECKS.find((c) => c.id === id);
  if (check === undefined) throw new Error(`${id} not registered`);
  const input: AxisCheckInput = { sourceCode, compiledCode: 'built', originalPrompt: '', classification };
  return check.run(input);
};

describe('findTintedElements', () => {
  it('reads the tint value and the inner JSX, nested tags included', () => {
    const els = findTintedElements('<Box tint={TINTS[el.group]} padding="sm"><Box><Text>{el.symbol}</Text></Box></Box><Card tint="tint-2" />');
    expect(els.map((e) => [e.tag, e.tint])).toEqual([['Box', '{TINTS[el.group]}'], ['Card', '"tint-2"']]);
    expect(els[0]?.inner).toBe('<Box><Text>{el.symbol}</Text></Box>');
    expect(els[1]?.inner).toBe('');
  });
});

describe('the tint WARNs (ggui#1846)', () => {
  it('tint bound to a state warns, in the repair voice', () => {
    const issues = run('universal.tint_state_bound', '<Box tint={item.isLive ? "tint-1" : "tint-2"}><Text>x</Text></Box>');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.result).toBe('warn');
    expect(issues[0]?.fix).toContain('A status takes live, draft or signal, not a tint');
  });
  it('control: tint bound to a data category stays silent', () => {
    expect(run('universal.tint_state_bound', '<Box tint={TINTS[el.group]}><Text>x</Text></Box>')).toEqual([]);
  });
  it('known false fire, measured not fixed: a legitimate category named `status` warns', () => {
    // A kanban lane keyed by a field called `status` IS a data category. This is the
    // case the pre-registered false-fire rate counts; it stays a WARN for exactly this reason.
    expect(run('universal.tint_state_bound', '<Card tint={LANE_TINTS[task.status]}><Text>x</Text></Card>')).toHaveLength(1);
  });

  it('a tinted cell with no words and no legend warns', () => {
    const issues = run('universal.tint_category_in_words', '<Grid>{cells.map((c) => <Box key={c.id} tint={TINTS[c.group]} />)}</Grid>');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.result).toBe('warn');
    expect(issues[0]?.fix).toContain('Give this cell a label, or add a legend to the card');
  });
  it('controls: a label in the cell, or a legend on the card, satisfies it', () => {
    expect(run('universal.tint_category_in_words', '<Box tint={TINTS[c.group]}><Text>{c.symbol}</Text></Box>')).toEqual([]);
    expect(run('universal.tint_category_in_words', '<Box tint={TINTS[c.group]} /><Legend items={GROUPS} />')).toEqual([]);
  });

  it('muted text on a tint warns', () => {
    const issues = run('universal.tint_muted_text', '<Box tint="tint-3"><Text>Na</Text><Text tone="subtle">Sodium</Text></Box>');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.result).toBe('warn');
  });
  it('control: ink text on a tint, and muted text beside it, are silent', () => {
    expect(run('universal.tint_muted_text', '<Stack><Box tint="tint-3"><Text>Na</Text></Box><Text tone="subtle">Sodium</Text></Stack>')).toEqual([]);
  });

  it('none of the three ever fails', () => {
    const src = '<Box tint={x.status} tone="subtle" />';
    for (const c of TINT_CHECKS) for (const i of c.run({ sourceCode: src, compiledCode: 'built', originalPrompt: '', classification })) expect(i.result).toBe('warn');
  });
});
