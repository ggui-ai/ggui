/**
 * The typed-failure contract for a render-locator `resources/read`
 * (#430 slice 3, task 3).
 *
 * The obligation this file pins: a read of
 * `ui://ggui/render/{sessionId}[/{blueprintKey}]` returns either a
 * result whose shell carries MOUNT MATERIAL, or exactly one typed
 * JSON-RPC error. There is no third outcome — in particular there is no
 * successful result carrying a shell that can never paint anything,
 * which is what the old "Generating UI…" loading shell was on every
 * failure branch.
 *
 * That makes the contract host-checkable, and the last describe block
 * checks it the way a host would: over a cross-product of server
 * wirings and locator states, EVERY read either rejects or hands back a
 * shell declaring a delivery channel. Enumerating success returns by
 * eye would not survive the next branch someone adds.
 *
 * The other half is the disclosure rule. A caller reading a locator it
 * may not see and a caller reading one that never existed must get
 * BYTE-IDENTICAL errors — pinned here against the raw JSON-RPC frames
 * the server put on the wire, not against the client's reconstruction
 * of them.
 *
 * Wire values (-32002, -32006, the four code names) are spelled out as
 * literals on purpose: production imports the constants, so a rename
 * that silently moved the wire would pass there and fail here.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError, isJSONRPCErrorResponse } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
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
import type { Blueprint, ComponentGguiSession, DataContract } from "@ggui-ai/protocol";
import type { McpAppAiGguiRenderMeta } from "@ggui-ai/protocol/integrations/mcp-apps";
import { createHash } from "node:crypto";
import { registerGguiRenderResourceTemplate } from "./mcp-apps-outbound.js";

const RESOURCE_URI = "ui://ggui/render";
const RENDER_META_KEY = "ai.ggui/render";

/** MCP's resource-not-found number. */
const SESSION_NOT_FOUND = -32002;
/** The canonical code the other three failure classes ride on. */
const MOUNT_UNAVAILABLE = -32006;

const OWNER_APP_ID = "app_owner";
const INTRUDER_APP_ID = "app_intruder";
const FALLBACK_APP_ID = "builder";
const BLUEPRINT_ID = "bp_00000000-0000-4000-8000-000000000002";
/** 16-char lowercase hex — the blueprintKey domain. */
const CONTRACT_KEY = "fedcba9876543210";
const DURABLE_CODE = "export default function Durable(){return null;}";
const LIVE_ROW_CODE = "export default function LiveRow(){return null;}";
/** Fixed id for the fault fixtures, which seed their own row at boot. */
const SEEDED_SESSION_ID = "11111111-2222-4333-8444-555555555555";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const ownerCtx: HandlerContext = {
  appId: OWNER_APP_ID,
  authSource: "apikey",
  apiKeyHash: "owner-hash",
  requestId: "req-owner",
};

const intruderCtx: HandlerContext = {
  appId: INTRUDER_APP_ID,
  authSource: "apikey",
  apiKeyHash: "intruder-hash",
  requestId: "req-intruder",
};

const CONTRACT: DataContract = {
  propsSpec: { properties: { city: { schema: { type: "string" }, default: "nowhere" } } },
};

function sha256Hex(code: string): string {
  return createHash("sha256").update(code, "utf-8").digest("hex");
}

/**
 * How much of the durable substrate a server binds. `identityOnly` and
 * `blueprintsOnly` are the half-wired shapes an operator reaches by
 * provisioning one store and forgetting the other; a re-mint needs all
 * three, so both are as substrate-less as binding nothing.
 */
type DurableWiring = true | "identityOnly" | "blueprintsOnly" | "allEphemeral";

interface BootOptions {
  /** Bind the durable substrate a re-mint needs (record + blueprint + body stores). */
  readonly durable?: DurableWiring;
  /** Bind the blueprint-registry fallback (and the deps that let it build a shell). */
  readonly registryFallback?: boolean;
  /** Bind the static-component delivery channel (`codeStore` + `codeBaseUrl`). */
  readonly staticDelivery?: boolean;
  /** Bind the live delivery channel (`mintWsToken`). */
  readonly liveChannel?: boolean;
  readonly getContext?: () => HandlerContext | undefined;
}

interface Fixture {
  readonly client: Client;
  readonly renderStore: InMemoryGguiSessionStore;
  readonly identityStore: InMemoryRenderIdentityStore;
  readonly blueprintStore: InMemoryBlueprintStore;
  readonly durableCodeStore: InMemoryCodeStore;
  readonly index: InMemoryBlueprintIndex;
  readonly vectorStore: InMemoryVectorStore;
  /** Every JSON-RPC frame the server sent this client, in order. */
  readonly frames: readonly JSONRPCMessage[];
  readonly close: () => Promise<void>;
}

async function boot(options: BootOptions = {}): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const identityStore = new InMemoryRenderIdentityStore({ durability: 'durable' });
  const blueprintStore = new InMemoryBlueprintStore({ durability: 'durable' });
  const durableCodeStore = new InMemoryCodeStore({ durability: 'durable' });
  const index = new InMemoryBlueprintIndex();
  const vectorStore = new InMemoryVectorStore();
  const server = new McpServer({ name: "typed-failures-test", version: "0.0.1" });

  registerGguiRenderResourceTemplate(server, {
    renderStore,
    runtimeUrl: "https://runtime.example/bundle.js",
    getContext: options.getContext ?? (() => ownerCtx),
    logger: silentLogger,
    ...(options.durable === true || options.durable === "identityOnly"
      ? { renderIdentityStore: identityStore }
      : {}),
    ...(options.durable === true || options.durable === "blueprintsOnly"
      ? { durableBlueprints: { blueprintStore, codeStore: durableCodeStore } }
      : {}),
    // #457 — every store BOUND, every store defaulting to its honest
    // 'ephemeral' declaration: binding is not durability.
    ...(options.durable === "allEphemeral"
      ? {
          renderIdentityStore: new InMemoryRenderIdentityStore(),
          durableBlueprints: {
            blueprintStore: new InMemoryBlueprintStore(),
            codeStore: new InMemoryCodeStore(),
          },
        }
      : {}),
    ...(options.registryFallback === true
      ? { vectorStore, index, defaultAppIdFallback: FALLBACK_APP_ID }
      : {}),
    ...(options.staticDelivery === true
      ? { codeStore: new InMemoryCodeStore({ durability: 'durable' }), codeBaseUrl: "https://code.example" }
      : {}),
    ...(options.liveChannel === true
      ? {
          mintWsToken: (sessionId: string, appId: string) => ({
            wsUrl: `wss://live.example/${appId}`,
            token: `ws-token-for-${sessionId}`,
            expiresAt: "2030-01-01T00:00:00.000Z",
          }),
        }
      : {}),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Installed BEFORE connect: `Protocol.connect` chains onto whatever
  // handler the transport already has, so this sees the untouched
  // frames rather than the client's reconstruction of them.
  const frames: JSONRPCMessage[] = [];
  clientTransport.onmessage = (message: JSONRPCMessage) => {
    frames.push(message);
  };
  const client = new Client({ name: "typed-failures-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    renderStore,
    identityStore,
    blueprintStore,
    durableCodeStore,
    index,
    vectorStore,
    frames,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The JSON-RPC error bodies the server put on the wire, in order. */
function wireErrors(frames: readonly JSONRPCMessage[]): readonly unknown[] {
  return frames.filter(isJSONRPCErrorResponse).map((frame) => frame.error);
}

interface ReadFailure {
  readonly code: number;
  readonly message: string;
  readonly data: unknown;
}

/**
 * Read a locator that must FAIL, and return the failure.
 *
 * A positive assertion rather than `expect(...).rejects.toThrow()`: a
 * bare throw-pin passes for any error at all, including the plain
 * `Error` an unconverted branch would raise, which is exactly the
 * regression this suite exists to catch.
 */
async function readFailure(client: Client, uri: string): Promise<ReadFailure> {
  try {
    await client.readResource({ uri });
  } catch (err) {
    if (err instanceof McpError) {
      return { code: err.code, message: err.message, data: err.data };
    }
    throw err;
  }
  throw new Error(`read of ${uri} returned a result; expected a typed failure`);
}

interface ShellContent {
  readonly uri: string;
  readonly text?: string;
}

function shellText(contents: readonly ShellContent[]): string {
  const text = contents[0]?.text;
  if (typeof text !== "string") {
    throw new Error("resource response carries no shell text");
  }
  return text;
}

function parseMeta(html: string): McpAppAiGguiRenderMeta {
  const match = /globalThis\.__GGUI_META__ = (.*?);<\/script>/s.exec(html);
  if (match === null) {
    throw new Error("shell carries no __GGUI_META__ bootstrap");
  }
  const envelope: unknown = JSON.parse(match[1] as string);
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("__GGUI_META__ is not an envelope");
  }
  const slice = (envelope as Record<string, McpAppAiGguiRenderMeta | undefined>)[
    RENDER_META_KEY
  ];
  if (slice === undefined) {
    throw new Error(`envelope carries no ${RENDER_META_KEY} slice`);
  }
  return slice;
}

/**
 * Does this shell carry enough to paint something? One of the three
 * delivery channels the runtime knows: a static component URL, a live
 * channel, or a server-emitted system card.
 */
function declaresDeliveryChannel(meta: McpAppAiGguiRenderMeta): boolean {
  if (typeof meta.codeUrl === "string" && meta.codeUrl.length > 0) return true;
  if (typeof meta.kind === "string" && meta.kind.length > 0) return true;
  return (
    typeof meta.wsUrl === "string" &&
    meta.wsUrl.length > 0 &&
    typeof meta.wsToken === "string" &&
    meta.wsToken.length > 0
  );
}

async function seedRecord(
  store: InMemoryRenderIdentityStore,
  sessionId: string,
  overrides: { readonly appId?: string; readonly blueprintId?: string | null } = {},
): Promise<void> {
  await store.put({
    sessionId,
    appId: overrides.appId ?? OWNER_APP_ID,
    blueprintId: overrides.blueprintId === undefined ? BLUEPRINT_ID : overrides.blueprintId,
    contractKey: CONTRACT_KEY,
    variantKey: "default",
    props: { city: "Lisbon" },
    seqAtLastCommit: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
  });
}

async function seedBlueprint(
  f: Pick<Fixture, "blueprintStore" | "durableCodeStore">,
  options: { readonly withCodeHash?: boolean; readonly withBody?: boolean } = {},
): Promise<void> {
  const blueprint: Blueprint = {
    blueprintId: BLUEPRINT_ID,
    contractHash: CONTRACT_KEY,
    appId: OWNER_APP_ID,
    ...(options.withCodeHash === false ? {} : { codeHash: sha256Hex(DURABLE_CODE) }),
    source: { kind: "user" },
    variance: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "agent",
    contract: CONTRACT,
  };
  await f.blueprintStore.put(blueprint);
  if (options.withBody !== false) {
    await f.durableCodeStore.put(sha256Hex(DURABLE_CODE), DURABLE_CODE);
  }
}

/** Commit a row that carries a renderable component. */
async function seedLiveRow(f: Fixture, sessionId: string): Promise<void> {
  const live: ComponentGguiSession = {
    type: "component",
    id: sessionId,
    appId: OWNER_APP_ID,
    componentCode: LIVE_ROW_CODE,
    eventSequence: 0,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    expiresAt: 1_900_000_000_000,
  };
  await f.renderStore.commit({ render: live, appId: OWNER_APP_ID });
}

/** Register a blueprint under the registry-fallback scope; returns its key. */
async function registerFallbackBlueprint(f: Fixture): Promise<string> {
  const registered = await registerBlueprint(
    { embedding: new MockEmbeddingProvider(), vectorStore: f.vectorStore, index: f.index },
    FALLBACK_APP_ID,
    {
      kind: "template",
      contract: {},
      intent: "registry fallback",
      componentCode: "export default function Fallback(){return null;}",
      source: { kind: "user" },
    },
  );
  return registered.contractKey;
}

describe("resource read — one typed failure per class", () => {
  it("answers a locator that never existed with NOT_FOUND on -32002", async () => {
    const f = await boot({ durable: true, liveChannel: true });
    try {
      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${randomUUID()}/${CONTRACT_KEY}`,
      );
      expect(failure.code).toBe(SESSION_NOT_FOUND);
      expect(failure.data).toEqual({ code: "NOT_FOUND" });
    } finally {
      await f.close();
    }
  });

  it("answers a record whose blueprint row is gone with BLUEPRINT_UNRESOLVABLE on -32006", async () => {
    const f = await boot({ durable: true, liveChannel: true });
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId);
      // The body is stored; only the blueprint row the record names is
      // missing, so nothing else can explain the classification.
      await f.durableCodeStore.put(sha256Hex(DURABLE_CODE), DURABLE_CODE);

      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      );
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "BLUEPRINT_UNRESOLVABLE",
        detail: "the blueprint the record names is gone",
      });
    } finally {
      await f.close();
    }
  });

  it("answers a server that keeps no durable record with NOT_SUPPORTED on -32006", async () => {
    const f = await boot({ liveChannel: true });
    try {
      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${randomUUID()}/${CONTRACT_KEY}`,
      );
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({ code: "NOT_SUPPORTED" });
    } finally {
      await f.close();
    }
  });

  it("answers a resolvable render with no delivery channel with NOT_MOUNTABLE on -32006", async () => {
    // Row present and renderable, but the server wires NEITHER static
    // delivery NOR a live channel — the mount-mode gate.
    const f = await boot({ durable: true });
    try {
      const sessionId = randomUUID();
      await seedLiveRow(f, sessionId);

      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      );
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "NOT_MOUNTABLE",
        detail: "no static component URL and no live channel is wired",
      });
    } finally {
      await f.close();
    }
  });
});

describe("resource read — the whole error frame, not just its code", () => {
  // `data` is what a host branches on and is asserted throughout this
  // file. `message` is what a PERSON reads, and until these two pins it
  // travelled to the wire unasserted — the projection could have
  // swapped, truncated, or templated it and every other test here would
  // still have passed.

  it("puts the constant NOT_FOUND body on the wire, verbatim", async () => {
    const f = await boot({ durable: true, liveChannel: true });
    try {
      await readFailure(f.client, `${RESOURCE_URI}/${randomUUID()}/${CONTRACT_KEY}`);
      expect(wireErrors(f.frames)).toEqual([
        {
          code: SESSION_NOT_FOUND,
          message: "Resource not found.",
          data: { code: "NOT_FOUND" },
        },
      ]);
    } finally {
      await f.close();
    }
  });

  it("puts the full NOT_MOUNTABLE body on the wire, message included", async () => {
    const f = await boot({ durable: true });
    try {
      const sessionId = randomUUID();
      await seedLiveRow(f, sessionId);

      await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(wireErrors(f.frames)).toEqual([
        {
          code: MOUNT_UNAVAILABLE,
          message: "This locator resolved, but nothing mountable can be produced for it.",
          data: {
            code: "NOT_MOUNTABLE",
            detail: "no static component URL and no live channel is wired",
          },
        },
      ]);
    } finally {
      await f.close();
    }
  });
});

describe("resource read — BLUEPRINT_UNRESOLVABLE names which step failed", () => {
  it("distinguishes a record that names no blueprint at all", async () => {
    const f = await boot({ durable: true, liveChannel: true });
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId, { blueprintId: null });
      await seedBlueprint(f);

      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      );
      expect(failure.data).toEqual({
        code: "BLUEPRINT_UNRESOLVABLE",
        detail: "the record names no blueprint",
      });
    } finally {
      await f.close();
    }
  });

  it("distinguishes a blueprint that stores no component reference", async () => {
    const f = await boot({ durable: true, liveChannel: true });
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId);
      await seedBlueprint(f, { withCodeHash: false });

      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      );
      expect(failure.data).toEqual({
        code: "BLUEPRINT_UNRESOLVABLE",
        detail: "the blueprint stores no component reference",
      });
    } finally {
      await f.close();
    }
  });

  it("distinguishes a component body that is gone from behind its hash", async () => {
    const f = await boot({ durable: true, liveChannel: true });
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId);
      await seedBlueprint(f, { withBody: false });

      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      );
      expect(failure.data).toEqual({
        code: "BLUEPRINT_UNRESOLVABLE",
        detail: "the component body behind the blueprint is gone",
      });
    } finally {
      await f.close();
    }
  });
});

describe("resource read — a refused read is byte-identical to a miss", () => {
  it("puts the identical JSON-RPC error on the wire for a resolvable locator and one that never existed", async () => {
    const f = await boot({ durable: true, liveChannel: true, getContext: () => intruderCtx });
    try {
      const resolvableSessionId = randomUUID();
      await seedRecord(f.identityStore, resolvableSessionId);
      await seedBlueprint(f);
      const neverExisted = randomUUID();

      const refused = await readFailure(
        f.client,
        `${RESOURCE_URI}/${resolvableSessionId}/${CONTRACT_KEY}`,
      );
      const missing = await readFailure(f.client, `${RESOURCE_URI}/${neverExisted}/${CONTRACT_KEY}`);

      // Both are NOT_FOUND despite one of them being fully resolvable
      // for its rightful owner.
      expect(refused.code).toBe(SESSION_NOT_FOUND);
      expect(refused.data).toEqual({ code: "NOT_FOUND" });

      // Compared on the RAW frames, so nothing the client normalizes
      // away can hide a difference. The sessionId is caller-supplied
      // and echoed nowhere, so no normalization is needed at all.
      const errors = wireErrors(f.frames);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toEqual(errors[1]);
      // And the two reads really were of different locators.
      expect(refused.message).toBe(missing.message);
      expect(resolvableSessionId).not.toBe(neverExisted);
    } finally {
      await f.close();
    }
  });

  it("names nothing about the render it refused", async () => {
    const f = await boot({ durable: true, liveChannel: true, getContext: () => intruderCtx });
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId);
      await seedBlueprint(f);

      await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);

      const serialized = JSON.stringify(wireErrors(f.frames));
      expect(serialized).not.toContain(OWNER_APP_ID);
      expect(serialized).not.toContain(sessionId);
      expect(serialized).not.toContain(BLUEPRINT_ID);
      // `detail` is where a refusal diagnostic would have leaked.
      expect(serialized).not.toContain("detail");
    } finally {
      await f.close();
    }
  });

  it("stays identical on a server that keeps no durable record", async () => {
    // NOT_SUPPORTED is a property of the SERVER, so it has to answer
    // for a refused row too — otherwise a substrate-less deployment
    // would report NOT_FOUND for rows that exist and NOT_SUPPORTED for
    // ones that never did, which is the oracle by another route.
    const f = await boot({ liveChannel: true, getContext: () => intruderCtx });
    try {
      const refusedSessionId = (await f.renderStore.create({ appId: OWNER_APP_ID })).id;
      const neverExisted = randomUUID();

      const refused = await readFailure(f.client, `${RESOURCE_URI}/${refusedSessionId}`);
      expect(refused.data).toEqual({ code: "NOT_SUPPORTED" });

      await readFailure(f.client, `${RESOURCE_URI}/${neverExisted}`);
      const errors = wireErrors(f.frames);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toEqual(errors[1]);
    } finally {
      await f.close();
    }
  });

  it("fuses on a substrate-less server whose registry fallback matches nothing", async () => {
    // The registry fallback fires for a refused read and a miss alike,
    // so wiring it must not open a gap between them: with no blueprint
    // under the key, both fall past it to the same terminal failure.
    const f = await boot({
      liveChannel: true,
      registryFallback: true,
      getContext: () => intruderCtx,
    });
    try {
      const refusedSessionId = (await f.renderStore.create({ appId: OWNER_APP_ID })).id;
      const neverExisted = randomUUID();
      const unregisteredKey = "0000000000000000";

      const refused = await readFailure(
        f.client,
        `${RESOURCE_URI}/${refusedSessionId}/${unregisteredKey}`,
      );
      expect(refused.data).toEqual({ code: "NOT_SUPPORTED" });

      await readFailure(f.client, `${RESOURCE_URI}/${neverExisted}/${unregisteredKey}`);
      const errors = wireErrors(f.frames);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toEqual(errors[1]);
    } finally {
      await f.close();
    }
  });

  it("fuses on NOT_MOUNTABLE when the registry matches but cannot deliver", async () => {
    // The one place a substrate-less server answers something other
    // than NOT_SUPPORTED for a read that mounts nothing: a blueprint
    // DID match the caller's key, so what the read found is a component
    // it cannot deliver. Still row-independent, so still fused.
    const f = await boot({
      liveChannel: true,
      registryFallback: true,
      getContext: () => intruderCtx,
    });
    try {
      const key = await registerFallbackBlueprint(f);
      const refusedSessionId = (await f.renderStore.create({ appId: OWNER_APP_ID })).id;
      const neverExisted = randomUUID();

      const refused = await readFailure(
        f.client,
        `${RESOURCE_URI}/${refusedSessionId}/${key}`,
      );
      expect(refused.data).toEqual({
        code: "NOT_MOUNTABLE",
        detail: "the matched blueprint has no delivery channel",
      });

      await readFailure(f.client, `${RESOURCE_URI}/${neverExisted}/${key}`);
      const errors = wireErrors(f.frames);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toEqual(errors[1]);
    } finally {
      await f.close();
    }
  });

  // #457 — "allEphemeral" joins the parametrization: every store BOUND
  // but declaring ephemeral is as substrate-less as half-wired; a gate
  // deriving the split from binding alone turns this arm red.
  for (const wiring of ["identityOnly", "blueprintsOnly", "allEphemeral"] as const) {
    it(`stays identical on a server whose substrate cannot restore (${wiring})`, async () => {
      // The half-wired shapes are where this is easiest to get wrong.
      // A re-mint needs all three stores, so a server holding one of
      // them can restore nothing — but the re-mint is only CONSULTED
      // when the row is absent, so a terminal failure derived from a
      // partial check would answer NOT_FOUND for a row that exists and
      // NOT_SUPPORTED for one that never did. That difference is the
      // existence oracle, rebuilt out of a wiring mistake.
      const f = await boot({
        durable: wiring,
        liveChannel: true,
        getContext: () => intruderCtx,
      });
      try {
        const refusedSessionId = (await f.renderStore.create({ appId: OWNER_APP_ID })).id;
        const neverExisted = randomUUID();

        const refused = await readFailure(f.client, `${RESOURCE_URI}/${refusedSessionId}`);
        expect(refused.data).toEqual({ code: "NOT_SUPPORTED" });

        await readFailure(f.client, `${RESOURCE_URI}/${neverExisted}`);
        const errors = wireErrors(f.frames);
        expect(errors).toHaveLength(2);
        expect(errors[0]).toEqual(errors[1]);
      } finally {
        await f.close();
      }
    });
  }
});

describe("resource read — a row the caller owns but cannot mount", () => {
  it("reports a row whose generation has not committed a component as NOT_MOUNTABLE", async () => {
    const f = await boot({ durable: true, liveChannel: true });
    try {
      const sessionId = randomUUID();
      await f.renderStore.create({ id: sessionId, appId: OWNER_APP_ID });

      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      );
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "NOT_MOUNTABLE",
        detail: "the render has not committed a component yet",
      });
    } finally {
      await f.close();
    }
  });

  it("reports it as NOT_MOUNTABLE even on a server that keeps no durable record", async () => {
    // The boundary of the deployment-global NOT_SUPPORTED rule. "This
    // server cannot rehydrate" is true here, but it is not the useful
    // truth for the row's own owner — the row is right there, it just
    // has no component yet. Only the owner can reach this branch, so
    // being specific costs no disclosure.
    const f = await boot({ liveChannel: true });
    try {
      const sessionId = randomUUID();
      await f.renderStore.create({ id: sessionId, appId: OWNER_APP_ID });

      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      );
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "NOT_MOUNTABLE",
        detail: "the render has not committed a component yet",
      });
    } finally {
      await f.close();
    }
  });

  it("reports a matched blueprint the server cannot deliver as NOT_MOUNTABLE", async () => {
    // The registry fallback resolves a blueprint but `buildShellFromBlueprint`
    // needs the static-delivery pair to turn it into a shell.
    const f = await boot({ registryFallback: true, liveChannel: true });
    try {
      const key = await registerFallbackBlueprint(f);

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${randomUUID()}/${key}`);
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "NOT_MOUNTABLE",
        detail: "the matched blueprint has no delivery channel",
      });
    } finally {
      await f.close();
    }
  });

  it("leaves a URI that names no locator to the transport, outside the four codes", async () => {
    // `ui://ggui/render/` and `ui://ggui/render//key` match NEITHER
    // registered template, so the SDK refuses them before the handler
    // runs and answers `-32602` (invalid params). That is correct — a
    // URI that names no render locator is not a read of one, and the
    // four codes classify reads that ARE.
    //
    // Pinned because it bounds the obligation: a conformance probe of a
    // malformed URI must expect the transport's error, not `NOT_FOUND`.
    // It is also why the handler's own empty-sessionId guard is
    // unreachable in practice — nothing can call it with one.
    const f = await boot({ durable: true, liveChannel: true });
    try {
      for (const uri of [`${RESOURCE_URI}/`, `${RESOURCE_URI}//${CONTRACT_KEY}`]) {
        const failure = await readFailure(f.client, uri);
        expect(failure.code).toBe(-32602);
        expect([SESSION_NOT_FOUND, MOUNT_UNAVAILABLE]).not.toContain(failure.code);
      }
    } finally {
      await f.close();
    }
  });

  it("keeps the mount-mode gate ahead of the shell builder's own invariant", async () => {
    // `buildSelfContainedShell` throws a plain Error when handed a
    // render with no channel at all. The gate must intercept first, or
    // that would surface as an untyped -32603 announcing a malfunction
    // where the server is behaving correctly.
    const f = await boot({ durable: true });
    try {
      const sessionId = randomUUID();
      await seedLiveRow(f, sessionId);

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}`);
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.message).not.toContain("buildSelfContainedShell");
    } finally {
      await f.close();
    }
  });
});

describe("resource read — a faulting channel is a malfunction, not a verdict", () => {
  /**
   * The distinction these two pin: a channel that is NOT WIRED is a
   * deterministic property of the deployment, and `NOT_MOUNTABLE`
   * (-32006) tells the host a retry cannot succeed. A channel that is
   * wired and FAULTED is the one thing that is not deterministic. If
   * the fault were swallowed the gate would see an absent channel and
   * report the deterministic verdict, telling a host to give up on a
   * render that would mount fine a second later.
   */
  const INTERNAL_ERROR = -32603;

  /**
   * Boot a server whose channels are wired but one of which is broken.
   * `channels` says which are bound at all; `fault` says which of them
   * throws when used. The pair is the whole point: "wired and faulted"
   * and "never wired" have to stay distinguishable, and on a server
   * wiring BOTH channels a fault on one must cost the read nothing.
   */
  async function bootWithFault(options: {
    readonly channels: "both" | "staticOnly" | "liveOnly";
    readonly fault: "codeStore" | "mintWsToken";
  }): Promise<{ readonly client: Client; readonly close: () => Promise<void> }> {
    const renderStore = new InMemoryGguiSessionStore();
    const server = new McpServer({ name: "fault-test", version: "0.0.1" });
    const codeStore = new InMemoryCodeStore({ durability: 'durable' });
    if (options.fault === "codeStore") {
      codeStore.put = async (): Promise<void> => {
        throw new Error("code store unavailable");
      };
    }
    const wantsStatic = options.channels !== "liveOnly";
    const wantsLive = options.channels !== "staticOnly";
    registerGguiRenderResourceTemplate(server, {
      renderStore,
      runtimeUrl: "https://runtime.example/bundle.js",
      getContext: () => ownerCtx,
      logger: silentLogger,
      ...(wantsStatic ? { codeStore, codeBaseUrl: "https://code.example" } : {}),
      ...(wantsLive
        ? {
            mintWsToken: (sessionId: string, appId: string) => {
              if (options.fault === "mintWsToken") throw new Error("token signer unavailable");
              return {
                wsUrl: `wss://live.example/${appId}`,
                token: `ws-token-for-${sessionId}`,
                expiresAt: "2030-01-01T00:00:00.000Z",
              };
            },
          }
        : {}),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fault-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const sessionId = SEEDED_SESSION_ID;
    const live: ComponentGguiSession = {
      type: "component",
      id: sessionId,
      appId: OWNER_APP_ID,
      componentCode: LIVE_ROW_CODE,
      eventSequence: 0,
      createdAt: 1_700_000_000_000,
      lastActivityAt: 1_700_000_000_000,
      expiresAt: 1_900_000_000_000,
    };
    await renderStore.commit({ render: live, appId: OWNER_APP_ID });
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it("mounts through the live channel when the code store faults", async () => {
    // Both channels wired. The static one broke; the live one did not,
    // so the read has a delivery path and must use it. Failing here
    // would throw away a working channel over a fault that cost the
    // render nothing.
    const f = await bootWithFault({ channels: "both", fault: "codeStore" });
    try {
      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${SEEDED_SESSION_ID}/${CONTRACT_KEY}`,
      });
      const meta = parseMeta(shellText(read.contents));
      expect(meta.wsToken).toBe(`ws-token-for-${SEEDED_SESSION_ID}`);
      // And it really did lose the static channel, so the degrade is
      // the thing being asserted, not a happy path in disguise.
      expect(meta.codeUrl).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("mounts through the static channel when the live-channel mint faults", async () => {
    const f = await bootWithFault({ channels: "both", fault: "mintWsToken" });
    try {
      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${SEEDED_SESSION_ID}/${CONTRACT_KEY}`,
      });
      const meta = parseMeta(shellText(read.contents));
      expect(meta.codeUrl).toContain("/code/");
      expect(meta.wsToken).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("surfaces a code-store fault as an internal error when it is the only channel", async () => {
    // The other half of the pair above. Nothing survived, so the fault
    // IS the outcome — and it must not be dressed up as the
    // deterministic "no channel is wired" verdict.
    const f = await bootWithFault({ channels: "staticOnly", fault: "codeStore" });
    try {
      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${SEEDED_SESSION_ID}/${CONTRACT_KEY}`,
      );
      expect(failure.code).toBe(INTERNAL_ERROR);
      expect(failure.data).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("surfaces a live-mint fault as an internal error when it is the only channel", async () => {
    const f = await bootWithFault({ channels: "liveOnly", fault: "mintWsToken" });
    try {
      const failure = await readFailure(
        f.client,
        `${RESOURCE_URI}/${SEEDED_SESSION_ID}/${CONTRACT_KEY}`,
      );
      expect(failure.code).toBe(INTERNAL_ERROR);
      expect(failure.data).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

describe("resource read — NOT_SUPPORTED is exactly the substrate-less answer", () => {
  it("never appears on a server that wires the durable substrate", async () => {
    // The converse of the fusion rule. NOT_SUPPORTED describes a server
    // that cannot rehydrate; a server that CAN must never reach for it,
    // or the code stops meaning anything a host can route on.
    const states: ReadonlyArray<{
      readonly name: string;
      readonly options: BootOptions;
      readonly setup: (f: Fixture, sessionId: string) => Promise<string>;
    }> = [
      {
        name: "locator that never existed",
        options: { durable: true, liveChannel: true },
        setup: async (_f, sessionId) => `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      },
      {
        name: "row the caller may not read",
        options: { durable: true, liveChannel: true, getContext: () => intruderCtx },
        setup: async (f, sessionId) => {
          await seedLiveRow(f, sessionId);
          return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
        },
      },
      {
        name: "row whose generation has not committed",
        options: { durable: true, liveChannel: true },
        setup: async (f, sessionId) => {
          await f.renderStore.create({ id: sessionId, appId: OWNER_APP_ID });
          return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
        },
      },
      {
        name: "record whose blueprint is gone",
        options: { durable: true, liveChannel: true },
        setup: async (f, sessionId) => {
          await seedRecord(f.identityStore, sessionId);
          return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
        },
      },
      {
        name: "render with no delivery channel",
        options: { durable: true },
        setup: async (f, sessionId) => {
          await seedLiveRow(f, sessionId);
          return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
        },
      },
    ];

    const seen: string[] = [];
    for (const state of states) {
      const f = await boot(state.options);
      try {
        const uri = await state.setup(f, randomUUID());
        const failure = await readFailure(f.client, uri);
        expect(failure.data).not.toEqual(
          expect.objectContaining({ code: "NOT_SUPPORTED" }),
        );
        seen.push(state.name);
      } finally {
        await f.close();
      }
    }
    // Non-vacuity: every state really did produce a failure to inspect.
    expect(seen).toEqual(states.map((s) => s.name));
  });
});

describe("resource read — every result carries mount material", () => {
  /**
   * The cross-product a host would probe. Each case names a server
   * wiring and a locator state; the assertion is the same for all of
   * them and is the contract itself: a read either fails typed, or
   * returns a shell that declares a delivery channel.
   */
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly options: BootOptions;
    readonly setup: (f: Fixture, sessionId: string) => Promise<string>;
  }> = [
    {
      name: "live row on a live-channel server",
      options: { durable: true, liveChannel: true },
      setup: async (f, sessionId) => {
        await seedLiveRow(f, sessionId);
        return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
      },
    },
    {
      name: "live row on a static-delivery server",
      options: { durable: true, staticDelivery: true },
      setup: async (f, sessionId) => {
        await seedLiveRow(f, sessionId);
        return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
      },
    },
    {
      name: "evicted row with a durable record",
      options: { durable: true, liveChannel: true },
      setup: async (f, sessionId) => {
        await seedRecord(f.identityStore, sessionId);
        await seedBlueprint(f);
        return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
      },
    },
    {
      name: "evicted row resolved by the blueprint registry",
      options: { registryFallback: true, staticDelivery: true },
      setup: async (f, sessionId) => {
        const key = await registerFallbackBlueprint(f);
        return `${RESOURCE_URI}/${sessionId}/${key}`;
      },
    },
    {
      name: "evicted row with nothing to resolve it",
      options: { durable: true, liveChannel: true },
      setup: async (_f, sessionId) => `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
    },
    {
      name: "row whose generation has not committed",
      options: { durable: true, liveChannel: true },
      setup: async (f, sessionId) => {
        await f.renderStore.create({ id: sessionId, appId: OWNER_APP_ID });
        return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
      },
    },
    {
      name: "row the caller may not read",
      options: { durable: true, liveChannel: true, getContext: () => intruderCtx },
      setup: async (f, sessionId) => {
        await seedLiveRow(f, sessionId);
        return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
      },
    },
    {
      name: "server with no delivery channel at all",
      options: { durable: true },
      setup: async (f, sessionId) => {
        await seedLiveRow(f, sessionId);
        return `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`;
      },
    },
    {
      name: "server with no durable substrate",
      options: { liveChannel: true },
      setup: async (_f, sessionId) => `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
    },
    {
      name: "legacy single-segment locator",
      options: { durable: true, liveChannel: true },
      setup: async (f, sessionId) => {
        await seedRecord(f.identityStore, sessionId);
        await seedBlueprint(f);
        return `${RESOURCE_URI}/${sessionId}`;
      },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: mounts or fails typed, never a dead shell`, async () => {
      const f = await boot(testCase.options);
      try {
        const sessionId = randomUUID();
        const uri = await testCase.setup(f, sessionId);

        let contents: readonly ShellContent[] | undefined;
        try {
          contents = (await f.client.readResource({ uri })).contents;
        } catch (err) {
          // The failure arm: it must be one of the four typed classes.
          // Rethrowing anything else is what makes a plain `Error` from
          // an unconverted branch fail here rather than read as a pass.
          if (!(err instanceof McpError)) throw err;
          expect([SESSION_NOT_FOUND, MOUNT_UNAVAILABLE]).toContain(err.code);
          expect(err.data).toMatchObject({
            code: expect.stringMatching(
              /^(NOT_FOUND|BLUEPRINT_UNRESOLVABLE|NOT_SUPPORTED|NOT_MOUNTABLE)$/,
            ),
          });
        }

        if (contents !== undefined) {
          // The success arm: mount material, always.
          expect(declaresDeliveryChannel(parseMeta(shellText(contents)))).toBe(true);
        }
      } finally {
        await f.close();
      }
    });
  }

  it("covers both arms across the matrix, so neither assertion is vacuous", async () => {
    // A matrix where every case took the same arm would pass the loop
    // above while proving only half of it.
    let mounted = 0;
    let failed = 0;
    for (const testCase of cases) {
      const f = await boot(testCase.options);
      try {
        const uri = await testCase.setup(f, randomUUID());
        try {
          await f.client.readResource({ uri });
          mounted += 1;
        } catch {
          failed += 1;
        }
      } finally {
        await f.close();
      }
    }
    expect(mounted).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(0);
    expect(mounted + failed).toBe(cases.length);
  });
});
