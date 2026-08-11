/**
 * Session-API channel-URL stamping on the serveMount self-contained
 * shell (SSE launch slice).
 *
 * The `ai.ggui/render` slice advertises two token-bearing HTTP
 * fallback rungs beside the live WS trio — `pollingUrl`
 * (`/api/sessions/<id>/events?wsToken=`) and `sseUrl`
 * (`/api/sessions/<id>/stream?wsToken=`) — both composed by the
 * protocol's ONE `composeSessionApiUrls` composer. serveMount was the
 * confirmed stamping gap: it minted the trio but never threaded the
 * URLs into `buildSelfContainedShell`. These tests pin the closure:
 *
 *   - minter + publicBaseUrl wired → the inline `__GGUI_META__`
 *     carries BOTH URLs, composed off publicBaseUrl, embedding the
 *     minted token.
 *   - minter wired, publicBaseUrl absent → base falls back to the
 *     ws→http origin flip of the minted wsUrl, and the per-render
 *     `_meta.ui.csp.connectDomains` declares that flip origin
 *     (EventSource/fetch are connect-src-governed).
 *   - no minter → neither URL (they embed the token; absence is the
 *     honest no-HTTP-fallback signal).
 *   - registry-only rehydrate (`buildShellFromBlueprint`) → neither
 *     URL BY DESIGN: no live render row, no ledger, no minted token.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryBlueprintIndex,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from "@ggui-ai/mcp-server-core/in-memory";
import { registerBlueprint } from "@ggui-ai/mcp-server-handlers";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import type { ComponentGguiSession } from "@ggui-ai/protocol";
import { isRecord } from "@ggui-ai/protocol";
import {
  GGUI_RENDER_RESOURCE_URI,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
} from "@ggui-ai/protocol/integrations/mcp-apps";
import {
  registerGguiRenderResourceTemplate,
  type GguiRenderResourceTemplateOptions,
} from "./mcp-apps-outbound.js";

const APP_ID = "app_owner";
const COMPONENT_CODE = "export default function Card(){return null;}";
const WS_URL = "wss://live.example/ws";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const ownerCtx: HandlerContext = {
  appId: APP_ID,
  authSource: "apikey",
  apiKeyHash: "owner-hash",
  requestId: "req-owner",
};

const MINT: NonNullable<GguiRenderResourceTemplateOptions["mintWsToken"]> = (
  sessionId: string,
  _appId: string
) => ({
  wsUrl: WS_URL,
  token: `tok-${sessionId}`,
  expiresAt: "2030-01-01T00:00:00.000Z",
});

interface Fixture {
  readonly client: Client;
  readonly renderStore: InMemoryGguiSessionStore;
  readonly close: () => Promise<void>;
}

async function boot(
  options: Partial<GguiRenderResourceTemplateOptions> = {}
): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const server = new McpServer({ name: "channel-urls-test", version: "0.0.1" });
  registerGguiRenderResourceTemplate(server, {
    renderStore,
    runtimeUrl: "https://runtime.example/bundle.js",
    getContext: () => ownerCtx,
    logger: silentLogger,
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "channel-urls-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    renderStore,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function seedLiveRow(f: Fixture, sessionId: string): Promise<void> {
  const render: ComponentGguiSession = {
    type: "component",
    id: sessionId,
    appId: APP_ID,
    componentCode: COMPONENT_CODE,
    contentType: "application/javascript+react",
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  await f.renderStore.commit({ render, appId: APP_ID });
}

interface ShellRead {
  readonly slice: Record<string, unknown>;
  readonly meta: unknown;
}

/** Read the per-render resource and pull the inline `__GGUI_META__`
 *  render slice + the response `_meta` (CSP declaration) out of it. */
async function readShell(f: Fixture, uri: string): Promise<ShellRead> {
  const result = await f.client.readResource({ uri });
  const content = result.contents[0];
  if (content === undefined || !("text" in content) || typeof content.text !== "string") {
    throw new Error("expected a text resource content");
  }
  const match = content.text.match(/globalThis\.__GGUI_META__ = (.+?);<\/script>/);
  if (!match) throw new Error("inline bootstrap not found in shell HTML");
  const raw = match[1]
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\u0026/g, "&");
  const envelope: unknown = JSON.parse(raw);
  if (!isRecord(envelope)) throw new Error("inline bootstrap is not a JSON object");
  const slice = envelope[MCP_APP_AI_GGUI_RENDER_META_KEY];
  if (!isRecord(slice)) throw new Error("inline bootstrap has no render slice");
  return { slice, meta: content._meta };
}

function connectDomainsOf(meta: unknown): readonly string[] {
  if (!isRecord(meta)) throw new Error("expected _meta on the shell response");
  const ui = meta["ui"];
  if (!isRecord(ui)) throw new Error("expected _meta.ui");
  const csp = ui["csp"];
  if (!isRecord(csp)) throw new Error("expected _meta.ui.csp");
  const domains = csp["connectDomains"];
  if (!Array.isArray(domains)) throw new Error("expected connectDomains array");
  return domains as readonly string[];
}

describe("serveMount — pollingUrl + sseUrl stamping on the self-contained shell", () => {
  it("stamps both URLs off publicBaseUrl when the minter is wired", async () => {
    const f = await boot({ mintWsToken: MINT, publicBaseUrl: "https://public.example" });
    try {
      const sessionId = (await f.renderStore.create({ appId: APP_ID })).id;
      await seedLiveRow(f, sessionId);
      const { slice } = await readShell(f, `${GGUI_RENDER_RESOURCE_URI}/${sessionId}`);
      expect(slice["pollingUrl"]).toBe(
        `https://public.example/api/sessions/${encodeURIComponent(sessionId)}/events?wsToken=tok-${sessionId}`
      );
      expect(slice["sseUrl"]).toBe(
        `https://public.example/api/sessions/${encodeURIComponent(sessionId)}/stream?wsToken=tok-${sessionId}`
      );
      // The trio the URLs pair with is stamped too.
      expect(slice["wsUrl"]).toBe(WS_URL);
      expect(slice["wsToken"]).toBe(`tok-${sessionId}`);
    } finally {
      await f.close();
    }
  });

  it("falls back to the ws→http origin flip of the minted wsUrl when publicBaseUrl is absent, and declares that origin in the per-render CSP", async () => {
    const f = await boot({ mintWsToken: MINT });
    try {
      const sessionId = (await f.renderStore.create({ appId: APP_ID })).id;
      await seedLiveRow(f, sessionId);
      const { slice, meta } = await readShell(
        f,
        `${GGUI_RENDER_RESOURCE_URI}/${sessionId}`
      );
      expect(slice["pollingUrl"]).toBe(
        `https://live.example/api/sessions/${encodeURIComponent(sessionId)}/events?wsToken=tok-${sessionId}`
      );
      expect(slice["sseUrl"]).toBe(
        `https://live.example/api/sessions/${encodeURIComponent(sessionId)}/stream?wsToken=tok-${sessionId}`
      );
      // buildCspMeta extraConnectUrls extension: the flip origin is not
      // the CSP base origin (runtime.example fallback), so it must be
      // unioned into connectDomains or spec-compliant hosts block the
      // EventSource/fetch to it.
      expect(connectDomainsOf(meta)).toContain("https://live.example");
    } finally {
      await f.close();
    }
  });

  it("stamps neither URL when no minter is wired (URLs embed the token)", async () => {
    const f = await boot({
      codeStore: new InMemoryCodeStore(),
      codeBaseUrl: "https://code.example",
    });
    try {
      const sessionId = (await f.renderStore.create({ appId: APP_ID })).id;
      await seedLiveRow(f, sessionId);
      const { slice } = await readShell(f, `${GGUI_RENDER_RESOURCE_URI}/${sessionId}`);
      expect(slice["pollingUrl"]).toBeUndefined();
      expect(slice["sseUrl"]).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("registry-only rehydrate (buildShellFromBlueprint) carries neither URL by design", async () => {
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const embedding = new MockEmbeddingProvider();
    const registered = await registerBlueprint(
      { embedding, vectorStore, index },
      APP_ID,
      {
        kind: "template",
        contract: {},
        intent: "registry-fallback channel-url probe",
        componentCode: COMPONENT_CODE,
        source: { kind: "user" },
      }
    );
    const f = await boot({
      // Minter IS wired — proving the fallback path omits the URLs
      // because it has no live row to mint against, not because the
      // deployment lacks a minter.
      mintWsToken: MINT,
      publicBaseUrl: "https://public.example",
      vectorStore,
      index,
      defaultAppIdFallback: APP_ID,
      codeStore: new InMemoryCodeStore(),
      codeBaseUrl: "https://code.example",
    });
    try {
      const missingSessionId = randomUUID();
      const { slice } = await readShell(
        f,
        `${GGUI_RENDER_RESOURCE_URI}/${missingSessionId}/${registered.contractKey}`
      );
      expect(slice["pollingUrl"]).toBeUndefined();
      expect(slice["sseUrl"]).toBeUndefined();
      // Sanity: this really was the registry-fallback shell (static
      // component, no live trio).
      expect(slice["wsToken"]).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});
