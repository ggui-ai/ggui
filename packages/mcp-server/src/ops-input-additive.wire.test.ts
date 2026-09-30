/**
 * The N−1 premise every additive tool input rests on (ggui#1570): on the MCP
 * path, the SDK is handed a tool's raw SHAPE and wraps it in a stripping
 * object, so an argument a server does not name is dropped before the handler
 * runs. An ops door whose own schema is `.strict()` (it re-parses with it)
 * therefore still accepts a call from a newer client that sends a member this
 * server predates, and the handler never sees that member. If a path ever
 * handed a handler RAW arguments, a strict door would refuse the call instead,
 * and every additive ops input would stop being N−1-safe. This pins the
 * premise, for every such input, not only `clonedFrom`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InMemoryBlueprintStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiOpsRegisterBlueprintHandler } from '@ggui-ai/mcp-server-handlers/ops-blueprint';
import type { HandlerContext, SharedHandler } from '@ggui-ai/mcp-server-handlers';
import { describe, expect, it } from 'vitest';
import { z, type ZodRawShape } from 'zod';
import { buildMcpServer } from './build-mcp.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return silentLogger;
  },
};
const ctx: HandlerContext = { appId: 'app-1', requestId: 'r-additive' };

async function connect(handlers: SharedHandler<ZodRawShape, ZodRawShape>[]) {
  const server = buildMcpServer({ name: 'additive', version: '0' }, handlers, () => ctx, silentLogger, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'additive-test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('an argument the server does not name is stripped before a strict handler (ggui#1570)', () => {
  it('a strict-schema handler receives the call without the unknown member, and answers', async () => {
    const shape = { x: z.string() };
    const seen: unknown[] = [];
    const handler: SharedHandler<ZodRawShape, ZodRawShape> = {
      name: 'strict_probe',
      description: 'strict probe',
      audience: ['ops'],
      inputSchema: shape,
      outputSchema: { ok: z.boolean() },
      async handler(input) {
        seen.push(input);
        // The door's own re-parse, as the ops handlers do.
        z.object(shape).strict().parse(input);
        return { ok: true };
      },
    };
    const { client, close } = await connect([handler]);
    try {
      const result = await client.callTool({ name: 'strict_probe', arguments: { x: 'a', memberThisServerPredates: 1 } });
      expect(result.isError).not.toBe(true);
      expect(seen).toEqual([{ x: 'a' }]);
    } finally {
      await close();
    }
  });

  it('ggui_ops_register_blueprint accepts a call carrying a member it does not name, and registers', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const door = createGguiOpsRegisterBlueprintHandler({ blueprintStore });
    const { client, close } = await connect([door]);
    try {
      const result = await client.callTool({
        name: 'ggui_ops_register_blueprint',
        arguments: {
          contract: { propsSpec: { properties: {} } },
          componentCode: 'export default function R() { return null; }',
          memberThisServerPredates: 'x',
        },
      });
      expect(result.isError).not.toBe(true);
      expect((await blueprintStore.listAllForApp('app-1')).length).toBe(1);
    } finally {
      await close();
    }
  });

  it('control: the same door handed the same member RAW (in-process) refuses it, so the stripping above is what carries the premise', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const door = createGguiOpsRegisterBlueprintHandler({ blueprintStore });
    await expect(
      door.handler(
        {
          contract: { propsSpec: { properties: {} } },
          componentCode: 'export default function R() { return null; }',
          memberThisServerPredates: 'x',
        },
        ctx,
      ),
    ).rejects.toThrow();
    expect((await blueprintStore.listAllForApp('app-1')).length).toBe(0);
  });
});
