// @vitest-environment node
/**
 * ggui#1567 — muted text is a tone, never a neutral step. A component that wants low-emphasis text asks for
 * `resolveToneCss('subtle')` (or `'muted'`), which resolves to the theme's muted ink (`onSunken`), measured to
 * clear AA on both grounds. Before this, ten components wrote `--ggui-color-neutral-500` straight into `color`, so
 * a dark theme shipped two greys for one role (one at 6.57:1, the other at 4.36:1 on sunken).
 *
 * The remaining `neutral-400` uses are not body text: disabled items, icons and separators. Each is allowlisted
 * below by file and count, with its reason, so a new text use of a neutral step fails here and an allowlisted one
 * that grows is a visible diff.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const SCANNED = ['primitives', 'components', 'compositions'];
/** Files that define the variables rather than paint with them. */
const DEFINERS = new Set(['primitives/color-slots.ts']);

/** Non-text uses of a neutral step: `file` → { count, why }. */
const NON_TEXT: Readonly<Record<string, { count: number; why: string }>> = {
  'components/Autocomplete.tsx': { count: 1, why: 'a disabled option' },
  'components/Breadcrumb.tsx': { count: 1, why: 'the separator glyph' },
  'components/MenuItem.tsx': { count: 2, why: 'a disabled item; the trailing icon' },
  'components/Pagination.tsx': { count: 1, why: 'the ellipsis between page numbers' },
  'components/SearchField.tsx': { count: 1, why: 'the search icon' },
  'compositions/CommandPalette.tsx': { count: 1, why: 'a disabled command' },
  'compositions/NotificationCenter.tsx': { count: 1, why: 'the dismiss icon' },
  'compositions/Sidebar.tsx': { count: 1, why: 'a disabled item' },
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name) ? [full] : [];
  });
}

const counts = new Map<string, number>();
for (const dir of SCANNED) {
  for (const file of sources(join(SRC, dir))) {
    const rel = relative(SRC, file).split('\\').join('/');
    if (DEFINERS.has(rel)) continue;
    const n = (readFileSync(file, 'utf8').match(/--ggui-color-neutral-(?:400|500)\b/g) ?? []).length;
    if (n > 0) counts.set(rel, n);
  }
}

describe('no component paints text with a neutral step (ggui#1567)', () => {
  it('scans the component tree (a control: the tone itself is found where it is defined)', () => {
    expect(readFileSync(join(SRC, 'primitives/color-slots.ts'), 'utf8')).toContain("case 'subtle':");
    expect(sources(join(SRC, 'compositions')).length).toBeGreaterThan(10);
  });

  it('every neutral-400/500 reference is an allowlisted non-text use, at its allowlisted count', () => {
    expect(Object.fromEntries(counts)).toEqual(Object.fromEntries(Object.entries(NON_TEXT).map(([f, { count }]) => [f, count])));
  });

  it('no file writes neutral-500 at all: the subtle tone replaced every use', () => {
    const fiveHundred = [...counts.keys()].filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('--ggui-color-neutral-500'));
    expect(fiveHundred).toEqual([]);
  });
});
