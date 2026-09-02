/**
 * assembleDeliveredThemeCss (ggui#598-C injection-flag-1 fix) — the
 * delivered ladder gets the SAME scaffolding the compiled ladder
 * gets: base inherits, derived gradient/effect tokens (with the
 * color-mix fallback split), box-sizing, and font-inherit rules. The
 * injection agent's finding: replacing the compiled block with bare
 * variables silently dropped all of it.
 */
import { describe, expect, it } from 'vitest';
import { assembleDeliveredThemeCss, getScopedThemeCss } from './css-tokens.js';

const SCOPE = 'gg-598c';
const VARS = {
  '--ggui-color-primary-500': '#B8FF3A',
  '--ggui-color-primary-600': '#CCFF66',
  '--ggui-color-surface': '#101216',
  '--ggui-color-onSurface': '#f0f0f2',
  '--ggui-font-family-sans': 'DM Sans, sans-serif',
};

describe('assembleDeliveredThemeCss', () => {
  it('emits the delivered variables scoped and key-sorted', () => {
    const css = assembleDeliveredThemeCss(SCOPE, VARS);
    expect(css).toContain(`.${SCOPE} {`);
    const surfaceIdx = css.indexOf('--ggui-color-surface:');
    const primaryIdx = css.indexOf('--ggui-color-primary-500:');
    expect(primaryIdx).toBeGreaterThan(-1);
    expect(surfaceIdx).toBeGreaterThan(primaryIdx); // sorted
  });

  it('carries the compiled path\'s scaffolding: base inherits, box-sizing, font-inherit', () => {
    const css = assembleDeliveredThemeCss(SCOPE, VARS);
    expect(css).toContain('font-family: var(--ggui-font-family-sans);');
    expect(css).toContain('color: var(--ggui-color-onSurface);');
    expect(css).toContain('background-color: transparent;');
    expect(css).toContain(`box-sizing: border-box`);
    expect(css).toContain('font-family: inherit;');
  });

  it('derives the gradient/effect tokens from the delivered map with the color-mix fallback split', () => {
    const css = assembleDeliveredThemeCss(SCOPE, VARS);
    expect(css).toContain('--ggui-color-primary-gradient:');
    expect(css).toContain('--ggui-color-surface-gradient:');
    expect(css).toContain('--ggui-effect-glow-primary:');
    // primary-500 resolvable → the static rgba fallback + the modern tier.
    expect(css).toContain('@supports (color: color-mix(in srgb, red, blue))');
  });

  it('scaffolding parity: every scaffolding rule in the compiled ggui block appears for the delivered map too', () => {
    const compiled = getScopedThemeCss('ggui', SCOPE, 'light');
    const delivered = assembleDeliveredThemeCss(SCOPE, VARS);
    for (const marker of [
      'background-color: transparent;',
      'box-sizing: border-box',
      'font-family: inherit;',
      '--ggui-color-primary-gradient:',
    ]) {
      expect(compiled).toContain(marker);
      expect(delivered).toContain(marker);
    }
  });
});

describe('delivered ladder carries keyframes + frameless (ggui#613 residual 2 — the two documented v1 deltas close)', () => {
  it('opts.keyframes appends the block; opts.frameless appends the SAME suppression rule the compiled path emits', async () => {
    const { assembleDeliveredThemeCss } = await import('./css-tokens.js');
    const css = assembleDeliveredThemeCss(
      'ggui-scope-x',
      { '--ggui-color-primary-500': '#3b82f6' },
      {
        keyframes: '@keyframes pulse {\n  0% { opacity: 1; }\n  to { opacity: 0.4; }\n}',
        frameless: true,
      },
    );
    expect(css).toContain('@keyframes pulse');
    // Byte-identical to the compiled path's rule — one doctrine, two transports.
    expect(css).toContain(
      '.ggui-scope-x > :where(:not(style)) { border: none !important; }',
    );
  });

  it('without opts the output is unchanged — absent keyframes/frameless add nothing', async () => {
    const { assembleDeliveredThemeCss } = await import('./css-tokens.js');
    const css = assembleDeliveredThemeCss('ggui-scope-x', {
      '--ggui-color-primary-500': '#3b82f6',
    });
    expect(css).not.toContain('@keyframes');
    expect(css).not.toContain('border: none !important');
  });
});
