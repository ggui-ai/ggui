/**
 * Re-mint path — an EVICTED `ui://ggui/render/{sessionId}/{blueprintKey}`
 * locator rehydrates into a LIVE mount (#430 slice 3, task 2).
 *
 * The oracle this file exists for: with the render row gone, a read of
 * the locator must still return a mountable shell carrying the
 * ORIGINAL props (never the contract's authoring-time defaults), the
 * SAME sessionId, and a freshly minted live-channel token — and the
 * component body must land back on a committed row, so every
 * subsequent read is an ordinary happy-path read.
 *
 * Ordering is the security half. Nothing that can produce a
 * locator-specific outcome may run before the access check: the record
 * lookup is gated against the RECORD's own owner, and blueprint / body
 * resolution happens only after that check passes. A caller who is not
 * entitled to a locator must not be able to tell a resolvable one from
 * one that never existed — pinned here as a byte-identity assertion,
 * the same method `mcp-apps-outbound.render-read-gate.test.ts` uses for
 * the row path.
 *
 * Deployments that bind neither store keep today's behavior exactly;
 * that too is pinned, because "the new path is skipped" is the
 * property every existing deployment depends on.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryBlueprintIndex,
  InMemoryBlueprintStore,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryRenderIdentityStore,
  InMemoryVectorStore,
} from "@ggui-ai/mcp-server-core/in-memory";
import type { RenderIdentityRecord } from "@ggui-ai/mcp-server-core";
import type { Blueprint, ComponentGguiSession, DataContract } from "@ggui-ai/protocol";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import { registerGguiRenderResourceTemplate } from "./mcp-apps-outbound.js";

// Wire values are pinned as literals on purpose (slice convention:
// production code imports the constant, tests spell it out, so a
// rename of the constant cannot silently move the wire).
const RESOURCE_URI = "ui://ggui/render";
const RENDER_META_KEY = "ai.ggui/render";
const BUILDER_APP_ID = "builder";

const RECORD_APP_ID = "app_owner";
const OTHER_APP_ID = "app_intruder";
const BLUEPRINT_ID = "bp_00000000-0000-4000-8000-000000000001";
/** 16-char lowercase hex — the blueprintKey domain, not a code hash. */
const CONTRACT_KEY = "0123456789abcdef";
const VARIANT_KEY = "default";
const DURABLE_CODE = "export default function ReMinted(){return null;}";
const LIVE_ROW_CODE = "export default function LiveRow(){return null;}";
/** The record's props — what a re-mint MUST restore. */
const RECORD_PROPS = { city: "Seoul", temperature: 15 } as const;
/** The contract's authoring-time default — what it MUST NOT fall back to. */
const CONTRACT_DEFAULT_CITY = "authoring-default-city";
const SEQ_AT_LAST_COMMIT = 7;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const ownerCtx: HandlerContext = {
  appId: RECORD_APP_ID,
  authSource: "apikey",
  apiKeyHash: "owner-hash",
  requestId: "req-owner",
};

const intruderCtx: HandlerContext = {
  appId: OTHER_APP_ID,
  authSource: "apikey",
  apiKeyHash: "intruder-hash",
  requestId: "req-intruder",
};

function sha256Hex(code: string): string {
  return createHash("sha256").update(code, "utf-8").digest("hex");
}

const CONTRACT: DataContract = {
  propsSpec: {
    properties: {
      city: { schema: { type: "string" }, default: CONTRACT_DEFAULT_CITY },
      temperature: { schema: { type: "number" }, default: -999 },
    },
  },
};

interface Fixture {
  readonly client: Client;
  readonly renderStore: InMemoryGguiSessionStore;
  readonly identityStore: InMemoryRenderIdentityStore;
  readonly blueprintStore: InMemoryBlueprintStore;
  readonly durableCodeStore: InMemoryCodeStore;
  readonly index: InMemoryBlueprintIndex;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly close: () => Promise<void>;
}

async function boot(
  options: {
    readonly getContext?: () => HandlerContext | undefined;
    /** Omit the identity store from the template options. */
    readonly withoutIdentityStore?: boolean;
    /** Omit the durable blueprint pair from the template options. */
    readonly withoutDurableBlueprints?: boolean;
    /** Wire the registry-only fallback deps alongside the re-mint deps. */
    readonly withRegistryFallback?: boolean;
  } = {},
): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const identityStore = new InMemoryRenderIdentityStore();
  const blueprintStore = new InMemoryBlueprintStore();
  const durableCodeStore = new InMemoryCodeStore();
  const index = new InMemoryBlueprintIndex();
  const warn = vi.fn();
  const server = new McpServer({ name: "remint-test", version: "0.0.1" });

  registerGguiRenderResourceTemplate(server, {
    renderStore,
    runtimeUrl: "https://runtime.example/bundle.js",
    getContext: options.getContext ?? (() => ownerCtx),
    logger: { ...silentLogger, warn },
    // Pod-shaped deployment: a live channel and no top-level codeStore,
    // so the mount is carried by the live trio and the body rides
    // inline on the committed row.
    mintWsToken: (sessionId: string, appId: string) => ({
      wsUrl: `wss://live.example/${appId}`,
      token: `ws-token-for-${sessionId}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
    ...(options.withoutIdentityStore ? {} : { renderIdentityStore: identityStore }),
    ...(options.withoutDurableBlueprints
      ? {}
      : { durableBlueprints: { blueprintStore, codeStore: durableCodeStore } }),
    ...(options.withRegistryFallback
      ? {
          vectorStore: new InMemoryVectorStore(),
          index,
          defaultAppIdFallback: BUILDER_APP_ID,
        }
      : {}),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "remint-test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    renderStore,
    identityStore,
    blueprintStore,
    durableCodeStore,
    index,
    warn,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function seedRecord(
  store: InMemoryRenderIdentityStore,
  sessionId: string,
  overrides: Partial<RenderIdentityRecord> = {},
): Promise<void> {
  await store.put({
    sessionId,
    appId: RECORD_APP_ID,
    blueprintId: BLUEPRINT_ID,
    contractKey: CONTRACT_KEY,
    variantKey: VARIANT_KEY,
    props: { ...RECORD_PROPS },
    seqAtLastCommit: SEQ_AT_LAST_COMMIT,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    ...overrides,
  });
}

/** Store the component body under its content hash. */
async function seedBody(f: Pick<Fixture, "durableCodeStore">): Promise<void> {
  await f.durableCodeStore.put(sha256Hex(DURABLE_CODE), DURABLE_CODE);
}

async function seedBlueprint(
  f: Pick<Fixture, "blueprintStore" | "durableCodeStore">,
  options: {
    readonly appId?: string;
    readonly withCodeHash?: boolean;
    readonly withBody?: boolean;
  } = {},
): Promise<void> {
  const blueprint: Blueprint = {
    blueprintId: BLUEPRINT_ID,
    contractHash: CONTRACT_KEY,
    appId: options.appId ?? RECORD_APP_ID,
    ...(options.withCodeHash === false ? {} : { codeHash: sha256Hex(DURABLE_CODE) }),
    source: { kind: "user" },
    variance: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "agent",
    contract: CONTRACT,
  };
  await f.blueprintStore.put(blueprint);
  if (options.withBody !== false) {
    await seedBody(f);
  }
}

/** Seed the fully re-mintable state: record + blueprint row + body. */
async function seedRemintable(f: Fixture, sessionId: string): Promise<void> {
  await seedRecord(f.identityStore, sessionId);
  await seedBlueprint(f);
}

function shellText(contents: readonly unknown[]): string {
  return (contents[0] as { text: string }).text;
}

/** Parse the shell's inline bootstrap slice. */
function parseMeta(html: string): Record<string, unknown> {
  const match = /globalThis\.__GGUI_META__ = (.*?);<\/script>/s.exec(html);
  if (match === null) {
    throw new Error("shell carries no __GGUI_META__ bootstrap");
  }
  const envelope = JSON.parse(match[1] as string) as Record<string, unknown>;
  return envelope[RENDER_META_KEY] as Record<string, unknown>;
}

function isLoadingShell(html: string): boolean {
  return html.includes('data-ggui-shell="loading"');
}

/** Strip the caller-supplied sessionId before byte-comparing two reads. */
function normalize(contents: unknown, sessionId: string): unknown {
  return JSON.parse(JSON.stringify(contents).split(sessionId).join("<SID>"));
}

describe("resource read — re-mint from the durable record", () => {
  it("re-mints an evicted locator into a live mount carrying the original props", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);
      // The row is genuinely absent — this is the evicted state.
      expect(await f.renderStore.get(sessionId)).toBeNull();

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      const html = shellText(read.contents);
      expect(isLoadingShell(html)).toBe(false);

      const meta = parseMeta(html);
      // Same locator identity.
      expect(meta["sessionId"]).toBe(sessionId);
      expect(meta["appId"]).toBe(RECORD_APP_ID);
      // A LIVE mount: freshly minted live-channel trio.
      expect(meta["wsToken"]).toBe(`ws-token-for-${sessionId}`);
      expect(meta["wsUrl"]).toBe(`wss://live.example/${RECORD_APP_ID}`);
      // The record's props, NOT the contract's authoring defaults.
      expect(JSON.parse(meta["propsJson"] as string)).toEqual(RECORD_PROPS);
      expect(html).not.toContain(CONTRACT_DEFAULT_CITY);
    } finally {
      await f.close();
    }
  });

  it("commits a fresh row with the durable body inlined, so the next read is an ordinary row read", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);

      await f.client.readResource({ uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}` });

      const committed = await f.renderStore.get(sessionId);
      expect(committed).not.toBeNull();
      expect(committed?.appId).toBe(RECORD_APP_ID);
      const render = committed?.render as ComponentGguiSession;
      expect(render.componentCode).toBe(DURABLE_CODE);
      expect(render.props).toEqual(RECORD_PROPS);

      // Second read now takes the ordinary happy path and still mounts.
      const second = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(second.contents))).toBe(false);
      expect(parseMeta(shellText(second.contents))["wsToken"]).toBe(
        `ws-token-for-${sessionId}`,
      );
    } finally {
      await f.close();
    }
  });

  it("resumes the event sequence from the record's high-water mark", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(parseMeta(shellText(read.contents))["lastSequence"]).toBe(
        SEQ_AT_LAST_COMMIT,
      );
    } finally {
      await f.close();
    }
  });

  it("carries the contract's specs onto the re-minted row", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);

      await f.client.readResource({ uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}` });

      const render = (await f.renderStore.get(sessionId))?.render as ComponentGguiSession;
      expect(render.propsSpec).toEqual(CONTRACT.propsSpec);
    } finally {
      await f.close();
    }
  });

  it("re-mints a legacy single-segment locator too", async () => {
    // The record is keyed by sessionId alone, so the URI shape that
    // predates the resume contract — and carries no blueprintKey —
    // re-mints exactly as the two-segment one does. Those are the
    // oldest locators in circulation and the likeliest to have lost
    // their row.
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);

      const read = await f.client.readResource({ uri: `${RESOURCE_URI}/${sessionId}` });
      const html = shellText(read.contents);
      expect(isLoadingShell(html)).toBe(false);
      expect(JSON.parse(parseMeta(html)["propsJson"] as string)).toEqual(RECORD_PROPS);
    } finally {
      await f.close();
    }
  });

  it("re-mints for an anonymous builder caller with no request context", async () => {
    const f = await boot({ getContext: () => undefined });
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId, { appId: BUILDER_APP_ID });
      await seedBlueprint(f, { appId: BUILDER_APP_ID });

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      const html = shellText(read.contents);
      expect(isLoadingShell(html)).toBe(false);
      expect(parseMeta(html)["appId"]).toBe(BUILDER_APP_ID);
      expect(JSON.parse(parseMeta(html)["propsJson"] as string)).toEqual(RECORD_PROPS);
    } finally {
      await f.close();
    }
  });
});

describe("resource read — re-mint refusals leave no trace", () => {
  it("does not re-mint when the record carries no blueprintId", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId, { blueprintId: null });
      await seedBlueprint(f);

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      expect(await f.renderStore.get(sessionId)).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("does not re-mint when the blueprint row is gone", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId);
      // The body is still stored — ONLY the row the record names is
      // gone, so nothing but the missing row can explain the refusal.
      await seedBody(f);

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      expect(await f.renderStore.get(sessionId)).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("does not re-mint when the blueprint row stores no body reference", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId);
      // The body IS stored; the row simply carries no pointer to it,
      // so only the missing pointer can explain the refusal.
      await seedBlueprint(f, { withCodeHash: false });

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      expect(await f.renderStore.get(sessionId)).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("does not re-mint when the body behind the code hash is gone", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId);
      await seedBlueprint(f, { withBody: false });

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      expect(await f.renderStore.get(sessionId)).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("does not re-mint when no record was ever written", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedBlueprint(f);

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      expect(await f.renderStore.get(sessionId)).toBeNull();
    } finally {
      await f.close();
    }
  });
});

describe("resource read — the re-mint path is gated before it resolves anything", () => {
  it("refuses a caller the record does not belong to, and commits nothing", async () => {
    const f = await boot({ getContext: () => intruderCtx });
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      expect(await f.renderStore.get(sessionId)).toBeNull();
      expect(f.warn).toHaveBeenCalledWith(
        "render_resource_read_denied",
        expect.objectContaining({
          sessionId,
          rowAppId: RECORD_APP_ID,
          callerAppId: OTHER_APP_ID,
        }),
      );
    } finally {
      await f.close();
    }
  });

  it("refuses a caller who is not the record's subject", async () => {
    const f = await boot({
      getContext: () => ({
        appId: RECORD_APP_ID,
        authSource: "apikey",
        apiKeyHash: "same-app-other-user",
        requestId: "req-other-user",
        userId: "user-b",
      }),
    });
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId, { userId: "user-a" });
      await seedBlueprint(f);

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      expect(await f.renderStore.get(sessionId)).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("answers an unauthorized read of a RESOLVABLE locator byte-identically to one that never existed", async () => {
    const f = await boot({ getContext: () => intruderCtx });
    try {
      const resolvableSessionId = randomUUID();
      await seedRemintable(f, resolvableSessionId);
      const neverExistedSessionId = randomUUID();

      const refused = await f.client.readResource({
        uri: `${RESOURCE_URI}/${resolvableSessionId}/${CONTRACT_KEY}`,
      });
      const missing = await f.client.readResource({
        uri: `${RESOURCE_URI}/${neverExistedSessionId}/${CONTRACT_KEY}`,
      });

      expect(normalize(refused.contents, resolvableSessionId)).toEqual(
        normalize(missing.contents, neverExistedSessionId),
      );
    } finally {
      await f.close();
    }
  });

  it("never commits over a row whose generation is still in flight", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);
      // A placeholder row — minted, nothing committed onto it yet.
      // It carries no renderable, so the mount path declines it, and
      // that is exactly when a re-mint would be tempted to fire. It
      // must not: the row is alive and a commit would overwrite the
      // render that is still being generated.
      await f.renderStore.create({ id: sessionId, appId: RECORD_APP_ID });

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      const untouched = (await f.renderStore.get(sessionId))
        ?.render as ComponentGguiSession;
      expect(untouched.componentCode).toBe("");
    } finally {
      await f.close();
    }
  });

  it("never commits over an existing row on behalf of a caller the row refused", async () => {
    // The row belongs to one owner and the record to another — the
    // shape a reused sessionId would produce. The caller owns the
    // RECORD, so a re-mint that fired here would pass its own gate and
    // then overwrite a row it was just refused.
    const f = await boot({ getContext: () => intruderCtx });
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId, { appId: OTHER_APP_ID });
      await seedBlueprint(f, { appId: OTHER_APP_ID });
      const live: ComponentGguiSession = {
        type: "component",
        id: sessionId,
        appId: RECORD_APP_ID,
        componentCode: LIVE_ROW_CODE,
        eventSequence: 0,
        createdAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_000_000,
        expiresAt: 1_900_000_000_000,
      };
      await f.renderStore.commit({ render: live, appId: RECORD_APP_ID });

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      const stillTheirs = await f.renderStore.get(sessionId);
      expect(stillTheirs?.appId).toBe(RECORD_APP_ID);
      expect((stillTheirs?.render as ComponentGguiSession).componentCode).toBe(
        LIVE_ROW_CODE,
      );
    } finally {
      await f.close();
    }
  });

  it("never re-mints over a row that still exists", async () => {
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);
      const live: ComponentGguiSession = {
        type: "component",
        id: sessionId,
        appId: RECORD_APP_ID,
        componentCode: LIVE_ROW_CODE,
        props: { city: "Live" },
        eventSequence: 0,
        createdAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_000_000,
        expiresAt: 1_900_000_000_000,
      };
      await f.renderStore.commit({ render: live, appId: RECORD_APP_ID });

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      const meta = parseMeta(shellText(read.contents));
      expect(JSON.parse(meta["propsJson"] as string)).toEqual({ city: "Live" });

      const stillLive = (await f.renderStore.get(sessionId))?.render as ComponentGguiSession;
      expect(stillLive.componentCode).toBe(LIVE_ROW_CODE);
    } finally {
      await f.close();
    }
  });
});

describe("resource read — deployments that bind nothing are unchanged", () => {
  it("skips the path entirely when the durable pair is absent", async () => {
    const f = await boot({ withoutDurableBlueprints: true });
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);
      const recordRead = vi.spyOn(f.identityStore, "get");

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      expect(recordRead).not.toHaveBeenCalled();
      expect(await f.renderStore.get(sessionId)).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("skips the path entirely when the identity store is absent", async () => {
    const f = await boot({ withoutIdentityStore: true });
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);
      const blueprintRead = vi.spyOn(f.blueprintStore, "get");

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(true);
      expect(blueprintRead).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});

describe("resource read — blueprint-registry lookup is post-gate only", () => {
  it("does not consult the registry when the row itself serves the mount", async () => {
    const f = await boot({ withRegistryFallback: true });
    try {
      const sessionId = randomUUID();
      const live: ComponentGguiSession = {
        type: "component",
        id: sessionId,
        appId: RECORD_APP_ID,
        componentCode: LIVE_ROW_CODE,
        eventSequence: 0,
        createdAt: 1_700_000_000_000,
        lastActivityAt: 1_700_000_000_000,
        expiresAt: 1_900_000_000_000,
      };
      await f.renderStore.commit({ render: live, appId: RECORD_APP_ID });
      const indexRead = vi.spyOn(f.index, "getId");

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(false);
      expect(indexRead).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("does not consult the registry when the re-mint path serves the mount", async () => {
    const f = await boot({ withRegistryFallback: true });
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);
      const indexRead = vi.spyOn(f.index, "getId");

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      expect(isLoadingShell(shellText(read.contents))).toBe(false);
      expect(indexRead).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
