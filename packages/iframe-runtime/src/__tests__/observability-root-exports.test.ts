// Every arm of the `ObservabilityEvent` union is part of the package's public
// surface: a host narrowing on an event must be able to import its type from
// the package ROOT, not only from the `./observability` subpath. Two arms had
// been left out of the root's type export list, `ComponentEmptyEvent`
// (ggui#1103) and `OneShotUnenforceableEvent` (ggui#1178), while every sibling
// was listed. A hand-kept list drifts one arm at a time, so this pins it
// against the union itself: a new arm that is not exported from the root fails
// here.
//
// Source-level on purpose (a type-only export has no runtime presence). The
// parse is guarded: it must find the arms it knows are there, so an empty or
// mis-anchored read fails instead of passing vacuously.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function unionArms(source: string): string[] {
  const start = source.indexOf('export type ObservabilityEvent =');
  if (start === -1) return [];
  const end = source.indexOf(';', start);
  return source
    .slice(start, end)
    .split('|')
    .slice(1)
    .map((arm) => arm.trim())
    .filter((arm) => arm.length > 0);
}

function rootTypeExportsFromObservability(index: string): Set<string> {
  const names = new Set<string>();
  const block = /export type \{([^}]*)\} from '\.\/observability\.js';/g;
  for (const match of index.matchAll(block)) {
    const list = match[1] ?? '';
    for (const name of list.split(',')) {
      const trimmed = name.trim();
      if (trimmed.length > 0) names.add(trimmed);
    }
  }
  return names;
}

describe('observability — every union arm is exported from the package root', () => {
  const arms = unionArms(readFileSync(join(SRC, 'observability.ts'), 'utf8'));
  const exported = rootTypeExportsFromObservability(readFileSync(join(SRC, 'index.ts'), 'utf8'));

  it('the parse finds the union and the root export list (never vacuous)', () => {
    expect(arms).toContain('ActionSpecInvalidEvent');
    expect(arms).toContain('UnknownObservabilityEvent');
    expect(exported.has('ObservabilityEvent')).toBe(true);
  });

  it('no arm is missing from the root', () => {
    expect(arms.filter((arm) => !exported.has(arm))).toEqual([]);
  });
});
