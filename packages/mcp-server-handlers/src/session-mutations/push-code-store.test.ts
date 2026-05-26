/**
 * Content-addressable code delivery — `ggui_push` writes generated
 * `componentCode` to a `CodeStore` and surfaces `codeUrl` + `codeHash`
 * on the response.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseMcpAppAiGguiMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { CodeStore, UiGenerator } from '@ggui-ai/mcp-server-core';
import { sha256Hex } from '@ggui-ai/mcp-server-core';
import {
  InMemoryBlueprintProvider,
  InMemoryKeyValueStore,
  InMemorySessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import type { GenerationDeps } from './push.js';
import { createGguiPushHandler } from './push.js';
import { createGguiHandshakeHandler } from './handshake.js';

// Minimal contract used when a test doesn't care about contract content
// but the handler now requires `contract` on every push.
const NOOP_CONTRACT: DataContract = {};

function makeCodeStore(): CodeStore & {
  puts: Array<{ hash: string; code: string }>;
} {
  const map = new Map<string, string>();
  const puts: Array<{ hash: string; code: string }> = [];
  return {
    puts,
    hashOf: (code) => sha256Hex(code),
    put: vi.fn(async (hash: string, code: string) => {
      puts.push({ hash, code });
      map.set(hash, code);
    }),
    get: vi.fn(async (hash: string) => map.get(hash) ?? null),
  };
}

const FAKE_CODE = 'export default function Card(){return null;}';

function makeFakeGenerator(): UiGenerator {
  return {
    slug: 'ui-gen-default-test',
    tier: 'default',
    model: 'test',
    generate: async () => ({
      ok: true,
      response: {
        stackItemId: 'page-stub',
        componentCode: FAKE_CODE,
        sourceCode: FAKE_CODE,
      },
      metadata: {
        provider: 'anthropic',
        model: 'fake',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        cacheHit: false,
      },
    }),
  };
}

function makeGenerationDeps(): GenerationDeps {
  return {
    uiGenerator: makeFakeGenerator(),
    blueprints: new InMemoryBlueprintProvider(),
    resolveLlm: async () => ({
      selection: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      providerKey: { provider: 'anthropic', key: 'sk-stub' },
    }),
  };
}

async function seedAndPush(
  kvStore: InMemoryKeyValueStore,
  pushArgs: { handshakeId: string; contract: DataContract },
  intent = 'a card with weather',
): Promise<string> {
  const handshake = createGguiHandshakeHandler({ kvStore });
  const out = await handshake.handler(
    {
      sessionId: 'sess-test',
      intent,
      blueprintDraft: { contract: pushArgs.contract },
    },
    { appId: 'app-1', requestId: 'r' },
  );
  return out.handshakeId;
}

describe('push handler — codeStore wiring', () => {
  it('puts (hash, code) and surfaces codeUrl + codeHash on success', async () => {
    const sessionStore = new InMemorySessionStore();
    const kvStore = new InMemoryKeyValueStore();
    const codeStore = makeCodeStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      codeStore,
      codeBaseUrl: 'https://app.example.com',
      generation: makeGenerationDeps(),
    });
    const handshakeId = await seedAndPush(kvStore, {
      handshakeId: '',
      contract: NOOP_CONTRACT,
    });

    const output = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );

    expect(codeStore.puts).toHaveLength(1);
    const expectedHash = sha256Hex(FAKE_CODE);
    expect(codeStore.puts[0]?.hash).toBe(expectedHash);
    expect(codeStore.puts[0]?.code).toBe(FAKE_CODE);

    const out = output as typeof output & {
      codeUrl?: string;
      codeHash?: string;
    };
    expect(out.codeHash).toBe(expectedHash);
    expect(out.codeUrl).toBe(
      `https://app.example.com/code/${expectedHash}.js`,
    );
    expect(out.codeReady).toBe(true);
  });

  it('forwards codeUrl + codeHash onto the ai.ggui/stack-item slice meta', async () => {
    const sessionStore = new InMemorySessionStore();
    const kvStore = new InMemoryKeyValueStore();
    const codeStore = makeCodeStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      mintWsToken: () => ({
        wsUrl: 'ws://localhost/ws',
        token: 'tok.sig',
        expiresAt: '2026-12-31T00:00:00Z',
      }),
      runtimeUrl: '/_ggui/iframe-runtime.js',
      codeStore,
      codeBaseUrl: 'https://app.example.com',
      generation: makeGenerationDeps(),
    });
    const handshakeId = await seedAndPush(kvStore, {
      handshakeId: '',
      contract: NOOP_CONTRACT,
    });

    const output = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );
    const meta = await handler.resultMeta?.(
      output,
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );
    const parsed = parseMcpAppAiGguiMeta(meta);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const stackItem = parsed.meta.stackItem;
    expect(stackItem).toBeDefined();
    if (!stackItem) return;
    const expectedHash = sha256Hex(FAKE_CODE);
    expect(stackItem.codeUrl).toBe(
      `https://app.example.com/code/${expectedHash}.js`,
    );
    expect(stackItem.codeHash).toBe(expectedHash);

    // T3-1 (2026-05-13) — the inline base64 `componentCode` channel
    // was retired. The stack-item slice MUST NOT carry it; codeUrl is
    // the sole static-component delivery channel.
    expect(
      (stackItem as unknown as Record<string, unknown>).componentCode,
    ).toBeUndefined();

    // Regression for 2026-05-13 live claude.ai smoke: push.resultMeta
    // MUST include stackItemId so iframe-runtime's dispatchWiredAction
    // can thread it into ggui_runtime_submit_action. Without this, the
    // submit_action handler returns PIPE_NOT_FOUND (per the fail-loud
    // fix) and the iframe falls through to ui/message — events never
    // drain through the agent's open ggui_consume long-poll. Every
    // other slice-meta transport (`/r/`, `/api/bootstrap/`,
    // `ggui_update.resultMeta`) already projects this field; push
    // was the drift point.
    expect(stackItem.stackItemId).toBe(output.stackItemId);
  });

  it('normalizes trailing slash on codeBaseUrl', async () => {
    const sessionStore = new InMemorySessionStore();
    const kvStore = new InMemoryKeyValueStore();
    const codeStore = makeCodeStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      codeStore,
      codeBaseUrl: 'https://app.example.com/',
      generation: makeGenerationDeps(),
    });
    const handshakeId = await seedAndPush(kvStore, {
      handshakeId: '',
      contract: NOOP_CONTRACT,
    });

    const output = (await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    )) as { codeUrl?: string };
    const expectedHash = sha256Hex(FAKE_CODE);
    expect(output.codeUrl).toBe(
      `https://app.example.com/code/${expectedHash}.js`,
    );
    expect(output.codeUrl).not.toContain('//code/');
  });

  it('is a no-op when codeStore is wired but codeBaseUrl is absent (config-incomplete)', async () => {
    const sessionStore = new InMemorySessionStore();
    const kvStore = new InMemoryKeyValueStore();
    const codeStore = makeCodeStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      codeStore,
      generation: makeGenerationDeps(),
    });
    const handshakeId = await seedAndPush(kvStore, {
      handshakeId: '',
      contract: NOOP_CONTRACT,
    });

    const output = (await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    )) as { codeUrl?: string; codeHash?: string };
    expect(codeStore.puts).toHaveLength(0);
    expect(output.codeUrl).toBeUndefined();
    expect(output.codeHash).toBeUndefined();
  });

  it('does NOT call codeStore.put on the placeholder path (empty componentCode)', async () => {
    const sessionStore = new InMemorySessionStore();
    const kvStore = new InMemoryKeyValueStore();
    const codeStore = makeCodeStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      codeStore,
      codeBaseUrl: 'https://app.example.com',
      // generation deliberately absent → placeholder mode
    });
    const handshakeId = await seedAndPush(kvStore, {
      handshakeId: '',
      contract: NOOP_CONTRACT,
    });

    const output = (await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    )) as { codeUrl?: string; codeHash?: string; codeReady?: boolean };
    expect(codeStore.puts).toHaveLength(0);
    expect(output.codeUrl).toBeUndefined();
    expect(output.codeHash).toBeUndefined();
    expect(output.codeReady).toBe(false);
  });

  it('codeStore put failures fall through silently (legacy inline-base64 path stays alive)', async () => {
    const sessionStore = new InMemorySessionStore();
    const kvStore = new InMemoryKeyValueStore();
    const failingStore: CodeStore = {
      hashOf: (code) => sha256Hex(code),
      put: vi.fn(async () => {
        throw new Error('disk full');
      }),
      get: vi.fn(async () => null),
    };
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      codeStore: failingStore,
      codeBaseUrl: 'https://app.example.com',
      generation: makeGenerationDeps(),
    });
    const handshakeId = await seedAndPush(kvStore, {
      handshakeId: '',
      contract: NOOP_CONTRACT,
    });

    const output = (await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    )) as { codeUrl?: string; codeReady?: boolean };
    expect(output.codeUrl).toBeUndefined();
    expect(output.codeReady).toBe(true);
  });
});
