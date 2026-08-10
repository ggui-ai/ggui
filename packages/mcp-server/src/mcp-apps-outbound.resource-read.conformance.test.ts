/**
 * Kit-vs-first-party contract test for the `resources/read` surface —
 * runs `@ggui-ai/protocol-conformance`'s resource-read catalog against
 * the shipping `registerGguiRenderResourceTemplate`.
 *
 * Implementation → kit, on purpose, exactly as
 * `./ggui-session-channel.conformance.test.ts` does for the WebSocket
 * catalog. The conformance kit is the protocol's arbiter, so the kit
 * never imports a server; a server proves itself against the kit. What
 * this file supplies is a scenario driver: given a declared deployment
 * shape and seed set, bring THIS server up that way and read a URI.
 *
 * Its sibling `./mcp-apps-outbound.typed-failures.test.ts` pins the same
 * surface from the inside, with detail strings, branch-by-branch. The
 * two are not redundant — that one proves this implementation behaves;
 * this one proves the OBLIGATION is expressible against any
 * implementation, which is what makes the kit able to arbitrate the
 * surface at all.
 *
 * The raw-frame capture is load-bearing. An MCP client reconstructs
 * errors into `McpError`, which rewrites `message` — and the catalog's
 * central obligation is that a refused read and a miss are the same
 * BYTES. Grading a reconstruction would pass a server whose wire frames
 * differ.
 */
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isJSONRPCErrorResponse } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import {
  InMemoryBlueprintIndex,
  InMemoryBlueprintStore,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryRenderIdentityStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from "@ggui-ai/mcp-server-core/in-memory";
import { registerBlueprint } from "@ggui-ai/mcp-server-handlers";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import {
  resourceReadCases,
  runResourceReadConformance,
  type PreparedResourceReadScenario,
  type ResourceReadOutcome,
  type ResourceReadRenderMeta,
  type ResourceReadScenario,
  type ResourceReadScenarioDriver,
} from "@ggui-ai/protocol-conformance/resource-read-conformance";
import type { Blueprint, ComponentGguiSession, DataContract } from "@ggui-ai/protocol";
import type { McpAppAiGguiRenderMeta } from "@ggui-ai/protocol/integrations/mcp-apps";
import { registerGguiRenderResourceTemplate } from "./mcp-apps-outbound.js";

const RENDER_META_KEY = "ai.ggui/render";
const OWNER_APP_ID = "app_owner";
const OTHER_APP_ID = "app_other";
const FALLBACK_APP_ID = "builder";
const BLUEPRINT_ID = "bp_00000000-0000-4000-8000-000000000002";
const COMPONENT_CODE = "export default function Restored(){return null;}";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const CONTRACT: DataContract = {
  propsSpec: { properties: { city: { schema: { type: "string" }, default: "nowhere" } } },
};

function contextFor(caller: ResourceReadScenario["caller"]): HandlerContext {
  return caller === "owner"
    ? { appId: OWNER_APP_ID, authSource: "apikey", apiKeyHash: "owner", requestId: "req-owner" }
    : { appId: OTHER_APP_ID, authSource: "apikey", apiKeyHash: "other", requestId: "req-other" };
}

function sha256Hex(code: string): string {
  return createHash("sha256").update(code, "utf-8").digest("hex");
}

/** The render meta the shell bootstraps with, narrowed to the kit's channel fields. */
function projectRenderMeta(html: string): ResourceReadRenderMeta {
  const match = /globalThis\.__GGUI_META__ = (.*?);<\/script>/s.exec(html);
  if (match === null) throw new Error("shell carries no bootstrap envelope");
  const envelope: unknown = JSON.parse(match[1] as string);
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("bootstrap envelope is not an object");
  }
  const slice = (envelope as Record<string, McpAppAiGguiRenderMeta | undefined>)[RENDER_META_KEY];
  if (slice === undefined) throw new Error(`envelope carries no ${RENDER_META_KEY} slice`);
  return {
    ...(slice.codeUrl !== undefined ? { codeUrl: slice.codeUrl } : {}),
    ...(slice.codeB64 !== undefined ? { codeB64: slice.codeB64 } : {}),
    ...(slice.wsUrl !== undefined ? { wsUrl: slice.wsUrl } : {}),
    ...(slice.wsToken !== undefined ? { wsToken: slice.wsToken } : {}),
    ...(slice.kind !== undefined ? { kind: slice.kind } : {}),
  };
}

/** A server brought up in a declared shape, plus the seams a test needs. */
interface BootedServer {
  readonly client: Client;
  readonly registeredKeys: Readonly<Record<string, string>>;
  read(uri: string): Promise<ResourceReadOutcome>;
  close(): Promise<void>;
}

/**
 * Bring this server up in the shape the catalog declares, apply the
 * seeds, and hand back a real MCP client/server pair.
 *
 * Returns the `Client` itself so a test can ask the server questions
 * the kit's driver seam does not carry — the advertised resource
 * templates, for one. Nothing is stashed in module state: a test that
 * wants to observe a run passes `onRead` and owns the recording, so no
 * assertion depends on another test having run first.
 */
async function boot(
  scenario: ResourceReadScenario,
  onRead?: (uri: string) => void,
): Promise<BootedServer> {
  const renderStore = new InMemoryGguiSessionStore();
  const identityStore = new InMemoryRenderIdentityStore({ durability: 'durable' });
  const blueprintStore = new InMemoryBlueprintStore({ durability: 'durable' });
  const durableCodeStore = new InMemoryCodeStore({ durability: 'durable' });
  const index = new InMemoryBlueprintIndex();
  const vectorStore = new InMemoryVectorStore();
  const server = new McpServer({ name: "resource-read-conformance", version: "0.0.1" });

  const substrate = scenario.server.durableSubstrate;
  registerGguiRenderResourceTemplate(server, {
    renderStore,
    runtimeUrl: "https://runtime.example/bundle.js",
    getContext: () => contextFor(scenario.caller),
    logger: silentLogger,
    ...(substrate === "all" || substrate === "identity-only"
      ? { renderIdentityStore: identityStore }
      : {}),
    ...(substrate === "all" || substrate === "blueprints-only"
      ? { durableBlueprints: { blueprintStore, codeStore: durableCodeStore } }
      : {}),
    ...(scenario.server.blueprintRegistry === true
      ? { vectorStore, index, defaultAppIdFallback: FALLBACK_APP_ID }
      : {}),
    ...(scenario.server.staticDelivery === true
      ? { codeStore: new InMemoryCodeStore({ durability: 'durable' }), codeBaseUrl: "https://code.example" }
      : {}),
    ...(scenario.server.liveChannel === true
      ? {
          mintWsToken: (sessionId: string, appId: string) => ({
            wsUrl: `wss://live.example/${appId}`,
            token: `ws-token-for-${sessionId}`,
            expiresAt: "2030-01-01T00:00:00.000Z",
          }),
        }
      : {}),
  });

  // Seeds always belong to the OWNER — that is what makes a read by any
  // other caller a read of something that really is there.
  const registeredKeys: Record<string, string> = {};
  let recordContractKey: string | null = null;
  for (const seed of scenario.seeds) {
    switch (seed.kind) {
      case "identity-record":
        recordContractKey = seed.key;
        await identityStore.put({
          sessionId: seed.session,
          appId: OWNER_APP_ID,
          blueprintId: seed.blueprint === "named" ? BLUEPRINT_ID : null,
          contractKey: seed.key,
          variantKey: "default",
          props: { city: "Lisbon" },
          seqAtLastCommit: 3,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_001_000,
        });
        break;
      case "durable-blueprint": {
        if (recordContractKey === null) {
          throw new Error(
            "a durable-blueprint seed describes the blueprint an identity-record names; no record was seeded first",
          );
        }
        const blueprint: Blueprint = {
          blueprintId: BLUEPRINT_ID,
          contractHash: recordContractKey,
          appId: OWNER_APP_ID,
          ...(seed.componentRef === "present" ? { codeHash: sha256Hex(COMPONENT_CODE) } : {}),
          source: { kind: "user" },
          variance: {},
          createdAt: "2026-08-01T00:00:00.000Z",
          createdBy: "agent",
          contract: CONTRACT,
        };
        await blueprintStore.put(blueprint);
        if (seed.body === "stored") {
          await durableCodeStore.put(sha256Hex(COMPONENT_CODE), COMPONENT_CODE);
        }
        break;
      }
      case "committed-render": {
        const render: ComponentGguiSession = {
          type: "component",
          id: seed.session,
          appId: OWNER_APP_ID,
          // Size class drives whether the inline `codeB64` channel
          // exists for this render: an over-cap body pads past the
          // projection's inline ceiling, so a channel-less server has
          // genuinely nothing to deliver.
          componentCode:
            seed.size === "over-inline-cap"
              ? `${COMPONENT_CODE}/*${"x".repeat(300_000)}*/`
              : COMPONENT_CODE,
          eventSequence: 0,
          createdAt: 1_700_000_000_000,
          lastActivityAt: 1_700_000_000_000,
          expiresAt: 1_900_000_000_000,
        };
        await renderStore.commit({ render, appId: OWNER_APP_ID });
        break;
      }
      case "uncommitted-render":
        await renderStore.create({ id: seed.session, appId: OWNER_APP_ID });
        break;
      case "registered-blueprint": {
        const registered = await registerBlueprint(
          { embedding: new MockEmbeddingProvider(), vectorStore, index },
          FALLBACK_APP_ID,
          {
            kind: "template",
            contract: {},
            intent: "registry fallback",
            componentCode: COMPONENT_CODE,
            source: { kind: "user" },
          },
        );
        registeredKeys[seed.as] = registered.contractKey;
        break;
      }
    }
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Installed BEFORE connect: `Protocol.connect` chains onto whatever
  // handler the transport already has, so this sees the untouched frames
  // rather than the client's reconstruction of them.
  const frames: JSONRPCMessage[] = [];
  clientTransport.onmessage = (message: JSONRPCMessage) => {
    frames.push(message);
  };
  const client = new Client({ name: "resource-read-conformance-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    registeredKeys,
    read: async (uri: string): Promise<ResourceReadOutcome> => {
      onRead?.(uri);
      const before = frames.length;
      try {
        const result = await client.readResource({ uri });
        // `contents` entries are text-or-blob; a shell is always text.
        const first = result.contents[0];
        if (first === undefined || !("text" in first) || typeof first.text !== "string") {
          throw new Error("resource response carries no shell text");
        }
        return { kind: "mount", renderMeta: projectRenderMeta(first.text) };
      } catch {
        // The RAW frame this read produced — not the client's McpError,
        // whose `message` is a reconstruction.
        const frame = frames.slice(before).find(isJSONRPCErrorResponse);
        if (frame === undefined) {
          throw new Error(`read of ${uri} failed without putting an error frame on the wire`);
        }
        return { kind: "error", error: frame.error };
      }
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * The kit's driver seam, over {@link boot}. `onRead` is threaded so the
 * caller — not module state — owns any recording of what a run read.
 */
function makePrepare(onRead?: (uri: string) => void): ResourceReadScenarioDriver {
  return async (scenario: ResourceReadScenario): Promise<PreparedResourceReadScenario> => {
    const booted = await boot(scenario, onRead);
    return {
      registeredKeys: booted.registeredKeys,
      read: booted.read,
      dispose: booted.close,
    };
  };
}

describe("first-party resources/read passes @ggui-ai/protocol-conformance", () => {
  it("passes every case in the resource-read catalog, with nothing skipped", async () => {
    const urisRead: string[] = [];
    const result = await runResourceReadConformance(makePrepare((uri) => urisRead.push(uri)));
    const diagnostic = JSON.stringify(
      { failed: result.failed, skipped: result.skipped },
      null,
      2,
    );

    expect(result.failed, diagnostic).toEqual([]);
    // The skip set is EXACT and EMPTY: this server can express every
    // scenario the catalog declares, so a skip appearing here is a
    // regression in the driver, not an honest gap. A skip set that can
    // grow unnoticed is a false gate.
    expect(result.skipped, diagnostic).toEqual([]);
    // And the pass set is the whole catalog — so a case silently
    // dropping out of the catalog fails this build too.
    expect([...result.passed].sort(), diagnostic).toEqual(
      resourceReadCases.map((c) => c.name).sort(),
    );

    // BOTH registered URI shapes were actually driven. The registration
    // under test registers two templates — the single-segment legacy
    // shape and the two-segment resume shape — and they take different
    // paths through the handler (only the two-segment one can reach the
    // blueprint-registry fallback). A catalog that happened to exercise
    // just one would grade half the surface while reading as if it
    // graded all of it.
    const prefix = "ui://ggui/render/";
    const wellFormed = urisRead
      .filter((uri) => uri.startsWith(prefix))
      .filter((uri) =>
        uri
          .slice(prefix.length)
          .split("/")
          .every((segment) => segment.length > 0),
      );
    const segmentCount = (uri: string): number => uri.slice(prefix.length).split("/").length;

    expect(wellFormed.length).toBeGreaterThan(0);
    expect(wellFormed.some((uri) => segmentCount(uri) === 1)).toBe(true);
    expect(wellFormed.some((uri) => segmentCount(uri) === 2)).toBe(true);

    // And the filter dropped exactly what it was meant to. Without this
    // the two assertions above hold for a filter that silently discarded
    // something else — proving the surviving list has both shapes says
    // nothing about what left it.
    const malformed = ["ui://ggui/render/", "ui://ggui/render//fedcba9876543210"];
    for (const uri of malformed) {
      expect(urisRead, `the run never read the malformed probe ${uri}`).toContain(uri);
      expect(wellFormed, `${uri} names no locator and must not count as one`).not.toContain(uri);
    }
    expect(wellFormed).toHaveLength(urisRead.length - malformed.length);
  }, 30_000);

  it("grades a non-empty catalog", () => {
    // A run of zero cases passes every assertion above while proving
    // nothing.
    expect(resourceReadCases.length).toBeGreaterThan(0);
  });

  it("drives the shipping registration, which really does register both templates", async () => {
    // The driver above calls `registerGguiRenderResourceTemplate`
    // directly — the shipping registration itself — rather than
    // standing up a synthetic reader that mimics its answers. Asked of
    // the server on this test's OWN client, so the claim rests on what
    // the registration advertises rather than on reading the import
    // line, and on nothing another test left behind.
    const booted = await boot({
      caseName: "template-registration-probe",
      server: { durableSubstrate: "all", liveChannel: true },
      caller: "owner",
      seeds: [],
    });
    try {
      const advertised = (await booted.client.listResourceTemplates()).resourceTemplates.map(
        (template) => template.uriTemplate,
      );
      expect(advertised).toContain("ui://ggui/render/{sessionId}");
      expect(advertised).toContain("ui://ggui/render/{sessionId}/{blueprintKey}");
    } finally {
      await booted.close();
    }
  });
});
