/**
 * `createGguiServer` forwards the durable substrate to the RESOURCE
 * READ path, not only to the write paths (#430 slice 3, task 4).
 *
 * `renderIdentityStore` and `durableBlueprints` are single top-level
 * factory options that two different consumers need. The write side
 * (the render handler's record write-through, the registration
 * durability) already read them. The read side — the per-render
 * `ui://ggui/render/…` resource template — is where a record is
 * SPENT, and forwarding it there is the whole point of keeping one.
 *
 * Pinned end-to-end through a real MCP `resources/read` rather than by
 * inspecting the options object, because the interesting failure is
 * invisible at the options layer: a factory that accepts both stores
 * and quietly hands neither to the template compiles, boots, and
 * answers every evicted locator with a typed failure — which is
 * exactly what a server that keeps no records is SUPPOSED to do, so
 * nothing about the response looks wrong.
 *
 * The converse matters just as much, and is why the substrate-less
 * case is pinned on the same fixture: the code a read fails with is
 * seeded from whether this server binds a substrate at all, so a
 * forwarding regression is observable as `NOT_SUPPORTED` appearing on
 * a server that wires one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  InMemoryBlueprintStore,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryRenderIdentityStore,
} from "@ggui-ai/mcp-server-core/in-memory";
import type { Blueprint, DataContract } from "@ggui-ai/protocol";
import { createGguiServer, type GguiServer } from "./server.js";

const RESOURCE_URI = "ui://ggui/render";
/** The universal-MCP single-tenant identity every dev-mode read attributes to. */
const BUILDER_APP_ID = "builder";
const CONTRACT_KEY = "0123456789abcdef";
const BLUEPRINT_ID = "bp_00000000-0000-4000-8000-000000000007";
const DURABLE_CODE = "export default function ReMinted(){return null;}";
const SESSION_ID = "render_evicted";

/** Distinctive so the assertion cannot pass on the handler's own default. */
const OPERATOR_TTL_MS = 86_401_000;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const CONTRACT: DataContract = {
  propsSpec: { properties: { city: { schema: { type: "string" } } } },
};

function sha256Hex(code: string): string {
  return createHash("sha256").update(code, "utf-8").digest("hex");
}

interface Fixture {
  readonly client: Client;
  readonly server: GguiServer;
  readonly renderStore: InMemoryGguiSessionStore;
  readonly close: () => Promise<void>;
}

async function boot(options: { readonly withSubstrate: boolean }): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const identityStore = new InMemoryRenderIdentityStore({ durability: 'durable' });
  const blueprintStore = new InMemoryBlueprintStore({ durability: 'durable' });
  const durableCodeStore = new InMemoryCodeStore({ durability: 'durable' });

  if (options.withSubstrate) {
    await identityStore.put({
      sessionId: SESSION_ID,
      appId: BUILDER_APP_ID,
      blueprintId: BLUEPRINT_ID,
      contractKey: CONTRACT_KEY,
      variantKey: "default",
      props: { city: "Seoul" },
      seqAtLastCommit: 4,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
    });
    const blueprint: Blueprint = {
      blueprintId: BLUEPRINT_ID,
      contractHash: CONTRACT_KEY,
      appId: BUILDER_APP_ID,
      codeHash: sha256Hex(DURABLE_CODE),
      source: { kind: "user" },
      variance: {},
      createdAt: "2026-08-01T00:00:00.000Z",
      createdBy: "agent",
      contract: CONTRACT,
    };
    await blueprintStore.put(blueprint);
    await durableCodeStore.put(sha256Hex(DURABLE_CODE), DURABLE_CODE);
  }

  const server = createGguiServer({
    logger: silentLogger,
    renderChannel: true,
    mcpApps: true,
    wsTokenSecret: "test-secret-32bytes-for-hmac-1234",
    renderStore,
    renderTtlMs: OPERATOR_TTL_MS,
    ...(options.withSubstrate
      ? {
          renderIdentityStore: identityStore,
          durableBlueprints: { blueprintStore, codeStore: durableCodeStore },
        }
      : {}),
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
  const client = new Client({ name: "read-path-wiring-client", version: "0.0.1" });
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

/** The JSON-RPC error body as the SDK client surfaces it. */
interface WireError {
  readonly code: number;
  readonly data?: { readonly code?: string };
}

async function readFailure(f: Fixture): Promise<WireError> {
  try {
    await f.client.readResource({
      uri: `${RESOURCE_URI}/${SESSION_ID}/${CONTRACT_KEY}`,
    });
  } catch (err) {
    return err as WireError;
  }
  throw new Error("read returned a result; expected a typed failure");
}

describe("createGguiServer — durable substrate reaches the resource read path", () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  it("re-mints an evicted locator when both stores are wired", async () => {
    fx = await boot({ withSubstrate: true });
    const resp = await fx.client.readResource({
      uri: `${RESOURCE_URI}/${SESSION_ID}/${CONTRACT_KEY}`,
    });
    expect(resp.contents).toHaveLength(1);

    // The read did not merely succeed — it put the render back. A
    // committed row is the difference between the substrate being
    // consulted and some other resolution answering.
    const committed = await fx.renderStore.get(SESSION_ID);
    expect(committed).not.toBeNull();
    expect(committed?.appId).toBe(BUILDER_APP_ID);
  });

  it("answers NOT_SUPPORTED for the same locator with no substrate wired", async () => {
    // Same fixture, same locator, one difference. This is the pin that
    // would catch a forwarding regression: the code is seeded from
    // whether the TEMPLATE sees a substrate, so a factory that drops
    // the options reports every deployment as substrate-less.
    fx = await boot({ withSubstrate: false });
    const err = await readFailure(fx);
    expect(err.data?.code).toBe("NOT_SUPPORTED");
    expect(err.code).toBe(-32006);
  });

  it("forwards the operator's retention to the row a re-mint commits", async () => {
    // `renderTtlMs` is one knob with two consumers now. Unforwarded,
    // the read path silently falls back to an hour while `ggui_render`
    // stamps the operator's window.
    fx = await boot({ withSubstrate: true });
    const before = Date.now();
    await fx.client.readResource({
      uri: `${RESOURCE_URI}/${SESSION_ID}/${CONTRACT_KEY}`,
    });
    const after = Date.now();
    const committed = await fx.renderStore.get(SESSION_ID);
    const render = committed?.render as { expiresAt?: number } | undefined;
    expect(render?.expiresAt).toBeGreaterThanOrEqual(before + OPERATOR_TTL_MS);
    expect(render?.expiresAt).toBeLessThanOrEqual(after + OPERATOR_TTL_MS);
  });
});

describe("createGguiServer — ggui_runtime_pull follows the render seam", () => {
  // `ggui_runtime_pull` is the terminal bridge-pull rung of the
  // live-channel failover ladder (WS → SSE → HTTP polling →
  // bridge-pull): a CSP-jailed MCP Apps iframe pulls the
  // GguiSessionEvent ledger over the host's tools/call postMessage
  // relay — the same ledger read the `GET /api/sessions/:id/events`
  // route serves. Its registration is gated on the SAME render seam
  // the resource read path above rides (`mcpApps` + a bound
  // renderStore), because without render there is no ledger to serve.
  //
  // The pin exists because a dropped registration is quiet by
  // construction: the handler package exports the factory, server.ts
  // compiles without calling it, and every other rung of the ladder
  // keeps working — the ONLY surface that goes dark is the one host
  // (claude.ai-style CSP jail) that has no network rung to fall back
  // to. tools/list is the observable seam, so that is what's pinned —
  // present when render is bound, absent when it is not.
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.close();
      fx = null;
    }
  });

  it("registers ggui_runtime_pull when render is bound", async () => {
    // Substrate stores are irrelevant to the pull tool — the gate is
    // `deps.render` alone, so the substrate-less boot is the cheaper
    // fixture that still binds render.
    fx = await boot({ withSubstrate: false });
    const { tools } = await fx.client.listTools();
    expect(tools.map((t) => t.name)).toContain("ggui_runtime_pull");
  });

  it("does NOT register ggui_runtime_pull when render is off", async () => {
    // Default boot: no `renderChannel`, no `mcpApps`, no renderStore ⇒
    // `defaultHandlers` receives no `render` deps. Advertising a pull
    // tool with no ledger behind it would be a tools/list lie.
    const server = createGguiServer({ logger: silentLogger });
    const httpServer = await server.listen(0, "127.0.0.1");
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("server.address() did not return AddressInfo");
    }
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${addr.port}/mcp`),
      { requestInit: { headers: { Authorization: "Bearer dev" } } },
    );
    const client = new Client({ name: "read-path-wiring-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain("ggui_runtime_pull");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
