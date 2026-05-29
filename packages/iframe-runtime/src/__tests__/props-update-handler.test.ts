/**
 * Deterministic unit test for `createPropsUpdateHandler` — the channel
 * handler the boot consolidation (#290) re-points at the SINGLE visible
 * mount surface (`applyRender` over `currentRender`).
 *
 * This is the prepared-data-contract proof the flaky agent-loop e2e
 * could never reach: no LLM, no agent, no WS — inject a fixed current
 * render + a `props_update` frame and assert the patched props flow
 * through `applyRender`. The #290 bug was a `props_update` landing on a
 * stale/detached mount (the deleted Instance-C closure) instead of the
 * visible render; with one handler → one `applyRender` → one
 * `currentRender`, that frame now provably patches the visible mount.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Render, PropsUpdatePayload } from '@ggui-ai/protocol';
import type { RenderSeedInput } from '../types.js';
import { createPropsUpdateHandler } from '../channels/props-update.js';

/** Typed mount-surface stub — matches the handler's `applyRender` dep. */
const makeApplyRender = (): ReturnType<
  typeof vi.fn<(render: Render | RenderSeedInput) => Promise<void>>
> => vi.fn(async (_render: Render | RenderSeedInput): Promise<void> => {});

function componentRender(props: Record<string, unknown>): Render {
  return {
    id: 'render_1',
    appId: 'app_1',
    componentCode: 'export default () => null',
    props: props as Render['props'],
    eventSequence: 0,
    createdAt: 0,
    lastActivityAt: 0,
    expiresAt: 0,
  };
}

describe('createPropsUpdateHandler (#290 boot-consolidation core)', () => {
  it('patches the visible render: props_update → applyRender({...current, props})', async () => {
    const current = componentRender({ checked: false });
    const applyRender = makeApplyRender();
    const handler = createPropsUpdateHandler({
      getCurrentRender: () => current,
      applyRender,
    });

    await handler.onMessage({
      renderId: 'render_1',
      props: { checked: true },
    } as PropsUpdatePayload);

    expect(applyRender).toHaveBeenCalledTimes(1);
    const applied = applyRender.mock.calls[0]?.[0];
    expect(applied?.id).toBe('render_1');
    expect(applied?.props).toEqual({ checked: true });
    // The patch preserves the render identity/code — only props change.
    expect(
      applied && 'componentCode' in applied ? applied.componentCode : undefined,
    ).toBe('export default () => null');
  });

  it('drops a frame whose renderId does not match the mounted render', async () => {
    const applyRender = makeApplyRender();
    const handler = createPropsUpdateHandler({
      getCurrentRender: () => componentRender({ checked: false }),
      applyRender,
    });
    await handler.onMessage({
      renderId: 'some_other_render',
      props: { checked: true },
    } as PropsUpdatePayload);
    expect(applyRender).not.toHaveBeenCalled();
  });

  it('no-ops when no render is mounted yet', async () => {
    const applyRender = makeApplyRender();
    const handler = createPropsUpdateHandler({
      getCurrentRender: () => null,
      applyRender,
    });
    await handler.onMessage({
      renderId: 'render_1',
      props: { checked: true },
    } as PropsUpdatePayload);
    expect(applyRender).not.toHaveBeenCalled();
  });

  it('no-ops for a system render (system cards take no props_update)', async () => {
    const applyRender = makeApplyRender();
    const systemRender: Render = {
      id: 'render_1',
      appId: 'app_1',
      type: 'system',
      kind: 'no-credentials',
      eventSequence: 0,
      createdAt: 0,
      lastActivityAt: 0,
      expiresAt: 0,
    };
    const handler = createPropsUpdateHandler({
      getCurrentRender: () => systemRender,
      applyRender,
    });
    await handler.onMessage({
      renderId: 'render_1',
      props: { checked: true },
    } as PropsUpdatePayload);
    expect(applyRender).not.toHaveBeenCalled();
  });

  it('ignores a malformed frame (null props)', async () => {
    const applyRender = makeApplyRender();
    const handler = createPropsUpdateHandler({
      getCurrentRender: () => componentRender({ checked: false }),
      applyRender,
    });
    await handler.onMessage({
      renderId: 'render_1',
      props: null,
    } as unknown as PropsUpdatePayload);
    expect(applyRender).not.toHaveBeenCalled();
  });
});
