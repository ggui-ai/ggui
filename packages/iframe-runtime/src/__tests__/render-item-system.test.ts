/**
 * Phase 1 (boot-consolidation) — system-card mount path through the
 * unified `mountRender` surface.
 *
 * BLOCKER #1 from the Workflow-1 audit: `SystemCardHost` was rendered in
 * exactly ONE place (the old `bootSelfContained` system-card branch), and
 * `detectKind` deliberately down-routed `type:'system'` to the
 * `'provisional'` A2UI placeholder. Once the consolidation deletes
 * `bootSelfContained`, the ONLY mount surface is `applyRender` →
 * `mountRender`. Without a real `'system'` branch here, every server
 * system card (no-credentials, mcp-apps-probe) would silently regress to
 * a blank placeholder on no-WS hosts (claude.ai / ChatGPT / Claude
 * Desktop) — the exact cross-host fallback the plan §8.1 must preserve.
 *
 * This spec locks: `mountRender(systemRender)` reports `kind === 'system'`
 * (NOT 'provisional'), mounts visible content, updates props in place,
 * and tears down cleanly.
 */
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import type { Render, JsonObject } from '@ggui-ai/protocol';
import { mountRender } from '../render-item.js';
import { StreamBus } from '../wire-config.js';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

async function flush(fn?: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    if (fn) await fn();
  });
}

function makeSystemRender(props: JsonObject = {}): Render {
  return {
    id: 'render_sys_1',
    appId: 'app_001',
    type: 'system',
    kind: 'no-credentials',
    props,
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

describe('mountRender — system card branch (Phase 1)', () => {
  it('routes type:system to the system renderer (not the provisional placeholder)', async () => {
    const container = makeContainer();
    let handle!: Awaited<ReturnType<typeof mountRender>>;
    await flush(async () => {
      handle = await mountRender(container, {
        render: makeSystemRender(),
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        renderId: 'render_sys_1',
      });
    });

    // The regression guard: BEFORE Phase 1, detectKind returned
    // 'provisional' for type:'system'. The real system branch reports
    // 'system'.
    expect(handle.kind).toBe('system');
    // SystemCardHost mounted SOMETHING (the no-credentials card tree).
    expect(container.children.length).toBeGreaterThan(0);

    handle.unmount();
  });

  it('updates a system card in place (same-kind prop update)', async () => {
    const container = makeContainer();
    let handle!: Awaited<ReturnType<typeof mountRender>>;
    await flush(async () => {
      handle = await mountRender(container, {
        render: makeSystemRender({ message: 'first' }),
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        renderId: 'render_sys_1',
      });
    });
    expect(handle.kind).toBe('system');

    await flush(async () => {
      await handle.update({
        render: makeSystemRender({ message: 'second' }),
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        renderId: 'render_sys_1',
      });
    });
    // Still a system mount — no teardown-to-provisional, no crash.
    expect(handle.kind).toBe('system');
    expect(container.children.length).toBeGreaterThan(0);

    handle.unmount();
  });

  it('unmount clears the system card container', async () => {
    const container = makeContainer();
    let handle!: Awaited<ReturnType<typeof mountRender>>;
    await flush(async () => {
      handle = await mountRender(container, {
        render: makeSystemRender(),
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        renderId: 'render_sys_1',
      });
    });
    await flush(() => {
      handle.unmount();
    });
    expect(container.children.length).toBe(0);
  });
});
