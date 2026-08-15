// Backdrop cascade guard for ThemeProvider's transparent posture
// (ggui#514).
//
// Served render shells stamp their `html`/`body` backdrop as an
// INLINE style, which a stylesheet `background` rule can never
// out-cascade — the provider's old `background: transparent` rule
// silently lost, leaving system cards opaque in compositing hosts.
// The inline value resolves through `--ggui-shell-background`, so
// the transparent posture must set that custom property: setting it
// re-resolves the inline `var()` in place. These tests pin the
// property emission per posture — the mechanism a jsdom `background`
// assertion cannot see, and the one whose silent removal re-breaks
// exactly the bug class the override point exists for.

import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeProvider } from './ThemeProvider';

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

function injectedRules(): string {
  const styleEl = document.getElementById('ggui-theme-vars');
  expect(styleEl).not.toBeNull();
  return styleEl!.textContent ?? '';
}

describe('ThemeProvider — shell backdrop override point', () => {
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => {
        root.unmount();
      });
    }
    document.body.innerHTML = '';
  });

  it('transparent posture sets --ggui-shell-background on html/body', async () => {
    const { root } = mount();
    roots.push(root);
    await act(async () => {
      root.render(
        <ThemeProvider transparent>
          <span>card</span>
        </ThemeProvider>,
      );
    });
    const rules = injectedRules();
    expect(rules).toContain('--ggui-shell-background: transparent;');
    expect(rules).toContain('background: transparent;');
  });

  it('opaque posture leaves the override point unset (shell keeps its surface paint)', async () => {
    const { root } = mount();
    roots.push(root);
    await act(async () => {
      root.render(
        <ThemeProvider>
          <span>card</span>
        </ThemeProvider>,
      );
    });
    const rules = injectedRules();
    expect(rules).not.toContain('--ggui-shell-background');
    expect(rules).toContain('background: var(--ggui-color-surface, #ffffff);');
  });
});
