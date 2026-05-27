/**
 * `createPropsUpdateHandler` — direct unit coverage for the channel
 * handler factored out of `handleRendererMessage` in B2.
 *
 * The renderer-integration test exercises the full dispatch path
 * (handler routed via ChannelRegistry); these tests pin the handler
 * in isolation so a future refactor can reshape the registry without
 * losing coverage of the branches:
 *   - empty stackItemId skipped
 *   - non-object props skipped
 *   - missing target skipped
 *   - mcpApps / system targets skipped (no propsSpec)
 *   - invalid props (failed validation) skipped
 *   - valid props patched + renderer re-applied
 *
 * R6 (2026-05-26) moved the polling descriptor out of the handler
 * (registry-level now — see `snapshot-polling.test.ts`). This file
 * only exercises the on-message branches.
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
