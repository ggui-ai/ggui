/**
 * A chat-width card shown on a fullscreen surface keeps its natural height in its own frame: the
 * renderer reads the bundle's canvas export beside its default export and composes the mount fit
 * through `resolveMountFit`. Every other bundle composes exactly as before — a canvas fills under
 * fullscreen, an inline mount composes nothing, and a bundle compiled before the export existed (or
 * carrying a value that is not a canvas class) fails closed to fill.
 */
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import type { GguiSession } from '@ggui-ai/protocol';
import { cardFitRule, fillFitRule, GGUI_MOUNT_CANVAS_EXPORT } from '@ggui-ai/design/rendering';
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
function render(componentCode: string): GguiSession {
  return {
    id: 'render_mount_canvas_1',
    appId: 'app_001',
    componentCode,
    props: {},
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}
const withCanvas = (canvas: string): string =>
  `export const ${GGUI_MOUNT_CANVAS_EXPORT} = ${JSON.stringify(canvas)};\nexport default () => null;`;
const NO_EXPORT = 'export default () => null';

async function scopedCssFor(code: string, displayMode: 'fullscreen' | 'inline' | undefined): Promise<{ scopeClass: string; css: string }> {
  const container = makeContainer();
  let handle!: Awaited<ReturnType<typeof mountRender>>;
  await flush(async () => {
    handle = await mountRender(container, {
      render: render(code),
      scopedWireConfig: null,
      streamBus: new StreamBus(),
      sessionId: 'render_mount_canvas_1',
      themeMode: 'light',
      ...(displayMode !== undefined ? { displayMode } : {}),
    });
  });
  const scopeDiv = container.firstElementChild as HTMLElement;
  const out = { scopeClass: scopeDiv.className, css: scopeDiv.querySelector('style')?.textContent ?? '' };
  handle.unmount();
  return out;
}

describe('the bundle canvas export decides the mount fit under fullscreen (resolveMountFit)', () => {
  it('a chat-width card under fullscreen composes its own frame at natural height, never the fill rule', async () => {
    const { scopeClass, css } = await scopedCssFor(withCanvas('xs-chat-card'), 'fullscreen');
    expect(css).toContain(`.${scopeClass} { margin: 16px;`);
    expect(css).toContain(cardFitRule(scopeClass, null).split('\n').pop());
    expect(css).not.toContain(fillFitRule(scopeClass));
  });

  it('the same chat-width card inline composes neither rule: the host draws its frame', async () => {
    const { scopeClass, css } = await scopedCssFor(withCanvas('xs-chat-card'), undefined);
    expect(css).not.toContain(fillFitRule(scopeClass));
    expect(css).not.toContain(`.${scopeClass} { margin: 16px;`);
  });

  it('a canvas card under fullscreen still fills', async () => {
    const { scopeClass, css } = await scopedCssFor(withCanvas('md'), 'fullscreen');
    expect(css).toContain(fillFitRule(scopeClass));
  });

  it('N−1: a bundle compiled before the export existed fills under fullscreen, as before', async () => {
    const { scopeClass, css } = await scopedCssFor(NO_EXPORT, 'fullscreen');
    expect(css).toContain(fillFitRule(scopeClass));
    expect(css).not.toContain(`.${scopeClass} { margin: 16px;`);
  });

  it('fail-closed: an export that is not a canvas class fills under fullscreen', async () => {
    const { scopeClass, css } = await scopedCssFor(withCanvas('chat-card-ish'), 'fullscreen');
    expect(css).toContain(fillFitRule(scopeClass));
    expect(css).not.toContain(`.${scopeClass} { margin: 16px;`);
  });
});
