/**
 * ggui#1398 — a tapped control can show it is working while the agent reacts.
 *
 * #1376's prod read: visitors re-tapped 1.5–8.6 s after the first tap, because
 * the card showed nothing for the 14–17 s the agent took. The runtime's config
 * now exposes the card's in-flight dispatches as `actionPending`, and the card
 * mounts inside `ActionPendingContext`, so `useActionPending` reads it. The
 * runtime's render-change notice (the session's next frame: the answer) clears
 * it. With no context (the N−1 case), the hook reads `false`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, createElement } from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as wire from '@ggui-ai/wire';
import type { ActionSpec, ComponentGguiSession, GguiSession } from '@ggui-ai/protocol';
import { useActionPending } from '@ggui-ai/wire';
import { ActionPendingContext } from '@ggui-ai/wire/internal';
import { buildRootWireConfig, StreamBus } from '../wire-config.js';
import { mountRender } from '../render-item.js';
import { installGlobalRegistry } from '../globals.js';

const SPEC: ActionSpec = { send: { label: 'Send' } };

function makeRender(overrides: Partial<ComponentGguiSession> = {}): GguiSession {
  return {
    id: 'r_1398',
    appId: 'app_x',
    componentCode: '/* unused */',
    description: 'a card with a send control',
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    actionSpec: SPEC,
    ...overrides,
  };
}

function Probe(): ReturnType<typeof createElement> {
  const sending = useActionPending('send');
  return createElement('button', { disabled: sending, 'aria-busy': sending }, sending ? 'Sending…' : 'Send');
}

async function paint(tree: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => {
    createRoot(el).render(tree);
  });
  return el;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('useActionPending in the runtime (ggui#1398)', () => {
  function build() {
    let current: GguiSession = makeRender();
    const listeners = new Set<() => void>();
    const send = vi.fn();
    const config = buildRootWireConfig({
      sessionId: current.id,
      appId: 'app_x',
      getCurrentGguiSession: () => current,
      renderChanges: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      manager: { send },
      streamBus: new StreamBus(),
    });
    const frameLands = (): void => {
      current = makeRender({ eventSequence: 1 });
      for (const notify of listeners) notify();
    };
    return { config, send, frameLands };
  }

  it('the control paints pending on its own committed dispatch, and clears when the session’s next frame lands', async () => {
    const { config, frameLands } = build();
    const el = await paint(createElement(ActionPendingContext.Provider, { value: config.actionPending }, createElement(Probe)));
    expect(el.querySelector('button')?.textContent).toBe('Send');
    await act(async () => {
      config.dispatch('send', {});
    });
    expect(el.querySelector('button')?.textContent).toBe('Sending…');
    expect(el.querySelector('button')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      frameLands();
    });
    expect(el.querySelector('button')?.textContent).toBe('Send');
    expect(el.querySelector('button')?.disabled).toBe(false);
  });

  it('a generated card importing useActionPending through the shim, mounted by the render item, paints pending and clears on the next frame', async () => {
    const empty: Record<string, never> = {};
    installGlobalRegistry({ react: React, reactDom: ReactDOM, primitives: empty, components: empty, compositions: empty, interact: empty, tokens: empty, wire });
    const CARD = `import React from 'react';
import { useActionPending } from '@ggui-ai/wire';
export default function Card() {
  const sending = useActionPending('send');
  return React.createElement('button', { 'aria-busy': sending }, sending ? 'Sending…' : 'Send');
}`;
    const { config, frameLands } = build();
    const streamBus = new StreamBus();
    const container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      await mountRender(container, { render: makeRender({ componentCode: CARD }), scopedWireConfig: config, streamBus, sessionId: 'r_1398' });
    });
    expect(container.querySelector('button')?.textContent).toBe('Send');
    await act(async () => {
      config.dispatch('send', {});
    });
    expect(container.querySelector('button')?.textContent).toBe('Sending…');
    await act(async () => {
      frameLands();
    });
    expect(container.querySelector('button')?.textContent).toBe('Send');
  });

  it('N−1: with no ActionPendingContext the hook reads false, and the dispatch still goes out', async () => {
    const { config, send } = build();
    const el = await paint(createElement(Probe));
    await act(async () => {
      config.dispatch('send', {});
    });
    expect(el.querySelector('button')?.textContent).toBe('Send');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
