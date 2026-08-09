/**
 * `createGguiServer` forwards the operator's retention knob to the
 * WRITE path — the `render` deps it composes for `defaultHandlers`,
 * which hand it to `createGguiRenderHandler` (#459 residual 2).
 *
 * The sibling `server.read-path-wiring.test.ts` pins the READ half of
 * the same one-knob-two-consumers seam. This is the half that had no
 * pin at all: a mis-anchored mutation deleted the write-side forward
 * during #430 slice 3 and nothing in OSS went red. The cloud pod pins
 * its own threading, so the gap was invisible from there too.
 *
 * The failure this guards is quiet by construction. Drop the forward
 * and the handler falls back to its own `DEFAULT_RENDER_TTL_MS` (1h):
 * the server boots, `ggui_render` succeeds, the response is
 * byte-identical, and the only trace is a row that dies 23 hours before
 * the operator asked it to. Nothing about the render call looks wrong —
 * which is why the assertion has to reach into the committed row.
 *
 * Pinned through a real MCP `tools/call` rather than by inspecting the
 * options object, for the same reason the read-path file gives: the
 * interesting regression lives between the factory and the handler, and
 * both ends type-check with the forward missing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryGguiSessionStore } from "@ggui-ai/mcp-server-core/in-memory";
import { isRecord } from "@ggui-ai/protocol";
import { createGguiServer, type GguiServer } from "./server.js";

/**
 * Deliberately not a round hour or day, and an order of magnitude off
 * the handler's own 1h fallback: a passing assertion can only come from
 * the option being read, never from a default that happens to agree.
 */
const OPERATOR_TTL_MS = 86_401_000;

/** The handler's own fallback, spelled out so the pin names what it rejects. */
const HANDLER_FALLBACK_TTL_MS = 60 * 60 * 1000;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface Fixture {
  readonly client: Client;
  readonly server: GguiServer;
  readonly renderStore: InMemoryGguiSessionStore;
  readonly close: () => Promise<void>;
}

async function boot(): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const server = createGguiServer({
    logger: silentLogger,
    renderChannel: true,
    mcpApps: { wsUrl: "ws://localhost/ws" },
    wsTokenSecret: "test-secret-32bytes-for-hmac-1234",
    renderStore,
    renderTtlMs: OPERATOR_TTL_MS,
  });
  const httpServer = await server.listen(0, "127.0.0.1");
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server.address() did not return AddressInfo");
  }
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${addr.port}/mcp`),
    { requestInit: { headers: { Authorization: "Bearer dev" } } },
  );
  const client = new Client({ name: "write-path-wiring-client", version: "0.0.1" });
  await client.connect(transport);

  return {
    client,
    server,
    renderStore,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Drive one handshake → render pair and return the minted sessionId. */
async function commitRender(f: Fixture): Promise<string> {
  const handshake = await f.client.callTool({
    name: "ggui_handshake",
    arguments: { intent: "weather card for Tokyo", blueprintDraft: { contract: {} } },
  });
  const hs = handshake.structuredContent;
  if (!isRecord(hs) || typeof hs.handshakeId !== "string") {
    throw new Error("handshake did not return a handshakeId");
  }
  const render = await f.client.callTool({
    name: "ggui_render",
    arguments: { handshakeId: hs.handshakeId, props: {} },
  });
  // The failure commit stamps `expiresAt` from the SAME `renderTtlMs`,
  // so a `ggui_render` that starts erroring in this config would leave
  // every assertion below green while the test silently pinned the
  // error path instead of the happy one its name claims.
  expect(render.isError).toBeFalsy();
  const out = render.structuredContent;
  if (!isRecord(out) || typeof out.sessionId !== "string") {
    throw new Error("render did not return a sessionId");
  }
  return out.sessionId;
}

describe("createGguiServer — renderTtlMs reaches the render write path", () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  it("stamps the row `ggui_render` commits with the operator's retention", async () => {
    fx = await boot();
    const before = Date.now();
    const sessionId = await commitRender(fx);
    const after = Date.now();

    const stored = await fx.renderStore.get(sessionId);
    if (!stored) throw new Error("ggui_render reported success but committed no row");
    // The PAYLOAD's copy, not the row's own `expiresAt`. The row's is
    // the store's — `InMemoryGguiSessionStore` stamps every write with
    // its own `defaultTtlMs` and would answer identically with the
    // forward deleted. The payload copy is the one the render handler
    // stamps, so it is the only one that can observe this seam. (Same
    // two-spellings-of-one-fact asymmetry `extendExpiredRow` documents
    // on the read side.)
    const render = stored.render;
    if (render.type === "mcpApps") {
      throw new Error("ggui_render committed an mcpApps row; expected a component render");
    }
    const expiresAt = render.expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + OPERATOR_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + OPERATOR_TTL_MS);

    // Named explicitly: the whole regression is the row silently
    // carrying the handler's own hour instead. The bound above already
    // excludes it — this says so out loud, so a future reader knows the
    // magnitude gap between the two constants is load-bearing, not a
    // stylistic choice of test value.
    expect(expiresAt).toBeGreaterThan(after + HANDLER_FALLBACK_TTL_MS);
  });
});
