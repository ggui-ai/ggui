/**
 * Per-app theme v2 injection (ggui#987 §3.3 / ggui#989).
 *
 * The renderer is handed protocol's `AppTheme` — BOTH modes' derived
 * projections — and the mount's EFFECTIVE mode (`themeMode`, host-owned
 * per §4). One document-order cascade, pinned here:
 *
 *   compiled ladder < hostPalette < overlays[mode] < cssVariables <
 *   cssOverrides, then keyframes[mode], then the frameless rule.
 *
 * `color-scheme` at `:root` follows the SAME effective mode as the
 * ladder and the overlay, so the three can never disagree; a mode flip
 * re-paints from the retained other overlay with zero network activity.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { framelessSuppressionRule } from '@ggui-ai/design/rendering';
import { mountReactRoot } from '../react-renderer.js';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** Flush React 19's concurrent commit phase so DOM assertions see the tree. */
async function flush(fn: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

/** The scoped in-tree `<style>` text + scope class of a mounted root. */
function scopedStyleOf(container: HTMLElement): {
  readonly scopeClass: string;
  readonly css: string;
} {
  const scopeDiv = container.firstElementChild as HTMLElement;
  return {
    scopeClass: scopeDiv.className,
    css: scopeDiv.querySelector('style')?.textContent ?? '',
  };
}

const rootCss = (): string => document.getElementById('ggui-theme-vars')?.textContent ?? '';

/** Distinct per-mode values so mode selection is observable. */
const THEME = {
  overlayHash: 'ab'.repeat(32),
  overlays: {
    light: { '--ggui-color-ground': '#fefefe', '--ggui-color-primary-600': '#111111' },
    dark: { '--ggui-color-ground': '#0a0a0f', '--ggui-color-primary-600': '#eeeeee' },
  },
  cssVariables: { '--ggui-shape-radius-md': '13px' },
  keyframes: {
    light: '@keyframes ggui-t-light{from{opacity:0}to{opacity:1}}',
    dark: '@keyframes ggui-t-dark{from{opacity:1}to{opacity:0}}',
  },
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById('ggui-theme-vars')?.remove();
});

describe('mountReactRoot — per-app theme v2 (ggui#987 §3.3)', () => {
  it('injects overlays[mode] for the EFFECTIVE mode, in the scoped block and at :root with a matching color-scheme', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'dark',
        appTheme: THEME,
      });
    });
    const { scopeClass, css } = scopedStyleOf(container);
    expect(css).toContain(`.${scopeClass}{--ggui-color-ground: #0a0a0f;--ggui-color-primary-600: #eeeeee;}`);
    expect(css).not.toContain('#fefefe');
    expect(rootCss()).toContain('color-scheme:dark;');
    expect(rootCss()).toContain('--ggui-color-ground: #0a0a0f;');
    expect(rootCss()).not.toContain('#fefefe');
    mount!.unmount();
  });

  it('absent themeMode paints light everywhere: light ladder, overlays.light, color-scheme:light', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        appTheme: THEME,
      });
    });
    const { css } = scopedStyleOf(container);
    expect(css).toContain('--ggui-color-ground: #fefefe;');
    expect(css).not.toContain('#0a0a0f');
    expect(rootCss()).toContain('color-scheme:light;');
    mount!.unmount();
  });

  it('one cascade: compiled < hostPalette < overlays[mode] < cssVariables < cssOverrides < keyframes[mode] < frameless rule', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'light',
        hostPalette: { '--ggui-color-ground': '#101014' },
        appTheme: { ...THEME, frameless: true },
        cssOverrides: '.override{color:red}',
      });
    });
    const { scopeClass, css } = scopedStyleOf(container);
    const at = (needle: string): number => {
      const i = css.indexOf(needle);
      expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    const compiled = at(`.${scopeClass} {`);
    const host = at(`.${scopeClass}{--ggui-color-ground: #101014;}`);
    const overlay = at(`.${scopeClass}{--ggui-color-ground: #fefefe;`);
    const vars = at(`.${scopeClass}{--ggui-shape-radius-md: 13px;}`);
    const overrides = at('.override{color:red}');
    const keyframes = at('@keyframes ggui-t-light');
    const frameless = at(framelessSuppressionRule(scopeClass));
    expect([compiled, host, overlay, vars, overrides, keyframes, frameless]).toEqual(
      [compiled, host, overlay, vars, overrides, keyframes, frameless].slice().sort((a, b) => a - b),
    );
    expect(css.endsWith(framelessSuppressionRule(scopeClass))).toBe(true);
    expect(css).not.toContain('@keyframes ggui-t-dark');
    mount!.unmount();
  });

  it('a mode flip re-paints from the retained other overlay with zero fetches', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'light',
        appTheme: THEME,
      });
    });
    expect(scopedStyleOf(container).css).toContain('#fefefe');
    await flush(async () => {
      await mount!.update({
        render: { id: 'x', componentCode: '' },
        themeMode: 'dark',
        appTheme: THEME,
      });
    });
    const { css } = scopedStyleOf(container);
    expect(css).toContain('#0a0a0f');
    expect(css).not.toContain('#fefefe');
    expect(css).toContain('@keyframes ggui-t-dark');
    expect(rootCss()).toContain('color-scheme:dark;');
    expect(fetchSpy).not.toHaveBeenCalled();
    mount!.unmount();
  });

  it('no appTheme → compiled ladder only; no keyframes, no frameless rule; color-scheme still stamped', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'dark',
      });
    });
    const { scopeClass, css } = scopedStyleOf(container);
    expect(css).toContain(`.${scopeClass} {`);
    expect(css).not.toContain('@keyframes ggui-t-');
    expect(css).not.toContain(framelessSuppressionRule(scopeClass));
    expect(rootCss()).toContain('color-scheme:dark;');
    mount!.unmount();
  });
});
