/**
 * ggui#1147 — the renderer composes the stored theme's faces into the chrome
 * CSS (`#ggui-theme-vars`). `font-src` is fixed at mount, so a face on a NEW
 * origin can be blocked. The renderer hands that CSS to the font reporter, so
 * the block is posted as `font-face-blocked` even when the host announced no
 * fonts. End to end through `mountReactRoot`; only the post is observed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react';

const posted: unknown[] = [];
vi.mock('../observability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../observability.js')>();
  return { ...actual, postObservabilityToParent: (e: unknown) => posted.push(e) };
});
import { mountReactRoot } from '../react-renderer.js';
import { __resetHostFontsForTest } from '../host-fonts.js';

beforeEach(() => {
  __resetHostFontsForTest();
  posted.length = 0;
});
afterEach(() => {
  document.getElementById('ggui-theme-vars')?.remove();
});

describe('mountReactRoot — a blocked stored-theme font face is reported (ggui#1147)', () => {
  it('a font-src violation for a theme face posts font-face-blocked, with no host fonts installed', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await act(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        appTheme: {
          overlayHash: 'ab'.repeat(32),
          overlays: { light: {}, dark: {} },
          fonts: [{ family: 'Brand Serif', src: 'https://fonts.newcdn.example/brand.woff2' }],
        },
      });
    });
    const ev = new Event('securitypolicyviolation');
    Object.assign(ev, { effectiveDirective: 'font-src', blockedURI: 'https://fonts.newcdn.example' });
    document.dispatchEvent(ev);
    expect(posted).toContainEqual({ kind: 'font-face-blocked', family: 'Brand Serif', host: 'fonts.newcdn.example' });
    mount!.unmount();
  });
});
