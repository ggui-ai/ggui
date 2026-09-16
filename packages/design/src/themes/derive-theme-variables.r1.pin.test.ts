/**
 * Pin (ggui#1158 / #1093 R1): the host's `typeScale` + `rhythm` REACH the card,
 * and a member the projector cannot read is NAMED, never silently skipped.
 *
 * Three delivered documents (see `__fixtures__/r1/README.md`): a stored negative
 * control with neither member; the same generator with both members AND the
 * pre-R1 `font.ramp` path live; and an ISOLATED variant with both members and
 * no ramp — so every variable that moves against the control is R1's signal
 * alone. Under 0.17.0 (which predates the projection) the isolated document
 * derived 0 variables differing from the control; that is the "before".
 *
 * The trace half is the read-door lesson (ggui#1115) one layer down: the door
 * NAMES a member it cannot read instead of dropping the row; the projector must
 * NAME a member it cannot read instead of skipping it. A bare `"16px"` where a
 * DTCG token is required produced exactly the output of an absent member — 118
 * identical variables and the same hash — which is how a real host measured
 * "nothing reaches the card" and could not tell WHY.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { deriveThemeVariables, type ThemeDiagnostic } from './derive-theme-variables';
import type { DtcgTheme } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name: string): DtcgTheme =>
  JSON.parse(readFileSync(join(HERE, '__fixtures__', 'r1', `${name}.json`), 'utf8')) as DtcgTheme;

const stored = load('stored-dtcg-light');
const full = load('r1-dtcg-light');
const isolated = load('r1-isolated-dtcg-light');

const diff = (a: Record<string, string>, b: Record<string, string>): string[] =>
  Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).sort();

describe('R1 — the host design language reaches the card (delivered fixtures)', () => {
  it('the ISOLATED document moves the spacing unit (rhythm.base) and the heading role (typeScale.h1) against the stored control — the R1 signal alone', () => {
    const control = deriveThemeVariables(stored, 'light');
    const r1 = deriveThemeVariables(isolated, 'light');
    const moved = diff(control, r1);
    expect(moved.length).toBeGreaterThan(0);
    // rhythm.base 8px re-derives the layer-1 spacing steps.
    expect(moved.some((k) => k.startsWith('--ggui-spacing-'))).toBe(true);
    // typeScale.h1.weight '700' lands on the heading weight token. It does NOT appear in
    // `moved`, and asserting it would be wrong: the fallback heading weight is already bold
    // (700), so a stated 700 is byte-identical to the default. The first draft of this pin
    // asserted the move and failed — a right answer asked the wrong question. The size
    // ladder is the discriminating half: body.size (1rem, stated) re-derives every stop.
    expect(r1['--ggui-font-weight-heading']).toBe('700');
    expect(moved.some((k) => k.startsWith('--ggui-font-size-'))).toBe(true);
    // Nothing outside the R1 vocabulary moved: only font / spacing / letter-spacing / lineHeight families.
    const outside = moved.filter((k) => !/^--ggui-(font|spacing|letter-spacing)-/.test(k));
    expect(outside).toEqual([]);
  });

  it('the FULL document (ramp live) and the ISOLATED one agree on every spacing variable — the ramp moves type, never rhythm', () => {
    const a = deriveThemeVariables(full, 'light');
    const b = deriveThemeVariables(isolated, 'light');
    const spacingMoved = diff(a, b).filter((k) => k.startsWith('--ggui-spacing-'));
    expect(spacingMoved).toEqual([]);
    // And the ramp does move the size ladder between them (body.size 1.1rem vs 1rem).
    expect(a['--ggui-font-size-base']).not.toBe(b['--ggui-font-size-base']);
  });

  it('a stated role wins its stop; an unstated role falls back rather than blanking (h1.leading and body.weight are absent in both R1 fixtures)', () => {
    const r1 = deriveThemeVariables(isolated, 'light');
    for (const k of Object.keys(r1)) expect(r1[k], k).not.toBe('');
    expect(r1['--ggui-font-weight-normal']).toBeDefined();
  });
});

describe('R1 — a member the projector cannot read is NAMED, never silently skipped (ggui#1158)', () => {
  /** A document "from JSON" that never met the TypeScript type: bare strings where DTCG tokens are required. */
  const bare = JSON.parse(
    JSON.stringify({
      ...stored,
      typeScale: { body: { size: '16px' } },
      rhythm: { base: '8px' },
    }),
  ) as DtcgTheme;

  it('the output is byte-identical to the control (the member is not read) AND every unreadable member is named on the diagnostic channel', () => {
    const onDiagnostic = vi.fn<(d: ThemeDiagnostic) => void>();
    const out = deriveThemeVariables(bare, 'light', { onDiagnostic });
    expect(out).toEqual(deriveThemeVariables(stored, 'light'));
    const paths = onDiagnostic.mock.calls.map(([d]) => d.path).sort();
    expect(paths).toEqual(['rhythm.base', 'typeScale.body.size']);
    for (const [d] of onDiagnostic.mock.calls) {
      expect(d.kind).toBe('member-unreadable');
      expect(d.found).toMatch(/string/);
    }
  });

  it('an ABSENT member is silence, not a diagnostic — only presence-without-shape is named', () => {
    const onDiagnostic = vi.fn<(d: ThemeDiagnostic) => void>();
    deriveThemeVariables(stored, 'light', { onDiagnostic });
    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('with no channel supplied the default is LOUD, not silent — a console warning that names the member', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      deriveThemeVariables(bare, 'light');
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('[ggui-design]') && l.includes('typeScale.body.size'))).toBe(true);
      expect(lines.some((l) => l.includes('rhythm.base'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('never throws: a malformed theme must not take a card down', () => {
    expect(() => deriveThemeVariables(bare, 'light')).not.toThrow();
  });
});
