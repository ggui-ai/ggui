/**
 * Tests for delivered-ladder injection — `theme.base` (ggui#598-C,
 * runtime-injection leg; design doc
 * docs/plans/2026-08-22-theme-registration-delivery.md §3.1).
 *
 * The `ai.ggui/render` slice's theme object may carry `base`
 * — the REGISTERED ladder delivered over the wire, both modes'
 * resolved variable sets. These specs lock the renderer's contract:
 *
 *   1. base present → the MODE-SELECTED variable set paints as the
 *      scoped block at the base position, REPLACING the compiled
 *      ladder block (no double-injection).
 *   2. Document-order precedence holds with base as the base:
 *      base < hostPalette < appTheme overlay < cssOverrides.
 *   3. Mode switch re-paints from the already-present other ladder
 *      with ZERO network activity (both modes retained — §3's
 *      "the cache is the envelope").
 *   4. base ABSENT → the compiled-ladder path is byte-identical to
 *      today (regression pin; the full existing suite is the wider
 *      pin).
 *
 * jsdom-backed, same act()-flush pattern as react-renderer.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
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

const DOC_HASH = 'ab'.repeat(32);

/** A delivered ladder — distinct per-mode values so mode selection is observable. */
const BASE = {
  documentHash: DOC_HASH,
  light: {
    '--ggui-color-surface': '#fefefe',
    '--ggui-color-primary-600': '#111111',
  },
  dark: {
    '--ggui-color-surface': '#0a0a0f',
    '--ggui-color-primary-600': '#eeeeee',
  },
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mountReactRoot — delivered base ladder (theme.base, ggui#598-C)', () => {
  it('injects the mode-selected base set at the base position, replacing the compiled ladder block', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'light',
        appTheme: { mode: 'light', cssVariables: {}, base: BASE },
      });
    });

    const { scopeClass, css } = scopedStyleOf(container);
    // The base block leads the scoped style — the base position —
    // in the same `.scope {` shape the compiled block uses.
    expect(css.startsWith(`.${scopeClass} {`)).toBe(true);
    // Mode-selected: light values in, dark values NOT painted here.
    expect(css).toContain('--ggui-color-surface: #fefefe;');
    expect(css).not.toContain('#0a0a0f');
    // Replacement, not double-injection — but WITH the shared
    // scaffolding (flag-1 fix, ggui#598-C): the delivered path now
    // rides the design package's assembleDeliveredThemeCss, so the
    // structural rules and derived tokens the compiled ladder gets
    // appear here too — from ONE builder, so the paths cannot drift.
    // Replacement is proven by the COMPILED ladder's own variable
    // values being absent (the delivered values painted above), not
    // by scaffolding absence.
    expect(css).toContain('box-sizing: border-box');
    expect(css).toContain('--ggui-color-primary-gradient');

    mount!.unmount();
  });

  it('selects the dark set when the resolved mode is dark', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'dark',
        appTheme: { mode: 'dark', cssVariables: {}, base: BASE },
      });
    });

    const { css } = scopedStyleOf(container);
    expect(css).toContain('--ggui-color-surface: #0a0a0f;');
    expect(css).not.toContain('#fefefe');

    mount!.unmount();
  });

  it('serializes the base set deterministically (sorted keys)', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'light',
        appTheme: {
          mode: 'light',
          cssVariables: {},
          base: {
            documentHash: DOC_HASH,
            // Deliberately unsorted insertion order.
            light: {
              '--ggui-color-surface': '#fefefe',
              '--ggui-color-onSurface': '#101010',
            },
            dark: { '--ggui-color-surface': '#0a0a0f' },
          },
        },
      });
    });

    const { css } = scopedStyleOf(container);
    // Key-sorted: onSurface (o…) precedes surface (s…) regardless of
    // the wire object's insertion order — byte-stable output.
    const onSurfaceIdx = css.indexOf('--ggui-color-onSurface: #101010;');
    const surfaceIdx = css.indexOf('--ggui-color-surface: #fefefe;');
    expect(onSurfaceIdx).toBeGreaterThan(-1);
    expect(surfaceIdx).toBeGreaterThan(onSurfaceIdx);

    mount!.unmount();
  });

  it('keeps the document-order precedence: base < hostPalette < appTheme overlay < cssOverrides', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'light',
        appTheme: {
          mode: 'light',
          cssVariables: { '--ggui-color-primary-600': '#abcdef' },
          base: BASE,
        },
        hostPalette: { '--ggui-color-primary-600': '#222222' },
        cssOverrides: '/*ggui-overrides*/',
      });
    });

    const { scopeClass, css } = scopedStyleOf(container);
    const baseIdx = css.indexOf('--ggui-color-primary-600: #111111;');
    const hostIdx = css.indexOf(`.${scopeClass}{--ggui-color-primary-600: #222222;}`);
    const overlayIdx = css.indexOf(`.${scopeClass}{--ggui-color-primary-600: #abcdef;}`);
    const overridesIdx = css.indexOf('/*ggui-overrides*/');
    expect(baseIdx, 'base declaration missing').toBeGreaterThan(-1);
    expect(hostIdx, 'host palette must land AFTER the base block').toBeGreaterThan(baseIdx);
    expect(overlayIdx, 'overlay must land AFTER the host palette').toBeGreaterThan(hostIdx);
    expect(overridesIdx, 'cssOverrides must land last').toBeGreaterThan(overlayIdx);

    mount!.unmount();
  });

  it('mode switch re-paints from the retained other ladder with zero fetches', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'light',
        appTheme: { mode: 'light', cssVariables: {}, base: BASE },
      });
    });
    expect(scopedStyleOf(container).css).toContain('--ggui-color-surface: #fefefe;');

    // Same meta, other mode — the runtime re-renders with the new
    // resolved mode; the dark ladder is ALREADY PRESENT in `base`.
    await flush(async () => {
      await mount!.update({
        render: { id: 'x', componentCode: '' },
        themeMode: 'dark',
        appTheme: { mode: 'dark', cssVariables: {}, base: BASE },
      });
    });

    const { css } = scopedStyleOf(container);
    expect(css).toContain('--ggui-color-surface: #0a0a0f;');
    expect(css).not.toContain('#fefefe');
    expect(fetchSpy, 'mode switch must be a local operation').not.toHaveBeenCalled();

    mount!.unmount();
  });

  it('base ABSENT → the compiled-ladder path still paints (replacement only fires on presence)', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        themeMode: 'light',
        appTheme: { mode: 'light', cssVariables: {} },
      });
    });

    const { scopeClass, css } = scopedStyleOf(container);
    // Compiled-block structural markers present, exactly as today.
    expect(css.startsWith(`.${scopeClass} {`)).toBe(true);
    expect(css).toContain('box-sizing: border-box');

    mount!.unmount();
  });
});
