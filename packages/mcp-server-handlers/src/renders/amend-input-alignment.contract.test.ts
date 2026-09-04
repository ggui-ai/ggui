/**
 * `ggui_amend` ↔ protocol `amendInputSchema` alignment (#483).
 *
 * The mutation-flow verdict matrix is owned by
 * `update-input-alignment.contract.test.ts` — both tools share ONE
 * core (`runPropsMutation`), so re-running it here would pin the same
 * code twice. What amend owes its own pins for is the CONTRACT
 * surface: field parity with the protocol arms (adding a field to
 * either side alone must fail) and output-key parity with
 * `amendOutputSchema`.
 */
import { describe, expect, it } from 'vitest';
import { amendInputSchema, amendOutputSchema } from '@ggui-ai/protocol';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiAmendHandler } from './amend.js';
import type { HandlerContext } from '../types.js';

const APP = 'app-a';
const NOW_MS = 1_700_000_000_000;

async function makeSeededHandler() {
  const store = new InMemoryGguiSessionStore();
  const render: ComponentGguiSession = {
    id: 'render-1',
    appId: APP,
    type: 'component',
    componentCode: 'export default function X(){return null}',
    props: { x: 1 },
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
  };
  await store.commit({ render, appId: APP });
  return { handler: createGguiAmendHandler({ renderStore: store }) };
}

describe('ggui_amend input/output alignment', () => {
  it('flat-shape keys are exactly the union of the protocol arms', async () => {
    const { handler } = await makeSeededHandler();
    const flatKeys = Object.keys(handler.inputSchema).sort();
    const armKeys = new Set<string>();
    for (const arm of amendInputSchema.options) {
      for (const k of Object.keys(arm.shape)) armKeys.add(k);
    }
    expect(flatKeys).toEqual([...armKeys].sort());
  });

  it('handler wire output parses under amendOutputSchema, and the declared shape IS the schema', async () => {
    const { handler } = await makeSeededHandler();
    const out = await handler.handler(
      { sessionId: 'render-1', kind: 'replace' as const, props: { x: 2 } },
      { appId: APP } as HandlerContext,
    );
    const parsed = amendOutputSchema.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(out).sort());
    // IDENTITY, not parity (ggui#798) — the same pin `ggui_update`
    // carries. A key-for-key comparison could only ever catch a
    // MISSING or EXTRA field; it stayed green against a declaration
    // that had merely COPIED the shape, and so was blind to a field
    // whose zod type or `.describe()` string had diverged — which is
    // the drift that actually reaches an agent through `tools/list`.
    expect(handler.outputSchema).toBe(amendOutputSchema.shape);
  });

  it('in-process dispatch faces the strict contract — unknown keys reject', async () => {
    const { handler } = await makeSeededHandler();
    await expect(
      handler.handler(
        {
          sessionId: 'render-1',
          kind: 'replace',
          props: { x: 2 },
          renderAsNew: true,
        },
        { appId: APP } as HandlerContext,
      ),
    ).rejects.toThrow();
  });
});
