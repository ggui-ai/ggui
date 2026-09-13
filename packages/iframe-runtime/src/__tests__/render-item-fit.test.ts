// Pin (ggui#1073): `fit` reaches the tree compose THROUGH `mountRender` — the
// mount AND the update mapping. The renderer already honoured `fit: 'fill'`
// (react-renderer-theme-v2.test.ts) and `buildOpts` already read the host's
// `displayMode` (host-theme-mode.test.ts); the option was dropped between the
// two, so every served hello composed without the #1041 fill.
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import type { GguiSession } from '@ggui-ai/protocol';
import { fillFitRule } from '@ggui-ai/design/rendering';
import { mountRender } from '../render-item.js';
import { StreamBus } from '../wire-config.js';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}
async function flush(fn: () => Promise<void>): Promise<void> {
  await act(async () => {
    await fn();
  });
}
function makeComponentRender(): GguiSession {
  return {
    id: 'render_fit_1',
    appId: 'app_001',
    componentCode: 'export default () => null',
    props: {},
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}
/** The scoped in-tree `<style>` of a mounted component root. */
function scopedCss(container: HTMLElement): { scopeClass: string; css: string } {
  const scopeDiv = container.firstElementChild as HTMLElement;
  return { scopeClass: scopeDiv.className, css: scopeDiv.querySelector('style')?.textContent ?? '' };
}
const base = () => ({ render: makeComponentRender(), scopedWireConfig: null, streamBus: new StreamBus(), sessionId: 'render_fit_1', themeMode: 'light' as const });

describe('mountRender — fit reaches the tree compose (ggui#1073)', () => {
  it("mount: fit: 'fill' composes the fill rule; absent fit does not", async () => {
    const filled = makeContainer();
    let handle!: Awaited<ReturnType<typeof mountRender>>;
    await flush(async () => {
      handle = await mountRender(filled, { ...base(), fit: 'fill' });
    });
    const f = scopedCss(filled);
    expect(f.css).toContain(fillFitRule(f.scopeClass));
    handle.unmount();

    const inline = makeContainer();
    await flush(async () => {
      handle = await mountRender(inline, base());
    });
    const i = scopedCss(inline);
    expect(i.css).not.toContain('min-height: 100%');
    handle.unmount();
  });

  it('update: a later fit: "fill" (the host flipped to fullscreen) recomposes with the fill rule', async () => {
    const container = makeContainer();
    let handle!: Awaited<ReturnType<typeof mountRender>>;
    await flush(async () => {
      handle = await mountRender(container, base());
    });
    expect(scopedCss(container).css).not.toContain('min-height: 100%');
    await flush(async () => {
      await handle.update({ ...base(), fit: 'fill' });
    });
    const after = scopedCss(container);
    expect(after.css).toContain(fillFitRule(after.scopeClass));
    handle.unmount();
  });
});
