/**
 * Code-property pin (ggui#1106): every `transition:` a primitive or component
 * declares reads its tempo through the `--ggui-motion-*` variables — never a
 * raw time literal (`0.2s`, `150ms`) and never a build-time constant baked
 * into the string — so a host's stated tempo reaches the card. Keyframe
 * `animation:` tempos (spinners, pulses, shimmers) are NOT on the tempo scale
 * and keep the shipped constants by design; this pin does not read them.
 * RED while any transition site still carries a literal, GREEN after.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transition } from './transitions.js';

const SRC = join(import.meta.dirname, '..');
const DIRS = ['primitives', 'components'];

/** A `transition:` value carrying a raw CSS time — the class of site this pin forbids. */
const RAW_TIME_IN_TRANSITION = /transition:\s*(['"`])(?:(?!\1).)*\b\d*\.?\d+m?s\b/;

function transitionSitesWithLiterals(): string[] {
  const hits: string[] = [];
  for (const dir of DIRS) {
    for (const file of readdirSync(join(SRC, dir)).filter((f) => f.endsWith('.tsx'))) {
      const lines = readFileSync(join(SRC, dir, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (RAW_TIME_IN_TRANSITION.test(line)) hits.push(`${dir}/${file}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return hits;
}

describe('motion consumers read the tempo variables — ggui#1106', () => {
  it('the composed transition presets are built from the variables, not the constants', () => {
    for (const [name, value] of Object.entries(transition)) {
      if (name === 'none') continue;
      expect(value, `transition.${name}`).toContain('var(--ggui-motion-duration-');
      expect(value, `transition.${name}`).toContain('var(--ggui-motion-easing-');
      expect(value, `transition.${name} still carries a raw time`).not.toMatch(/\b\d*\.?\d+m?s\b/);
    }
  });

  it('no primitive or component declares a transition with a raw time literal', () => {
    expect(transitionSitesWithLiterals()).toEqual([]);
  });
});
