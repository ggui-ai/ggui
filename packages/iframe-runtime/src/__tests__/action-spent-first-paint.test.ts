/**
 * ggui#1223 — a reloaded card paints its consumed `oneShot` control as spent
 * on the FIRST paint, before any press.
 *
 * guuey#1331's staging read found the guard held (0 POSTs after a reload) while
 * the card painted `Confirm` live until the refused press. The runtime's config
 * now exposes the guard's own spent set as `actionSpent`, and the card mounts
 * inside `ActionSpentContext`, so `useActionSpent` reads the persisted record at
 * first paint. With no context (a host that does not provide one, the N−1 case),
 * the hook reads `false` and the guard still stops the dispatch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ActionSpec, ComponentGguiSession, GguiSession } from '@ggui-ai/protocol';
import { useActionSpent } from '@ggui-ai/wire';
import { ActionSpentContext } from '@ggui-ai/wire/internal';
import { buildRootWireConfig, StreamBus } from '../wire-config.js';

const SPEC: ActionSpec = { confirm: { label: 'Confirm', oneShot: true } };

function makeRender(overrides: Partial<ComponentGguiSession>): GguiSession {
  return {
    id: 'r_1223',
    appId: 'app_x',
    componentCode: '/* unused */',
    description: 'a card with a oneShot confirm',
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    actionSpec: SPEC,
    ...overrides,
  };
}

function Probe(): ReturnType<typeof createElement> {
  const spent = useActionSpent('confirm');
  return createElement('button', { disabled: spent }, spent ? 'Submitted' : 'Confirm');
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

describe('useActionSpent at first paint (ggui#1223)', () => {
  function configFor(render: GguiSession, send = vi.fn()) {
    return {
      send,
      config: buildRootWireConfig({
        sessionId: render.id,
        appId: 'app_x',
        getCurrentGguiSession: () => render,
        manager: { send },
        streamBus: new StreamBus(),
      }),
    };
  }

  it('a reloaded card with a persisted record on its own epoch paints the control SPENT before any press', async () => {
    const { config } = configFor(makeRender({ epoch: 2, spentOneShots: { epoch: 2, actions: ['confirm'] } }));
    const el = await paint(createElement(ActionSpentContext.Provider, { value: config.actionSpent }, createElement(Probe)));
    expect(el.querySelector('button')?.textContent).toBe('Submitted');
    expect(el.querySelector('button')?.disabled).toBe(true);
  });

  it('a fresh card (the record is from an earlier epoch) paints the control live', async () => {
    const { config } = configFor(makeRender({ epoch: 3, spentOneShots: { epoch: 2, actions: ['confirm'] } }));
    const el = await paint(createElement(ActionSpentContext.Provider, { value: config.actionSpent }, createElement(Probe)));
    expect(el.querySelector('button')?.textContent).toBe('Confirm');
  });

  it('this card’s own committed dispatch repaints the control spent, with no render update', async () => {
    const { config } = configFor(makeRender({}));
    const el = await paint(createElement(ActionSpentContext.Provider, { value: config.actionSpent }, createElement(Probe)));
    expect(el.querySelector('button')?.textContent).toBe('Confirm');
    await act(async () => {
      config.dispatch('confirm', {});
    });
    expect(el.querySelector('button')?.textContent).toBe('Submitted');
  });

  it('N−1: with no ActionSpentContext the hook reads false, and the guard still stops the dispatch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { config, send } = configFor(makeRender({ epoch: 2, spentOneShots: { epoch: 2, actions: ['confirm'] } }));
    const el = await paint(createElement(Probe));
    expect(el.querySelector('button')?.textContent).toBe('Confirm');
    config.dispatch('confirm', {});
    expect(send).not.toHaveBeenCalled();
  });
});
