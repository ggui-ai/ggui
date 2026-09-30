/**
 * A component worker writes its verdict on one prefixed line, and the host
 * reads the LAST such line, so anything else on stdout (a card that
 * console.logs while it is rendered) cannot corrupt the verdict.
 */
import { describe, expect, it } from 'vitest';
import { formatVerdictLine, parseVerdictLine } from './verdict-line.js';

describe('the render-check verdict line', () => {
  const verdict = { ok: true, issues: [], stats: { actionsChecked: 1, streamsChecked: 0, renderMs: 5 } };

  it('round-trips, and survives other output before and after it', () => {
    expect(parseVerdictLine(formatVerdictLine(verdict))).toEqual(verdict);
    const noisy = `hello from a card\n{"not":"the verdict"}\n${formatVerdictLine(verdict)}late log line\n`;
    expect(parseVerdictLine(noisy)).toEqual(verdict);
  });

  it('reads the last verdict line when there are several', () => {
    const second = { ...verdict, ok: false };
    expect(parseVerdictLine(`${formatVerdictLine(verdict)}${formatVerdictLine(second)}`)).toEqual(second);
  });

  it('is undefined when no line carries the prefix (bare JSON included)', () => {
    expect(parseVerdictLine('')).toBeUndefined();
    expect(parseVerdictLine(`${JSON.stringify(verdict)}\n`)).toBeUndefined();
  });

  it('throws on a prefixed line that is not JSON, so the host reports it', () => {
    expect(() => parseVerdictLine(`${formatVerdictLine(verdict).split(' ')[0]} {broken\n`)).toThrow();
  });
});
