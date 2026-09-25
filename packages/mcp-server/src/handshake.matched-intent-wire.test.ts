/**
 * ggui#1336 / ggui#1333 — the client-side half of the declare-then-emit
 * premise, over a REAL MCP SDK client on a linked in-memory transport.
 *
 * The SDK client builds and caches a validator for each tool's advertised
 * `outputSchema` at `listTools`, and validates every `callTool` result's
 * `structuredContent` against that cache. Step A declared
 * `blueprintMeta.matchedIntent` on the (closed) advertised schema; step B
 * emits it on a judged hit. This pins two things a unit test of the handler
 * cannot: the schema the client actually caches is CLOSED and names the
 * member with its cap, and a client holding that schema accepts the
 * emission without a validation error.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  handshakeSuggestionSchema,
  type DataContract,
  type HandshakeSuggestion,
} from '@ggui-ai/protocol';
import { InMemoryKeyValueStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiHandshakeHandler,
  type HandlerContext,
  type HandshakeNegotiator,
} from '@ggui-ai/mcp-server-handlers';
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

const ctx: HandlerContext = { appId: 'app-1', requestId: 'r-1' };

/**
 * The advertised output schema, in the exact JSON the SDK projects and the
 * client caches. The parse IS the assertion: `blueprintMeta` is closed and
 * names `matchedIntent` as a string capped at 280.
 */
const advertisedHandshakeOutput = z.object({
  properties: z.object({
    suggestion: z.object({
      properties: z.object({
        blueprintMeta: z.object({
          additionalProperties: z.literal(false),
          properties: z.object({
            matchedIntent: z.object({
              type: z.literal('string'),
              maxLength: z.literal(280),
            }),
          }),
        }),
      }),
    }),
  }),
});

describe('ggui_handshake over a real SDK client — blueprintMeta.matchedIntent (#1336, #1333)', () => {
  it('the client caches a CLOSED output schema that names the member, and accepts a judged hit that carries it', async () => {
    const judged: HandshakeSuggestion = {
      origin: 'cache',
      rationale: 'match-semantic: a saved interface matches this intent — reusing it',
      blueprintMeta: {
        blueprintId: 'bp_judged',
        contractHash: 'hash_judged',
        variance: {},
        matchedIntent: 'Weekly haircut availability grid',
      },
    };
    const effectiveContract: DataContract = {};
    const negotiator: HandshakeNegotiator = {
      decide: () => ({
        action: 'reuse',
        reason: 'judged hit',
        suggestion: judged,
        effectiveContract,
      }),
    };
    const handler = createGguiHandshakeHandler({
      kvStore: new InMemoryKeyValueStore(),
      negotiator,
    });
    const server = buildMcpServer({ name: 'test', version: '0' }, [handler], () => ctx, silentLogger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'matched-intent-wire-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      // `listTools` is where the client builds and caches the validator it
      // will hold for the rest of the session.
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'ggui_handshake');
      expect(tool).toBeDefined();
      advertisedHandshakeOutput.parse(tool?.outputSchema);

      // A judged own-pool hit — the one path that emits the member.
      const result = await client.callTool({
        name: 'ggui_handshake',
        arguments: {
          intent: 'Weekly haircut availability grid for a barber',
          blueprintDraft: { contract: {} },
        },
      });
      // No validation error: the member the client cached is the member the
      // server sent. (A cached schema WITHOUT the member is exactly the #1333
      // rejection this two-step landing exists to avoid.)
      expect(result.isError).toBeFalsy();
      const out = z.object({ suggestion: handshakeSuggestionSchema }).parse(result.structuredContent);
      expect(out.suggestion.blueprintMeta.matchedIntent).toBe('Weekly haircut availability grid');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
