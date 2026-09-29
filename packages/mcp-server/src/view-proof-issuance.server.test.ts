/**
 * ggui#1415 lane 5b — where a view key is issued, and where it never is,
 * through `createGguiServer` over HTTP: the data-plane read door issues one
 * rooted in the slice's own ws token, a proof signed with it verifies at
 * the gate, the control plane and an anonymous caller get none, and the
 * two result tools that issue keys stay model-only.
 */
import { createHmac } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultViewKid, deriveViewKey, type UiGenerateResult } from '@ggui-ai/mcp-server-core';
import { InMemoryAuthAdapter, InMemoryGguiSessionStore, InMemoryKeyValueStore } from '@ggui-ai/mcp-server-core/in-memory';
import { decideHandshake, type GenerationDeps, type HandshakeDecideInput } from '@ggui-ai/mcp-server-handlers/renders';
import type { LLMCaller } from '@ggui-ai/negotiator';
import { isRecord, type ComponentGguiSession, type JsonObject } from '@ggui-ai/protocol';
import {
  GGUI_RENDER_RESOURCE_URI,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  MCP_APP_AI_GGUI_VIEW_META_KEY,
  formatViewProofV1,
  viewProofArgsBytes,
  viewProofCallBytes,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { DEFAULT_BUILDER_APP_ID } from './auth.js';
import type { Logger } from './logger.js';
import { createGguiServer, type CreateGguiServerOptions, type GguiServer } from './server.js';

const SECRET = 'issuance-test-secret';

interface Line {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

let server: GguiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A draft that conforms as authored, so the handshake commits it verbatim and never asks an LLM. */
const CLEAN_DRAFT = {
  propsSpec: { properties: { count: { schema: { type: 'number' }, required: true } } },
};

const unusedLlm: LLMCaller = {
  async call() {
    throw new Error('a conforming draft needs no LLM');
  },
  async callStructured() {
    throw new Error('a conforming draft needs no LLM');
  },
};

const CLEAN_HANDSHAKE = {
  kvStore: new InMemoryKeyValueStore(),
  negotiator: {
    decide: (input: HandshakeDecideInput) => decideHandshake({ resolveLlm: () => unusedLlm, warn: () => undefined }, input),
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

async function boot(
  extra: Pick<CreateGguiServerOptions, 'generation' | 'handshake' | 'viewProof'> = {},
): Promise<{ url: string; lines: Line[]; sessionId: string; renderStore: InMemoryGguiSessionStore }> {
  const lines: Line[] = [];
  const logger: Logger = {
    info: (event, fields) => void lines.push({ event, fields: fields ?? {} }),
    warn: (event, fields) => void lines.push({ event, fields: fields ?? {} }),
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  const renderStore = new InMemoryGguiSessionStore();
  const sessionId = (await renderStore.create({ appId: DEFAULT_BUILDER_APP_ID })).id;
  const render: ComponentGguiSession = {
    type: 'component',
    id: sessionId,
    appId: DEFAULT_BUILDER_APP_ID,
    componentCode: 'export default function Card(){return null;}',
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  await renderStore.commit({ render, appId: DEFAULT_BUILDER_APP_ID });
  server = createGguiServer({
    logger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    renderChannel: true,
    renderStore,
    wsTokenSecret: SECRET,
    ...extra,
  });
  const http = await server.listen(0, '127.0.0.1');
  const addr = http.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return { url: `http://127.0.0.1:${addr.port}`, lines, sessionId, renderStore };
}

async function connect(url: string, path: string, bearer: string | null): Promise<Client> {
  const client = new Client({ name: 'view-proof-issuance-test', version: '0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}${path}`), {
      requestInit: bearer !== null ? { headers: { Authorization: `Bearer ${bearer}` } } : {},
    }),
  );
  return client;
}

/** The inline render slice the read door's shell carries. */
async function readSlice(client: Client, sessionId: string): Promise<Record<string, unknown>> {
  const result = await client.readResource({ uri: `${GGUI_RENDER_RESOURCE_URI}/${sessionId}` });
  const content = result.contents[0];
  if (content === undefined || !('text' in content) || typeof content.text !== 'string') {
    throw new Error('expected a text resource content');
  }
  const match = content.text.match(/globalThis\.__GGUI_META__ = (.+?);<\/script>/);
  if (!match || match[1] === undefined) throw new Error('inline bootstrap not found in shell HTML');
  const envelope: unknown = JSON.parse(match[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));
  if (!isRecord(envelope)) throw new Error('inline bootstrap is not a JSON object');
  const slice = envelope[MCP_APP_AI_GGUI_RENDER_META_KEY];
  if (!isRecord(slice)) throw new Error('inline bootstrap has no render slice');
  return slice;
}

function claimsOf(token: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
  if (!isRecord(decoded)) throw new Error('claims are not an object');
  return decoded;
}

describe('where a view key is issued (ggui#1415, lane 5b)', () => {
  it('the data-plane read door issues a key rooted in the slice’s own token, and a dispatch signed with it verifies at the gate', async () => {
    const { url, lines, sessionId } = await boot();
    const client = await connect(url, '/mcp', 'dev');
    try {
      const slice = await readSlice(client, sessionId);
      const token = slice['wsToken'];
      const viewKey = slice['viewKey'];
      if (typeof token !== 'string' || typeof viewKey !== 'string') throw new Error('expected wsToken and viewKey on the slice');
      const root = token.split('.')[0] ?? '';
      expect(viewKey).toBe(deriveViewKey(root, SECRET).toString('base64url'));
      expect(claimsOf(token)).toMatchObject({ sessionId, kid: defaultViewKid(SECRET), src: 'read' });

      const args: JsonObject = {
        kind: 'dispatch',
        payload: { intent: 'confirm', actionData: null, uiContext: {} },
        sessionId,
        appId: DEFAULT_BUILDER_APP_ID,
        actionId: 'a3f2b1d4',
        firedAt: new Date().toISOString(),
      };
      const K = Buffer.from(viewKey, 'base64url');
      const toolName = 'ggui_runtime_submit_action';
      const nonce = 'AAECAwQFBgcICQoLDA0ODw';
      const vtime = String(Date.now());
      const argmac = createHmac('sha256', K).update(viewProofArgsBytes(toolName, args)).digest('base64url');
      const callmac = createHmac('sha256', K).update(viewProofCallBytes({ toolName, nonce, vtime, flags: '1', argmac })).digest('base64url');
      const proof = formatViewProofV1({ root, nonce, vtime, flags: '1', argmac, callmac });
      await client.callTool({ name: toolName, arguments: args, _meta: { [MCP_APP_AI_GGUI_VIEW_META_KEY]: proof } });
      const line = lines.filter((l) => l.event === 'tool_invoked' && l.fields['tool'] === toolName).at(-1)?.fields;
      // An allow-all adapter keys every caller as one identity (`dev`), so this
      // verdict says the plumbing works; the line's authSource keeps it apart
      // from a credentialed deployment's.
      expect(line).toMatchObject({ viewProof: 'valid', viewProofSessionId: sessionId, viewProofRootSrc: 'read', authSource: 'dev' });
    } finally {
      await client.close();
    }
  });

  it('the ggui_update result issues a key rooted in its own token, stamped as a result door', async () => {
    const { url, sessionId } = await boot();
    const client = await connect(url, '/mcp', 'dev');
    try {
      const result = await client.callTool({ name: 'ggui_update', arguments: { sessionId, kind: 'merge', patch: { count: 1 } } });
      const meta = isRecord(result._meta) ? result._meta[MCP_APP_AI_GGUI_RENDER_META_KEY] : undefined;
      if (!isRecord(meta)) throw new Error(`expected the render slice on the result's _meta, got ${JSON.stringify(result).slice(0, 300)}`);
      const token = meta['wsToken'];
      const viewKey = meta['viewKey'];
      if (typeof token !== 'string' || typeof viewKey !== 'string') throw new Error('expected wsToken and viewKey on the result slice');
      expect(viewKey).toBe(deriveViewKey(token.split('.')[0] ?? '', SECRET).toString('base64url'));
      expect(claimsOf(token)).toMatchObject({ kid: defaultViewKid(SECRET), src: 'result' });
      // The key rides `_meta` alone, the host's channel to the view: what the model reads carries none of it.
      expect(JSON.stringify([result.structuredContent ?? null, result.content ?? null])).not.toContain(viewKey);
    } finally {
      await client.close();
    }
  });

  it('the ggui_render result issues a key rooted in its own token, stamped as a result door', async () => {
    const { url } = await boot({ generation: ECHOING_GENERATION, handshake: CLEAN_HANDSHAKE });
    const client = await connect(url, '/mcp', 'dev');
    try {
      const hs = await client.callTool({
        name: 'ggui_handshake',
        arguments: { intent: 'Show a counter card.', blueprintDraft: { contract: CLEAN_DRAFT } },
      });
      const handshakeId = isRecord(hs.structuredContent) ? hs.structuredContent['handshakeId'] : undefined;
      if (typeof handshakeId !== 'string') throw new Error(`handshake did not commit: ${JSON.stringify(hs).slice(0, 300)}`);
      const result = await client.callTool({ name: 'ggui_render', arguments: { handshakeId, props: { count: 1 } } });
      const meta = isRecord(result._meta) ? result._meta[MCP_APP_AI_GGUI_RENDER_META_KEY] : undefined;
      if (!isRecord(meta)) throw new Error(`expected the render slice on the result's _meta, got ${JSON.stringify(result).slice(0, 300)}`);
      const token = meta['wsToken'];
      const viewKey = meta['viewKey'];
      if (typeof token !== 'string' || typeof viewKey !== 'string') throw new Error('expected wsToken and viewKey on the result slice');
      expect(viewKey).toBe(deriveViewKey(token.split('.')[0] ?? '', SECRET).toString('base64url'));
      expect(claimsOf(token)).toMatchObject({ kid: defaultViewKid(SECRET), src: 'result' });
      // The key rides `_meta` alone, the host's channel to the view: what the model reads carries none of it.
      expect(JSON.stringify([result.structuredContent ?? null, result.content ?? null])).not.toContain(viewKey);
    } finally {
      await client.close();
    }
  });

  it('a root too long to key issues no key at the door that minted it, and says so', async () => {
    const { url, lines, renderStore } = await boot();
    const sessionId = `render_${'x'.repeat(700)}`;
    const now = Date.now();
    await renderStore.commit({
      render: { type: 'component', id: sessionId, appId: DEFAULT_BUILDER_APP_ID, componentCode: 'export default function Card(){return null;}', eventSequence: 0, createdAt: now, lastActivityAt: now, expiresAt: now + 60_000 },
      appId: DEFAULT_BUILDER_APP_ID,
    });
    const client = await connect(url, '/mcp', 'dev');
    try {
      const slice = await readSlice(client, sessionId);
      expect(typeof slice['wsToken']).toBe('string');
      expect(slice).not.toHaveProperty('viewKey');
      expect(lines.filter((l) => l.event === 'view_key_not_issued').map((l) => l.fields)).toEqual([
        { sessionId, src: 'read', reason: 'oversize' },
      ]);
    } finally {
      await client.close();
    }
  });

  it('the control plane’s read door, to an anonymous caller, issues no key, and says why', async () => {
    const { url, lines, sessionId } = await boot();
    const client = await connect(url, '/control', null);
    try {
      const slice = await readSlice(client, sessionId);
      const token = slice['wsToken'];
      if (typeof token !== 'string') throw new Error('expected a wsToken on the slice');
      expect(slice).not.toHaveProperty('viewKey');
      // A read that issues no key mints the live credential alone: no root stamped for a key that never went out.
      expect(claimsOf(token)).toMatchObject({ sessionId });
      expect(claimsOf(token)).not.toHaveProperty('kid');
      expect(claimsOf(token)).not.toHaveProperty('src');
      expect(lines.filter((l) => l.event === 'view_key_not_issued').map((l) => l.fields)).toEqual([
        { sessionId, src: 'read', reason: 'not_a_view_mount' },
      ]);
    } finally {
      await client.close();
    }
  });

  it('ggui_list_sessions keeps minting a live credential and carries no key', async () => {
    const { url, sessionId } = await boot();
    const client = await connect(url, '/mcp', 'dev');
    try {
      const result = await client.callTool({ name: 'ggui_list_sessions', arguments: {} });
      const text = JSON.stringify(result.structuredContent ?? {});
      expect(text).toContain(sessionId);
      expect(text).not.toContain('viewKey');
      // Its credential is a plain live token, never a view root.
      const sessions = isRecord(result.structuredContent) ? result.structuredContent['sessions'] : undefined;
      const summary = Array.isArray(sessions) ? sessions.find((s) => isRecord(s) && s['sessionId'] === sessionId) : undefined;
      const token = isRecord(summary) ? summary['wsToken'] : undefined;
      if (typeof token !== 'string') throw new Error('expected a wsToken on the summary');
      expect(claimsOf(token)).not.toHaveProperty('kid');
      expect(claimsOf(token)).not.toHaveProperty('src');
    } finally {
      await client.close();
    }
  });

  it('the authorized refresh re-mints a plain live token, never a view root, and carries no key', async () => {
    const { url, sessionId } = await boot();
    const client = await connect(url, '/mcp', 'dev');
    try {
      const envelope = (await readSlice(client, sessionId))['wsToken'];
      if (typeof envelope !== 'string') throw new Error('expected a wsToken on the slice');
      const result = await client.callTool({ name: 'ggui_runtime_refresh_ws_token', arguments: { envelope } });
      const out = isRecord(result.structuredContent) ? result.structuredContent : {};
      expect(out['ok']).toBe(true);
      expect(JSON.stringify(result)).not.toContain('viewKey');
      const fresh = out['envelope'];
      if (typeof fresh !== 'string') throw new Error('expected a fresh envelope');
      expect(claimsOf(fresh)).toMatchObject({ sessionId });
      expect(claimsOf(fresh)).not.toHaveProperty('kid');
      expect(claimsOf(fresh)).not.toHaveProperty('src');
    } finally {
      await client.close();
    }
  });

  it('the two result tools that issue keys are served model-only: a view that could call one would receive a fresh key for any session it names', async () => {
    const { url } = await boot();
    const client = await connect(url, '/mcp', 'dev');
    try {
      const { tools } = await client.listTools();
      for (const name of ['ggui_render', 'ggui_update']) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, name).toBeDefined();
        const ui = isRecord(tool?._meta) ? tool?._meta['ui'] : undefined;
        expect(isRecord(ui) ? ui['visibility'] : undefined, name).toEqual(['model']);
      }
    } finally {
      await client.close();
    }
  });
});

describe('viewProof.keyedSince (ggui#1415, lane 5b)', () => {
  /** The era the gate names for an unsigned dispatch on the seeded session. */
  async function eraOfUnsignedDispatch(viewProof: { keyedSince?: number } | undefined): Promise<unknown> {
    const { url, lines, sessionId } = await boot(viewProof !== undefined ? { viewProof } : {});
    const client = await connect(url, '/mcp', 'dev');
    try {
      await client.callTool({
        name: 'ggui_runtime_submit_action',
        arguments: {
          kind: 'dispatch',
          payload: { intent: 'confirm', actionData: null, uiContext: {} },
          sessionId,
          appId: DEFAULT_BUILDER_APP_ID,
          actionId: 'a3f2b1d4',
          firedAt: new Date().toISOString(),
        },
      });
    } finally {
      await client.close();
    }
    await server?.close();
    server = undefined;
    return lines.filter((l) => l.event === 'tool_invoked' && l.fields['tool'] === 'ggui_runtime_submit_action').at(-1)?.fields['viewProofEra'];
  }

  it('reaches the gate: a session created after it is `current`, and without it every session is `legacy`', async () => {
    expect(await eraOfUnsignedDispatch({ keyedSince: 0 })).toBe('current');
    expect(await eraOfUnsignedDispatch(undefined)).toBe('legacy');
    expect(await eraOfUnsignedDispatch({ keyedSince: Date.now() + 3_600_000 })).toBe('legacy');
  });

  it('refuses to boot with a value that is not a finite, non-negative epoch', () => {
    for (const keyedSince of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createGguiServer({ mcpApps: true, renderChannel: true, wsTokenSecret: SECRET, viewProof: { keyedSince } }),
      ).toThrow(/viewProof\.keyedSince/);
    }
  });
});
