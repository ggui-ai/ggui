/**
 * Pin (ggui#1326): a card never overrides its viewer's reduced-motion
 * request. `motion.reduce: 'ignore'` stays a valid document value (stored
 * documents and theme writes from the previous release still carry it) and
 * is treated as `'respect'`:
 *
 *   - it changes no derived variable, in either mode;
 *   - the reduced-motion rule is injected whatever the theme says (the
 *     injector takes no theme at all);
 *   - no source in this package reads the member, so no composer can start
 *     honouring `'ignore'` without this test failing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MotionKeyframes } from '../primitives/motion';
import { reducedMotionCSS } from '../tokens/motion';
import { lightTheme } from './defaults/light.js';
import { deriveThemeVariables } from './derive-theme-variables.js';
import type { DtcgTheme } from './types.js';

function withReduce(reduce: 'respect' | 'ignore' | undefined): DtcgTheme {
  const motion = { ...lightTheme.motion };
  delete motion.reduce;
  return { ...lightTheme, motion: reduce === undefined ? motion : { ...motion, reduce } };
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.head.querySelectorAll('style').forEach((el) => el.remove());
});

describe("motion.reduce: 'ignore' is treated as 'respect' (ggui#1326)", () => {
  it("an 'ignore' document derives exactly what a 'respect' one and an unstated one do, in both modes", () => {
    for (const mode of ['light', 'dark'] as const) {
      const respect = deriveThemeVariables(withReduce('respect'), mode);
      expect(deriveThemeVariables(withReduce('ignore'), mode)).toEqual(respect);
      expect(deriveThemeVariables(withReduce(undefined), mode)).toEqual(respect);
    }
  });

  it('the reduced-motion rule is injected, and the injector takes no theme', async () => {
    expect(MotionKeyframes.length).toBe(0);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<MotionKeyframes />));
    const injected = [...document.head.querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n');
    expect(reducedMotionCSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(injected).toContain(reducedMotionCSS);
  });

  it('no source in this package reads motion.reduce', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(src);
    // Control: the walk reaches the file that declares the member.
    expect(files.some((f) => f.endsWith(path.join('themes', 'types.ts')))).toBe(true);
    const readers = files.filter((f) => /motion\??\.reduce\b|motion\??\.\[['"]reduce['"]\]/.test(readFileSync(f, 'utf8')));
    expect(readers.map((f) => path.relative(src, f))).toEqual([]);
  });
});
