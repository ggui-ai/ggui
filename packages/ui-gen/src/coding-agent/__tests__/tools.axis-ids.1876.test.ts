// ggui#1876 — the auto-commit line names the axis checks behind its F/W counts, so a WARN the model
// saw at a turn is attributable in the log. The `<n>F/<n>W` prefix stays as it was.
import { describe, expect, it } from 'vitest';
import type { EvalIssue } from '../../evaluation/types-public.js';
import { axisCountsWithIds } from '../tools';

const issue = (result: 'warn' | 'fail', subcategory?: string): EvalIssue => ({
  tier: 0,
  result,
  category: 'mode',
  ...(subcategory !== undefined ? { subcategory } : {}),
  description: 'd',
  fix: 'f',
});

describe('the auto-commit axis field names its checks (ggui#1876)', () => {
  it('no issues: the bare counts, nothing appended', () => {
    expect(axisCountsWithIds([])).toBe('0F/0W');
  });

  it('one WARN names its id', () => {
    expect(axisCountsWithIds([issue('warn', 'universal.tint_category_in_words')])).toBe('0F/1W[W:universal.tint_category_in_words]');
  });

  it('FAILs and WARNs are grouped apart, in the order they came', () => {
    const line = axisCountsWithIds([issue('warn', 'a.w1'), issue('fail', 'b.f1'), issue('warn', 'c.w2')]);
    expect(line).toBe('1F/2W[F:b.f1 W:a.w1,c.w2]');
  });

  it('the counts prefix reads as before', () => {
    const m = /^(\d+)F\/(\d+)W/.exec(axisCountsWithIds([issue('fail', 'x'), issue('warn', 'y')]));
    expect(m?.slice(1)).toEqual(['1', '1']);
  });

  it('an issue without a subcategory is named by its category', () => {
    expect(axisCountsWithIds([issue('warn')])).toBe('0F/1W[W:mode]');
  });
});
