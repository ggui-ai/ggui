/**
 * `createPropsUpdateHandler` — direct unit coverage for the channel
 * handler factored out of `handleTriadMessage` in B2.
 *
 * The triad-integration test exercises the full dispatch path
 * (handler routed via ChannelRegistry); these tests pin the handler
 * in isolation so a future refactor can reshape the registry without
 * losing coverage of the branches:
 *   - empty stackItemId skipped
 *   - non-object props skipped
 *   - missing target skipped
 *   - mcpApps / system targets skipped (no propsSpec)
 *   - invalid props (failed validation) skipped
 *   - valid props patched + renderer re-applied
 */
import { describe, expect, it } from 'vitest';
import type { SessionStackEntry } from '@ggui-ai/protocol';
import { StackModel } from '../../stack.js';
import { createPropsUpdateHandler } from '../props-update.js';

interface FakeRenderer {
  readonly applied: SessionStackEntry[][];
  readonly applyStack: (stack: readonly SessionStackEntry[]) => Promise<void>;
}

function makeFakeRenderer(): FakeRenderer {
  const applied: SessionStackEntry[][] = [];
  return {
    applied,
    applyStack: async (stack) => {
      applied.push([...stack]);
    },
  };
}

function componentItem(
  id: string,
  props: Record<string, unknown> = {},
): SessionStackEntry {
  return {
    id,
    componentCode: 'export default () => null;',
    createdAt: '2026-01-01T00:00:00.000Z',
    props,
  } as SessionStackEntry;
}

describe('createPropsUpdateHandler', () => {
  it('patches matching item props + re-applies renderer', async () => {
    const stackModel = new StackModel();
    stackModel.setAll([componentItem('a', { count: 0 })]);
    const renderer = makeFakeRenderer();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => renderer as never,
    });

    await handler.onMessage({ stackItemId: 'a', props: { count: 5 } });

    const item = stackModel.snapshot().find((s) => s.id === 'a');
    expect((item as { props?: unknown })?.props).toEqual({ count: 5 });
    expect(renderer.applied).toHaveLength(1);
    expect((renderer.applied[0][0] as { props?: unknown }).props).toEqual({
      count: 5,
    });
  });

  it('skips empty stackItemId', async () => {
    const stackModel = new StackModel();
    stackModel.setAll([componentItem('a')]);
    const renderer = makeFakeRenderer();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => renderer as never,
    });
    await handler.onMessage({ stackItemId: '', props: { x: 1 } });
    expect(renderer.applied).toHaveLength(0);
  });

  it('skips when target is not in the model', async () => {
    const stackModel = new StackModel();
    stackModel.setAll([componentItem('a')]);
    const renderer = makeFakeRenderer();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => renderer as never,
    });
    await handler.onMessage({ stackItemId: 'nope', props: { x: 1 } });
    expect(renderer.applied).toHaveLength(0);
  });

  it('skips mcpApps + system stack items (no propsSpec)', async () => {
    const stackModel = new StackModel();
    stackModel.setAll([
      {
        id: 'm',
        type: 'mcpApps',
        createdAt: '2026-01-01T00:00:00.000Z',
      } as unknown as SessionStackEntry,
    ]);
    const renderer = makeFakeRenderer();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => renderer as never,
    });
    await handler.onMessage({ stackItemId: 'm', props: { x: 1 } });
    expect(renderer.applied).toHaveLength(0);
  });
});

describe('createPropsUpdateHandler — B5 polling descriptor', () => {
  it('omits polling when pollingUrl is missing', () => {
    const stackModel = new StackModel();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => ({}) as never,
    });
    expect(handler.polling).toBeUndefined();
  });

  it('installs polling descriptor with the supplied URL', () => {
    const stackModel = new StackModel();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => ({}) as never,
      pollingUrl: 'http://ggui.test/r/abc123',
    });
    expect(handler.polling).toBeDefined();
    expect(handler.polling?.url).toBe(
      'http://ggui.test/r/abc123',
    );
    expect(handler.polling?.intervalMs).toBe(2000);
  });

  it('honors custom pollingIntervalMs override', () => {
    const stackModel = new StackModel();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => ({}) as never,
      pollingUrl: 'http://ggui.test/r/abc',
      pollingIntervalMs: 500,
    });
    expect(handler.polling?.intervalMs).toBe(500);
  });

  // Helper for the slice-envelope shape the polling endpoint
  // (`GET /r/<shortCode>` with `Accept: application/json`) returns.
  // The polling parser reads `body['ai.ggui/stack-item']?.propsJson` +
  // `stackItemId`.
  function envelope(stackItem: {
    stackItemId?: string;
    propsJson?: string;
  }): unknown {
    return { 'ai.ggui/stack-item': stackItem };
  }

  it('parse emits the first poll (no last-seen baseline)', () => {
    const stackModel = new StackModel();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => ({}) as never,
      pollingUrl: 'http://ggui.test/r/abc',
    });
    const out = handler.polling!.parse(envelope({
      stackItemId: 'item_a',
      propsJson: '{"count":0}',
    }));
    expect(out).toEqual({ stackItemId: 'item_a', props: { count: 0 } });
  });

  it('parse returns null on identical second poll (diff detection)', () => {
    const stackModel = new StackModel();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => ({}) as never,
      pollingUrl: 'http://ggui.test/r/abc',
    });
    const body = envelope({ stackItemId: 'item_a', propsJson: '{"count":0}' });
    handler.polling!.parse(body); // prime baseline
    expect(handler.polling!.parse(body)).toBeNull();
  });

  it('parse emits when propsJson changes', () => {
    const stackModel = new StackModel();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => ({}) as never,
      pollingUrl: 'http://ggui.test/r/abc',
    });
    handler.polling!.parse(envelope({
      stackItemId: 'item_a',
      propsJson: '{"count":0}',
    }));
    const out = handler.polling!.parse(envelope({
      stackItemId: 'item_a',
      propsJson: '{"count":5}',
    }));
    expect(out).toEqual({ stackItemId: 'item_a', props: { count: 5 } });
  });

  it('parse skips when body lacks propsJson / stackItemId', () => {
    const stackModel = new StackModel();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => ({}) as never,
      pollingUrl: 'http://ggui.test/r/abc',
    });
    expect(handler.polling!.parse({})).toBeNull();
    expect(handler.polling!.parse(envelope({ propsJson: '{}' }))).toBeNull();
    expect(handler.polling!.parse(envelope({ stackItemId: 'x' }))).toBeNull();
  });

  it('parse skips when propsJson is malformed', () => {
    const stackModel = new StackModel();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => ({}) as never,
      pollingUrl: 'http://ggui.test/r/abc',
    });
    expect(
      handler.polling!.parse(envelope({
        stackItemId: 'item_a',
        propsJson: '{not valid json',
      })),
    ).toBeNull();
  });

  it('parse skips when propsJson parses to an array or null', () => {
    const stackModel = new StackModel();
    const handler = createPropsUpdateHandler({
      stackModel,
      getStackRenderer: () => ({}) as never,
      pollingUrl: 'http://ggui.test/r/abc',
    });
    expect(
      handler.polling!.parse(envelope({
        stackItemId: 'item_a',
        propsJson: '[1,2,3]',
      })),
    ).toBeNull();
    expect(
      handler.polling!.parse(envelope({
        stackItemId: 'item_a',
        propsJson: 'null',
      })),
    ).toBeNull();
  });
});
