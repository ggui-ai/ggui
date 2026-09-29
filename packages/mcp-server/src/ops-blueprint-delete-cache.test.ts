/**
 * ggui#1541 — the server wires the ops delete to the SAME cache registry the
 * ops writers mirror into, so a deleted blueprint leaves reuse. Before, the
 * family gave `cacheRegistry` to generate and register but not to delete:
 * the durable row went, the cache row stayed, and the next handshake on the
 * same contract reused the deleted id (staging receipts on the row).
 *
 * Built through `buildOpsBlueprintHandlers`, the one body both composition
 * paths use (the default handler set and a deployment's explicit handlers
 * with an ops bundle, which is the hosted pod's shape), and called directly,
 * past the control plane's confirm gate, which is not what this pins.
 */
import { describe, expect, it } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  InMemoryBlueprintIndex,
  InMemoryBlueprintStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
  createInMemoryBlueprintSearch,
  createInMemoryGeneratorRegistry,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { UiGenerator } from '@ggui-ai/mcp-server-core';
import { findBlueprintExact } from '@ggui-ai/mcp-server-handlers/renders';
import { buildOpsBlueprintHandlers } from './server.js';

const CONTRACT: DataContract = {
  propsSpec: {
    description: 'delete-wiring contract',
    properties: { title: { schema: { type: 'string' }, required: false, description: 'optional title' } },
  },
};

describe('buildOpsBlueprintHandlers — delete takes a blueprint out of reuse (ggui#1541)', () => {
  it('register, then delete through the family the server builds: the exact-key probe no longer matches', async () => {
    const generator: UiGenerator = {
      slug: 'ui-gen-default',
      tier: 'default',
      model: 'anthropic/claude-haiku-4-5',
      async generate() {
        throw new Error('not exercised by this test');
      },
    };
    const blueprintStore = new InMemoryBlueprintStore();
    const cacheRegistry = {
      embedding: new MockEmbeddingProvider(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
    };
    const handlers = buildOpsBlueprintHandlers({
      bundle: {
        registry: createInMemoryGeneratorRegistry({ default: generator }),
        blueprintStore,
        blueprintSearch: createInMemoryBlueprintSearch({ blueprintStore }),
        cacheRegistry,
        authorizeAppAccess: async () => ({ allowed: true as const }),
      },
    });
    const byName = (name: string) => {
      const handler = handlers.find((h) => h.name === name);
      if (handler === undefined) throw new Error(`${name} is not in the family`);
      return handler;
    };
    const ctx = { appId: 'app-1', requestId: 'req-1' };
    const exact = () => findBlueprintExact(cacheRegistry, 'app-1', 'template', blueprintKey(CONTRACT));

    const registered = (await byName('ggui_ops_register_blueprint').handler(
      { contract: CONTRACT, componentCode: 'export default function Card(){ return null; }' },
      ctx,
    )) as { blueprintId: string };
    expect(await exact(), 'the registration is reusable before the delete').not.toBeNull();

    await byName('ggui_ops_delete_blueprint').handler({ blueprintId: registered.blueprintId }, ctx);
    expect(await exact()).toBeNull();
    expect(await blueprintStore.get(registered.blueprintId)).toBeNull();
  });
});
