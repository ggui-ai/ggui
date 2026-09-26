/**
 * ggui#1421 — the served chain, end to end over a real MCP SDK client:
 * a draft whose `nextStep` dangles is REPAIRED (`suggestion.origin:
 * "synth"`), the paired render commits the repaired contract, and
 * `ggui_get_render_source` reads it back WITH the `oneShot` the agent
 * declared. Found on tag 12's dev read: the repair used to rebuild each
 * action from label + schema alone, so the served card lost its
 * one-shot guard while the only finding named the dangling `nextStep`.
 *
 * No LLM: the handshake negotiator is the shared `decideHandshake` core
 * bound to a canned `LLMCaller` that answers the repair tool with what
 * its schema can carry (`{label, schema}` per action — the exact shape
 * that erased the declaration), and the generator echoes the contract it
 * was given, as `@ggui-ai/ui-gen` does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { UiGenerateResult } from '@ggui-ai/mcp-server-core';
import { InMemoryKeyValueStore } from '@ggui-ai/mcp-server-core/in-memory';
import { decideHandshake, type GenerationDeps } from '@ggui-ai/mcp-server-handlers/renders';
import type { LLMCaller } from '@ggui-ai/negotiator';
import type { DataContract } from '@ggui-ai/protocol';
import { createGguiServer, type GguiServer } from './server.js';

/** Looks compiled — the read plane refuses an authored source byte-identical to it. */
const COMPILED = '"use strict";var BookingConfirm=()=>null;export{BookingConfirm as default};';
/** The authored TSX the read plane answers with. */
const AUTHORED = 'export default function BookingConfirm() { return null; }';
const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

/** The booking-confirm draft of the dev read: `confirm` declares oneShot; both nextSteps dangle. */
const DRAFT = {
  propsSpec: {
    properties: {
      bookingId: { schema: { type: 'string' }, required: true },
      restaurant: { schema: { type: 'string' }, required: true },
    },
  },
  actionSpec: {
    confirm: {
      label: 'Confirm booking',
      description: 'Places the reservation. Once-only: a second confirm would place a second reservation.',
      oneShot: true,
      nextStep: 'booking_confirm',
      example: { bookingId: 'bk_7f3a' },
    },
    edit: { label: 'Change details', nextStep: 'booking_edit', example: { bookingId: 'bk_7f3a' } },
  },
};

/** What the repair tool can author for that draft: props, and per action only label + schema. */
const REPAIR_TOOL_ANSWER = {
  propsSpec: {
    properties: {
      bookingId: { schema: { type: 'string' }, required: true },
      restaurant: { schema: { type: 'string' }, required: true },
    },
  },
  actionSpec: {
    confirm: { label: 'Confirm booking', schema: EMPTY_SCHEMA },
    edit: { label: 'Change details', schema: EMPTY_SCHEMA },
  },
  reason: 'dropped the dangling nextStep hints',
};

const repairLlm: LLMCaller = {
  async call() {
    throw new Error('text mode is not used by the repair');
  },
  async callStructured() {
    return REPAIR_TOOL_ANSWER;
  },
};

const ECHOING_GENERATION: GenerationDeps = {
  uiGenerator: {
    slug: 'ui-gen-default',
    tier: 'default',
    model: 'anthropic/claude-haiku-4-5',
    generate: async (input): Promise<UiGenerateResult> => ({
      ok: true,
      response: {
        sessionId: input.request.sessionId,
        componentCode: COMPILED,
        sourceCode: AUTHORED,
        // The OSS generator echoes the contract it was asked to conform to;
        // the committed session's actionSpec is that echo (render.ts).
        ...(input.contract !== undefined ? { contract: input.contract } : {}),
      },
      metadata: {
        provider: 'anthropic',
        generator: 'ui-gen-default',
        model: 'anthropic/claude-haiku-4-5',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        cacheHit: false,
      },
    }),
  },
  resolveLlm: () => ({
    selection: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    providerKey: { provider: 'anthropic', key: 'sk-test' },
  }),
  blueprints: { list: async () => [], get: async () => null },
};

let server: GguiServer;
let client: Client;

beforeAll(async () => {
  server = createGguiServer({
    logger: silentLogger,
    renderChannel: true,
    mcpApps: { wsUrl: 'ws://localhost/ws' },
    wsTokenSecret: 'test-secret-for-1421-wire',
    generation: ECHOING_GENERATION,
    handshake: {
      kvStore: new InMemoryKeyValueStore(),
      negotiator: {
        decide: (input) => decideHandshake({ resolveLlm: () => repairLlm, warn: () => undefined }, input),
      },
    },
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('server.address() did not return AddressInfo');
  client = new Client({ name: 'ggui-1421-wire', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer t' } },
    }),
  );
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe('a repaired draft serves the oneShot it declared (ggui#1421, over a real SDK client)', () => {
  it('handshake → synth with the gate’s findings only → render → ggui_get_render_source carries confirm.oneShot', async () => {
    const hs = await client.callTool({
      name: 'ggui_handshake',
      arguments: { intent: 'Build a table-booking confirmation card for a restaurant.', blueprintDraft: { contract: DRAFT } },
    });
    const handshake = hs.structuredContent as {
      handshakeId?: string;
      action?: string;
      suggestion?: { origin?: string; validationFindings?: { code: string; path: string }[] };
    };
    expect(handshake.action).toBe('create');
    expect(handshake.suggestion?.origin).toBe('synth');
    expect(handshake.suggestion?.validationFindings?.map((f) => [f.code, f.path])).toEqual([
      ['CTR_REF_NEXT_STEP', 'actionSpec.confirm.nextStep'],
      ['CTR_REF_NEXT_STEP', 'actionSpec.edit.nextStep'],
    ]);
    const handshakeId = handshake.handshakeId;
    if (handshakeId === undefined) throw new Error(`handshake did not commit: ${JSON.stringify(hs)}`);

    const rendered = await client.callTool({
      name: 'ggui_render',
      arguments: { handshakeId, props: { bookingId: 'bk_7f3a', restaurant: 'Harbor & Vine' } },
    });
    const sessionId = (rendered.structuredContent as { sessionId?: string } | undefined)?.sessionId;
    if (sessionId === undefined) throw new Error(`render did not commit: ${JSON.stringify(rendered)}`);

    const source = await client.callTool({ name: 'ggui_get_render_source', arguments: { sessionId } });
    const served = (source.structuredContent as { blueprint?: { contract?: DataContract } } | undefined)?.blueprint?.contract;
    expect(served?.actionSpec?.['confirm']).toMatchObject({
      label: 'Confirm booking',
      oneShot: true,
      description: 'Places the reservation. Once-only: a second confirm would place a second reservation.',
      example: { bookingId: 'bk_7f3a' },
    });
    expect(served?.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(served?.actionSpec?.['edit']).toMatchObject({ label: 'Change details', example: { bookingId: 'bk_7f3a' } });
    expect(served?.actionSpec?.['edit']).not.toHaveProperty('oneShot');
  });
});
