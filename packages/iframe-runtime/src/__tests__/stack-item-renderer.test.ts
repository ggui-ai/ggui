/**
 * Tests for the stack-item dispatcher + stack-level orchestrator.
 *
 * The dispatch tree (provisional / react / mcpApps) is the
 * renderer's most-visible correctness seam — asserting the kind
 * transitions + per-id mount lifecycle is the audit lock.
 */
import { describe, it, expect } from 'vitest';
import { act } from 'react';
import type { SessionStackEntry } from '@ggui-ai/protocol';
import type { McpAppsStackItem } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  renderStackItem,
  StackRenderer,
  type StackItemHandle,
} from '../stack-item-renderer.js';
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

function componentItem(
  id: string,
  componentCode: string = '',
  extra: Partial<SessionStackEntry> = {},
): SessionStackEntry {
  return {
    id,
    componentCode,
    createdAt: new Date().toISOString(),
    ...extra,
  } as SessionStackEntry;
}

function mcpAppsItem(id: string): McpAppsStackItem {
  return {
    type: 'mcpApps',
    id,
    createdAt: new Date().toISOString(),
    source: {
      connectorId: 'stripe',
      toolName: 'checkout',
      resourceUri: 'ui://stripe/checkout',
    },
  };
}

describe('renderStackItem — kind detection on initial mount', () => {
  it('mounts provisional when componentCode is empty', async () => {
    const container = makeContainer();
    let handle: StackItemHandle | null = null;
    await flush(async () => {
      handle = await renderStackItem(container, {
        stackItem: componentItem('x', ''),
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        sessionId: 's',
      });
    });
    expect(handle!.kind).toBe('provisional');
    handle!.unmount();
  });

  it('mounts react when componentCode is non-empty', async () => {
    const container = makeContainer();
    let handle: StackItemHandle | null = null;
    await flush(async () => {
      handle = await renderStackItem(container, {
        stackItem: componentItem('x', 'export default () => null;'),
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        sessionId: 's',
      });
    });
    expect(handle!.kind).toBe('react');
    handle!.unmount();
  });

  it('mounts mcpApps iframe when type === mcpApps', async () => {
    const container = makeContainer();
    let handle: StackItemHandle | null = null;
    await flush(async () => {
      handle = await renderStackItem(container, {
        stackItem: mcpAppsItem('x'),
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        sessionId: 's',
      });
    });
    expect(handle!.kind).toBe('mcpApps');
    expect(container.querySelector('iframe[data-ggui-mcp-apps]')).not.toBeNull();
    handle!.unmount();
    // Unmount removes the iframe.
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('renderStackItem — kind transition on update', () => {
  it('transitions provisional → react when componentCode lands', async () => {
    const container = makeContainer();
    let handle: StackItemHandle | null = null;
    await flush(async () => {
      handle = await renderStackItem(container, {
        stackItem: componentItem('x', ''),
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        sessionId: 's',
      });
    });
    expect(handle!.kind).toBe('provisional');

    await flush(async () => {
      await handle!.update({
        stackItem: componentItem('x', 'export default () => null;'),
        scopedWireConfig: null,
        streamBus: new StreamBus(),
        sessionId: 's',
      });
    });
    expect(handle!.kind).toBe('react');

    handle!.unmount();
  });

  it('tears down provisional mount on kind transition (no envelope leak)', async () => {
    const bus = new StreamBus();
    const container = makeContainer();
    let handle: StackItemHandle | null = null;
    await flush(async () => {
      handle = await renderStackItem(container, {
        stackItem: componentItem('x', ''),
        scopedWireConfig: null,
        streamBus: bus,
        sessionId: 's',
      });
    });
    // Pre-transition: one subscriber registered for _ggui:preview.
    // After transition to react, that subscription MUST be released
    // so subsequent bus.emit doesn't hit a stale handler.
    await flush(async () => {
      await handle!.update({
        stackItem: componentItem('x', 'export default () => null;'),
        scopedWireConfig: null,
        streamBus: bus,
        sessionId: 's',
      });
    });

    // Emit after transition — must not throw + must have no observable effect.
    expect(() =>
      bus.emit({
        sessionId: 's',
        channel: '_ggui:preview',
        mode: 'append',
        payload: { createSurface: { surfaceId: 'stale' } },
      }),
    ).not.toThrow();

    handle!.unmount();
  });
});

describe('StackRenderer — applyStack lifecycle', () => {
  it('mounts new items, updates existing, unmounts removed', async () => {
    const bus = new StreamBus();
    const containers = new Map<string, HTMLElement>();
    const containerFor = (id: string): HTMLElement => {
      let c = containers.get(id);
      if (c === undefined) {
        c = makeContainer();
        containers.set(id, c);
      }
      return c;
    };

    const renderer = new StackRenderer({
      containerFor,
      getScopedWireConfig: () => null,
      streamBus: bus,
      sessionId: 's',
    });

    // Initial: two items.
    const a = componentItem('a', '');
    const b = componentItem('b', 'export default () => null;');
    await flush(async () => {
      await renderer.applyStack([a, b]);
    });

    expect(containers.size).toBe(2);
    expect(containers.get('a')?.children.length).toBeGreaterThan(0);
    expect(containers.get('b')?.children.length).toBeGreaterThan(0);

    // Update: a gets componentCode (provisional → react). b removed.
    const aWithCode = componentItem('a', 'export default () => null;');
    await flush(async () => {
      await renderer.applyStack([aWithCode]);
    });

    // b was unmounted — its container should be cleared.
    expect(containers.get('b')?.children.length).toBe(0);
    // a survives; still has children.
    expect(containers.get('a')?.children.length).toBeGreaterThan(0);

    renderer.unmountAll();
  });
});
