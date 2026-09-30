/**
 * ggui#1611 — the variants page's intro says what the operator-default mark
 * does: it orders the list and shows ★, and it does not decide what serves.
 * A code-property pin on the component's source (the page fetches its data,
 * so the intro is read where it is written).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'BlueprintVariants.tsx'), 'utf8');
const prose = source.replace(/\s+/g, ' ');

describe('the blueprint variants intro (ggui#1611)', () => {
  it('says the mark lists first and does not decide what serves', () => {
    expect(prose).toContain('lists it first and shows ★ on it');
    expect(prose).toContain('not by the mark');
  });

  it('no longer claims the matcher picks by the mark or that pinning fixes a floor', () => {
    expect(prose).not.toContain('The matcher picks among siblings');
    expect(prose).not.toContain('to fix the floor');
  });
});
