/**
 * ggui#1304 — the OSS server is bound to the kit's `read-plane-only`
 * catalog (SPEC §7.10.6): with `withholdResultMeta` on, a committed
 * render's result publishes the view's identity only — the locator on
 * `structuredContent.resourceUri` and on `_meta.ui.resourceUri`, one
 * value, no `ai.ggui/render` slice, no live-channel token — and a
 * `resources/read` of that locator mounts.
 *
 * Implementation → kit, as the domain-error and resource-read drivers
 * are: `createGguiServer` on a loopback port, driven by the SDK client
 * over the real Streamable HTTP transport. The one stub is the
 * generator (no LLM): how the render was produced is not what the
 * posture governs, and the catalog says so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { UiGenerateResult } from '@ggui-ai/mcp-server-core';
import type { GenerationDeps } from '@ggui-ai/mcp-server-handlers/renders';
import {
  isRawToolCallResult,
} from '@ggui-ai/protocol-conformance/domain-error-conformance';
import {
  readPlaneOnlyCases,
  runReadPlaneOnlyConformance,
  type ReadPlaneOnlyScenarioDriver,
} from '@ggui-ai/protocol-conformance/read-plane-only-conformance';
import type {
  ResourceReadOutcome,
  ResourceReadRenderMeta,
} from '@ggui-ai/protocol-conformance/resource-read-conformance';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { createGguiServer, type GguiServer } from './server.js';

const RENDER_META_KEY = 'ai.ggui/render';
const COMPONENT_CODE = 'export default function ReadPlaneOnly(){return null;}';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

/** The render meta a self-contained shell bootstraps with, narrowed to the kit's channel fields. */
function projectRenderMeta(html: string): ResourceReadRenderMeta {
  const match = /globalThis\.__GGUI_META__ = (.*?);<\/script>/s.exec(html);
  if (match === null) throw new Error('shell carries no bootstrap envelope');
  const envelope: unknown = JSON.parse(match[1] as string);
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error('bootstrap envelope is not an object');
  }
  const slice = (envelope as Record<string, McpAppAiGguiRenderMeta | undefined>)[RENDER_META_KEY];
  if (slice === undefined) throw new Error(`envelope carries no ${RENDER_META_KEY} slice`);
  return {
    ...(slice.codeUrl !== undefined ? { codeUrl: slice.codeUrl } : {}),
    ...(slice.codeB64 !== undefined ? { codeB64: slice.codeB64 } : {}),
    ...(slice.wsUrl !== undefined ? { wsUrl: slice.wsUrl } : {}),
    ...(slice.wsToken !== undefined ? { wsToken: slice.wsToken } : {}),
    ...(slice.kind !== undefined ? { kind: slice.kind } : {}),
    ...(slice.propsJson !== undefined ? { propsJson: slice.propsJson } : {}),
  };
}

const STUB_GENERATION: GenerationDeps = {
  uiGenerator: {
    slug: 'ui-gen-default',
    tier: 'default',
    model: 'anthropic/claude-haiku-4-5',
    generate: async (input): Promise<UiGenerateResult> => ({
      ok: true,
      response: { sessionId: input.request.sessionId, componentCode: COMPONENT_CODE },
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
  // A credential the stub generator never uses: without one the render
  // refuses NO_CREDENTIALS before it reaches the generator.
  resolveLlm: () => ({
    selection: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    providerKey: { provider: 'anthropic', key: 'sk-test' },
  }),
  blueprints: { list: async () => [], get: async () => null },
};

interface Booted {
  readonly server: GguiServer;
  readonly client: Client;
}

async function boot(withholdResultMeta: boolean): Promise<Booted> {
  const server = createGguiServer({
    logger: silentLogger,
    renderChannel: true,
    mcpApps: { wsUrl: 'ws://localhost/ws' },
    wsTokenSecret: 'test-secret-for-read-plane-only-conformance',
    withholdResultMeta,
    generation: STUB_GENERATION,
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('server.address() did not return AddressInfo');
  const client = new Client({ name: 'read-plane-only-conformance', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer t' } },
    }),
  );
  return { server, client };
}

/** One handshake → render, and reads through the same MCP client. */
function driverFor(client: Client): ReadPlaneOnlyScenarioDriver {
  return async () => ({
    async render() {
      const hs = await client.callTool({
        name: 'ggui_handshake',
        arguments: {
          intent: 'a one-line receipt for the read-plane-only conformance case',
          blueprintDraft: {
            contract: {
              propsSpec: {
                properties: { merchant: { schema: { type: 'string' }, required: true } },
              },
            },
          },
        },
      });
      const handshakeId = (hs.structuredContent as { handshakeId?: string } | undefined)
        ?.handshakeId;
      if (handshakeId === undefined) throw new Error(`handshake did not commit: ${JSON.stringify(hs)}`);
      const raw = await client.callTool({
        name: 'ggui_render',
        arguments: { handshakeId, props: { merchant: 'Blue Bottle' } },
      });
      if (!isRawToolCallResult(raw)) throw new Error(`not a raw tool result: ${JSON.stringify(raw)}`);
      return raw;
    },
    async read(uri): Promise<ResourceReadOutcome> {
      try {
        const res = await client.readResource({ uri });
        const first = res.contents[0];
        if (first === undefined || !('text' in first) || typeof first.text !== 'string') {
          throw new Error('read returned no text contents');
        }
        return { kind: 'mount', renderMeta: projectRenderMeta(first.text) };
      } catch (err) {
        if (err instanceof McpError) {
          return { kind: 'error', error: { code: err.code, message: err.message, data: err.data } };
        }
        throw err;
      }
    },
  });
}

describe("the OSS server passes the kit's read-plane-only catalog (ggui#1304)", () => {
  let booted: Booted;
  beforeAll(async () => {
    booted = await boot(true);
  });
  afterAll(async () => {
    await booted.client.close();
    await booted.server.close();
  });

  it('every catalog case passes: identity only on the result, and the published locator mounts', async () => {
    const result = await runReadPlaneOnlyConformance(driverFor(booted.client));
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.passed).toEqual(readPlaneOnlyCases.map((c) => c.name));
  });
});

describe('control: the same server with the posture OFF fails the catalog on the material it inlines', () => {
  let booted: Booted;
  beforeAll(async () => {
    booted = await boot(false);
  });
  afterAll(async () => {
    await booted.client.close();
    await booted.server.close();
  });

  it('the default posture inlines the slice and its live-channel token, and the catalog names both', async () => {
    const result = await runReadPlaneOnlyConformance(driverFor(booted.client));
    expect(result.passed).toEqual([]);
    expect(result.failed.map((f) => f.criterion).sort()).toEqual([
      'credential-withheld',
      'slice-withheld',
    ]);
  });
});
