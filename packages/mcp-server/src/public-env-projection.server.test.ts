/**
 * ggui#1892 — a generated component's `ai.ggui/render` slice carries the
 * app's public env, filtered to what its declared gadgets `require`.
 *
 * The projection function and the render gate have their own unit
 * tests (`derivePublicEnvProjection`, `assertPublicEnvSatisfied`). This
 * pins the WIRING: `ggui_render` through `createGguiServer` over HTTP,
 * with an LLM-free generator, an app whose gadget requires one key and
 * whose public env carries that key plus one nobody asked for. Two
 * emitters must agree: the `ggui_render` result's `_meta` and the inline
 * shell `resources/read` serves.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiGenerateResult } from '@ggui-ai/mcp-server-core';
import {
  InMemoryAppMetadataStore,
  InMemoryAuthAdapter,
  InMemoryGguiSessionStore,
  InMemoryKeyValueStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { decideHandshake, type GenerationDeps, type HandshakeDecideInput } from '@ggui-ai/mcp-server-handlers/renders';
import type { LLMCaller } from '@ggui-ai/negotiator';
import { isRecord, type DataContract, type GadgetDescriptor } from '@ggui-ai/protocol';
import { GGUI_RENDER_RESOURCE_URI, MCP_APP_AI_GGUI_RENDER_META_KEY } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { Logger } from './logger.js';
import { createGguiServer, type GguiServer } from './server.js';

const SECRET = 'public-env-projection-secret';
const TOKEN_KEY = 'GGUI_PUBLIC_APP_MAPBOX_TOKEN';
const UNASKED_KEY = 'GGUI_PUBLIC_APP_UNUSED';

let server: GguiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const MAPBOX: GadgetDescriptor = {
  package: '@ggui-samples/gadget-mapbox',
  version: '0.0.1',
  requires: [TOKEN_KEY],
  exports: [
    {
      hook: 'useMapbox',
      description: 'Mapbox GL JS interactive map renderer.',
      usage: 'Mount when intent names interactive maps.',
      example: { center: [0, 0], zoom: 2 },
    },
  ],
};

const CONTRACT = {
  propsSpec: {
    description: 'a map card',
    properties: { center: { schema: { type: 'string' }, required: false } },
  },
  clientCapabilities: { gadgets: { [MAPBOX.package]: { useMapbox: {} } } },
} satisfies DataContract;

const unusedLlm: LLMCaller = {
  async call() {
    throw new Error('a conforming draft needs no LLM');
  },
  async callStructured() {
    throw new Error('a conforming draft needs no LLM');
  },
};

/** A generator that answers without an LLM, echoing the contract it was asked to conform to. */
const ECHOING_GENERATION: GenerationDeps = {
  uiGenerator: {
    slug: 'ui-gen-default',
    tier: 'default',
    model: 'anthropic/claude-haiku-4-5',
    generate: async (input): Promise<UiGenerateResult> => ({
      ok: true,
      response: {
        sessionId: input.request.sessionId,
        componentCode: '"use strict";var Card=()=>null;export{Card as default};',
        sourceCode: 'export default function Card() { return null; }',
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

async function boot(publicEnv: Readonly<Record<string, string>>): Promise<Client> {
  const logger: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  server = createGguiServer({
    logger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    renderChannel: true,
    renderStore: new InMemoryGguiSessionStore(),
    wsTokenSecret: SECRET,
    appMetadataStore: new InMemoryAppMetadataStore({ defaultGadgets: [MAPBOX], defaultPublicEnv: publicEnv }),
    generation: ECHOING_GENERATION,
    handshake: {
      kvStore: new InMemoryKeyValueStore(),
      negotiator: {
        decide: (input: HandshakeDecideInput) =>
          decideHandshake({ resolveLlm: () => unusedLlm, warn: () => undefined }, input),
      },
    },
  });
  const http = await server.listen(0, '127.0.0.1');
  const addr = http.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  const client = new Client({ name: 'public-env-projection-test', version: '0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer dev' } },
    }),
  );
  return client;
}

/** Handshake on the contract, then render it; returns the result's render slice and session id. */
async function render(client: Client): Promise<{ slice: Record<string, unknown>; sessionId: string }> {
  const hs = await client.callTool({
    name: 'ggui_handshake',
    arguments: { intent: 'a small map card', blueprintDraft: { contract: CONTRACT }, forceCreate: true },
  });
  const hsOut = hs.structuredContent;
  if (!isRecord(hsOut) || typeof hsOut['handshakeId'] !== 'string') throw new Error('expected a handshakeId');
  const result = await client.callTool({
    name: 'ggui_render',
    arguments: { handshakeId: hsOut['handshakeId'], props: {}, override: { contract: CONTRACT } },
  });
  if (result.isError === true) throw new Error(`ggui_render refused: ${JSON.stringify(result.content)}`);
  const slice = isRecord(result._meta) ? result._meta[MCP_APP_AI_GGUI_RENDER_META_KEY] : undefined;
  const out = result.structuredContent;
  if (!isRecord(slice) || !isRecord(out) || typeof out['sessionId'] !== 'string') {
    throw new Error('expected a render slice and a sessionId');
  }
  return { slice, sessionId: out['sessionId'] };
}

/** The inline render slice of the shell `resources/read` serves for the session. */
async function shellSlice(client: Client, sessionId: string): Promise<Record<string, unknown>> {
  const result = await client.readResource({ uri: `${GGUI_RENDER_RESOURCE_URI}/${sessionId}` });
  const content = result.contents[0];
  if (content === undefined || !('text' in content) || typeof content.text !== 'string') {
    throw new Error('expected a text resource content');
  }
  const match = content.text.match(/globalThis\.__GGUI_META__ = (.+?);<\/script>/);
  if (!match || match[1] === undefined) throw new Error('inline bootstrap not found in shell HTML');
  const envelope: unknown = JSON.parse(
    match[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'),
  );
  if (!isRecord(envelope)) throw new Error('inline bootstrap is not a JSON object');
  const slice = envelope[MCP_APP_AI_GGUI_RENDER_META_KEY];
  if (!isRecord(slice)) throw new Error('inline bootstrap has no render slice');
  return slice;
}

describe('a generated component carries the public env its gadgets require (ggui#1892)', () => {
  it('ggui_render stamps only the required key on the render slice, never the one nobody asked for', async () => {
    const client = await boot({ [TOKEN_KEY]: 'pk.test', [UNASKED_KEY]: 'secret-ish' });
    try {
      const { slice } = await render(client);
      expect(slice['kind']).toBeUndefined();
      expect(slice['publicEnv']).toEqual({ [TOKEN_KEY]: 'pk.test' });
    } finally {
      await client.close();
    }
  });

  it('the inline shell served for the same session carries the same projection', async () => {
    const client = await boot({ [TOKEN_KEY]: 'pk.test', [UNASKED_KEY]: 'secret-ish' });
    try {
      const { sessionId } = await render(client);
      expect((await shellSlice(client, sessionId))['publicEnv']).toEqual({ [TOKEN_KEY]: 'pk.test' });
    } finally {
      await client.close();
    }
  });
});
