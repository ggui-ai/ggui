/**
 * Pin (ggui#1103, the visible half): a mount reports whether it PAINTS —
 * a fact distinct from "a render was applied", which succeeds with no
 * component at all (`wrapped === null`: the scope element carries only its
 * `<style>`). The boot reads this to decide whether the served shell's
 * standby has become a lie; retiring it on "applied" is what made a waiting
 * card and a failed card look identical.
 */
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { mountReactRoot } from '../react-renderer.js';
import { mountRender } from '../render-item.js';
import { StreamBus } from '../wire-config.js';
import type { GguiSession } from '@ggui-ai/protocol';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

async function flush(fn: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

describe('a mount says whether it paints (ggui#1103)', () => {
  it('react mount: painted is false with no code, false when the module throws, and the scope really is empty', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, { render: { componentCode: '   ' } });
    });
    expect(mount!.painted).toBe(false);
    const scope = container.querySelector('div[class^="ggui-rcr-"]');
    expect(scope!.querySelectorAll(':scope > *')).toHaveLength(1); // the <style>, nothing else

    const thrower = makeContainer();
    let broken: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      broken = await mountReactRoot(thrower, { render: { componentCode: 'throw new Error("boom");' }, onError: () => {} });
    });
    expect(broken!.painted).toBe(false);
  });

  it('render item: a provisional mount paints (it shows a placeholder) even though no component code arrived', async () => {
    const container = makeContainer();
    const render: GguiSession = {
      id: 'render_painted_1',
      appId: 'app_001',
      componentCode: '',
      props: {},
      eventSequence: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    let handle: Awaited<ReturnType<typeof mountRender>> | null = null;
    await flush(async () => {
      handle = await mountRender(container, {
        render,
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        sessionId: 'render_painted_1',
        themeMode: 'light' as const,
      });
    });
    expect(handle!.kind).toBe('provisional');
    // The distinction this row exists for: nothing painted is NOT the same as
    // no component code — the provisional mount shows the user something.
    expect(handle!.painted).toBe(true);
  });
});
