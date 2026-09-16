/**
 * Pin (ggui#1093, the harvest half — radius by ROLE): a host's cards and its controls do not
 * share a radius, and the projection can now say so.
 *
 * Measured, not assumed: eight real host pages sampled from computed style by `guuey-team-landing`
 * (guuey#1320, the fixture this row cites). Cards sit at 2–12px while buttons are pills on two of
 * the eight; the numbers below are theirs, verbatim from that fixture — linear.app cards 12px /
 * buttons 9999px, stripe.com 6px / 4px, trimly (a guuey demo shell) 4px / 3px.
 *
 * Before this pin, Button / Input / Select / TextArea read the `md` stop that Card defaults to, so
 * one ladder was asked to be both the card and the pill — a "pill-as-card" host projected one of
 * the two wrong on EVERY page. `shape.radius.control` is the control role's own value;
 * `--ggui-shape-radius-control` is ALWAYS emitted (absent the member it IS the `md` stop), which is
 * what the consumed-token manifest's coverage rule requires and what keeps every document that
 * never heard of the role projecting exactly as before.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveThemeVariables } from './derive-theme-variables';
import type { DtcgTheme } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const stored: DtcgTheme = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'r1', 'stored-dtcg-light.json'), 'utf8')) as DtcgTheme;

const CONTROL = '--ggui-shape-radius-control';
const MD = '--ggui-shape-radius-md';

/** The stored document with the host's card radius on the `md` stop and its control radius on the role. */
function host(card: string, control: string | undefined): DtcgTheme {
  const md = { ...stored.shape.radius.md!, $value: card };
  const radius = control === undefined ? { ...stored.shape.radius, md } : { ...stored.shape.radius, md, control: { ...stored.shape.radius.md!, $value: control } };
  return { ...stored, shape: { ...stored.shape, radius } };
}

/** guuey-team-landing's computed-style harvest (guuey#1320): dominant card radius, button radius. */
const HOSTS = [
  { name: 'linear.app', card: '12px', control: '9999px' },
  { name: 'stripe.com', card: '6px', control: '4px' },
  { name: 'trimly (guuey demo shell)', card: '4px', control: '3px' },
] as const;

describe('radius by role — `shape.radius.control` → `--ggui-shape-radius-control` (ggui#1093 harvest half)', () => {
  it('a document that never heard of the role projects the control radius AS the md stop, and the variable is always present', () => {
    const v = deriveThemeVariables(stored, 'light');
    expect(v[CONTROL]).toBeDefined();
    expect(v[CONTROL]).toBe(v[MD]);
    expect(stored.shape.radius.control).toBeUndefined(); // the fixture states no role — the default arm is what ran
  });

  it.each(HOSTS)('$name: cards $card, controls $control — the two roles project to two different values', ({ card, control }) => {
    const v = deriveThemeVariables(host(card, control), 'light');
    expect(v[MD]).toBe(card);
    expect(v[CONTROL]).toBe(control);
    expect(v[CONTROL]).not.toBe(v[MD]);
  });

  it('the role moves ONLY its own variable: every other radius stop is identical with and without `control`', () => {
    const withRole = deriveThemeVariables(host('12px', '9999px'), 'light');
    const withoutRole = deriveThemeVariables(host('12px', undefined), 'light');
    const stops = Object.keys(withRole).filter((k) => k.startsWith('--ggui-shape-radius-') && k !== CONTROL);
    expect(stops.length).toBeGreaterThan(0);
    for (const k of stops) expect(withRole[k]).toBe(withoutRole[k]);
    expect(withoutRole[CONTROL]).toBe('12px'); // absent the role, a 12px-card host gets 12px controls — the pre-pin behaviour, now stated
  });
});
