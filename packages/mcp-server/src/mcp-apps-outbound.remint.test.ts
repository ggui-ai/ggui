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
 * Deployments that bind neither store never touch either one — pinned
 * by spying on the stores, because "the new path is skipped" is the
 * property every existing deployment depends on. What such a server
 * ANSWERS did change with the typed failures: it says NOT_SUPPORTED
 * rather than handing back a shell that cannot paint.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  InMemoryBlueprintIndex,
  InMemoryBlueprintStore,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryRenderIdentityStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from "@ggui-ai/mcp-server-core/in-memory";
import type {
  App,
  AppMetadataStore,
  RenderIdentityRecord,
} from "@ggui-ai/mcp-server-core";
import { registerBlueprint } from "@ggui-ai/mcp-server-handlers";
import type {
  AppTheme,
  Blueprint,
  ComponentGguiSession,
  DataContract,
  GadgetDescriptor,
} from "@ggui-ai/protocol";
import type { McpAppAiGguiRenderMeta } from "@ggui-ai/protocol/integrations/mcp-apps";
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
  readonly vectorStore: InMemoryVectorStore;
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
    /** Per-app metadata source the re-mint reads its sidecars from. */
    readonly appMetadataStore?: AppMetadataStore;
  } = {},
): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const identityStore = new InMemoryRenderIdentityStore();
  const blueprintStore = new InMemoryBlueprintStore();
  const durableCodeStore = new InMemoryCodeStore();
  const index = new InMemoryBlueprintIndex();
  const vectorStore = new InMemoryVectorStore();
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
          vectorStore,
          index,
          defaultAppIdFallback: BUILDER_APP_ID,
          // `buildShellFromBlueprint` needs both to synthesize the
          // registry-only shell; without them the fallback fails typed
          // and the probe never exercises a real response body.
          codeStore: new InMemoryCodeStore(),
          codeBaseUrl: "https://code.example",
        }
      : {}),
    ...(options.appMetadataStore !== undefined
      ? { appMetadataStore: options.appMetadataStore }
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
    vectorStore,
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
    readonly contract?: DataContract;
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
    contract: options.contract ?? CONTRACT,
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

/**
 * A resource-read content block, narrowed to what these tests read.
 * `uri` is on both arms of the SDK's text/blob union; `text` only on
 * the arm a shell response takes, so an accidental blob response fails
 * loudly in `shellText` instead of reading as an empty string.
 */
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

/**
 * Parse the shell's inline bootstrap slice. Typed as the wire shape the
 * server emits, so a field rename shows up here as a compile error
 * rather than an assertion that silently reads `undefined`.
 */
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

/** Props as the shell carries them — JSON text on the slice. */
function parseProps(meta: McpAppAiGguiRenderMeta): unknown {
  if (meta.propsJson === undefined) return undefined;
  return JSON.parse(meta.propsJson);
}

const APP_THEME: AppTheme = {
  mode: "dark",
  cssVariables: { "--ggui-color-accent": "#ff00aa" },
  name: "operator-overlay",
};

const REFERENCED_GADGET_PACKAGE = "@example/maps";

/**
 * The operator's current gadget catalog. Two packages, only one of
 * which the contract below references — so a test that asserts the
 * re-mint carries exactly one descriptor is asserting the FILTER, not
 * just that a list got copied.
 *
 * Neither is `@ggui-ai/gadgets` on purpose: STDLIB is pre-loaded by
 * the runtime and deliberately never emitted as a gadget
 * registration, so a fixture built on it would assert an empty
 * projection and prove nothing.
 */
const APP_GADGETS: readonly GadgetDescriptor[] = [
  {
    package: REFERENCED_GADGET_PACKAGE,
    version: "1.4.0",
    exports: [{ hook: "useMapViewport", permission: "geolocation" }],
  },
  {
    package: "@example/unreferenced",
    version: "2.0.0",
    exports: [{ hook: "useSomethingElse" }],
  },
];

/** A contract that references exactly one of the two packages above. */
const GADGET_CONTRACT: DataContract = {
  ...CONTRACT,
  clientCapabilities: {
    gadgets: { [REFERENCED_GADGET_PACKAGE]: { useMapViewport: {} } },
  },
};

/** App-metadata source that answers with a themed app record. */
const themedAppMetadataStore: AppMetadataStore = {
  get: async (appId: string): Promise<App | null> => ({
    id: appId,
    gadgets: APP_GADGETS,
    theme: APP_THEME,
  }),
};

/** App-metadata source having a bad moment. */
const failingAppMetadataStore: AppMetadataStore = {
  get: async (): Promise<App | null> => {
    throw new Error("app metadata store unavailable");
  },
};

interface ReadFailure {
  readonly code: number;
  readonly message: string;
  readonly data: unknown;
}

/**
 * Read a locator that must FAIL, and return the failure. A positive
 * assertion rather than a bare throw-pin: a read that succeeded, or one
 * that raised an untyped error, fails this helper instead of passing
 * through it.
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

/** MCP's resource-not-found number. */
const SESSION_NOT_FOUND = -32002;
/** The canonical code the other three failure classes ride on. */
const MOUNT_UNAVAILABLE = -32006;

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
      expect(meta.sessionId).toBe(sessionId);
      expect(meta.appId).toBe(RECORD_APP_ID);
      // A LIVE mount: freshly minted live-channel trio.
      expect(meta.wsToken).toBe(`ws-token-for-${sessionId}`);
      expect(meta.wsUrl).toBe(`wss://live.example/${RECORD_APP_ID}`);
      // The record's props, NOT the contract's authoring defaults.
      expect(parseProps(meta)).toEqual(RECORD_PROPS);
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
      expect(parseMeta(shellText(second.contents)).wsToken).toBe(
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
      expect(parseMeta(shellText(read.contents)).lastSequence).toBe(
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

  it("re-resolves the theme sidecar from the live app record", async () => {
    // Sidecars are the operator's CURRENT configuration, not a
    // snapshot of what the render had — so a re-mint mounts under
    // whatever the app record says today.
    const f = await boot({ appMetadataStore: themedAppMetadataStore });
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      const meta = parseMeta(shellText(read.contents));
      expect(meta.theme).toEqual(APP_THEME);
      // And it reached the durable row, not just this one response.
      const committed = (await f.renderStore.get(sessionId))
        ?.render as ComponentGguiSession;
      expect(committed.theme).toEqual(APP_THEME);
    } finally {
      await f.close();
    }
  });

  it("re-resolves gadget descriptors, filtered to what the contract references", async () => {
    // The catalog holds two packages and the contract references one.
    // Asserting exactly one descriptor survives is what makes this a
    // test of the FILTER rather than of a list being copied across.
    const f = await boot({ appMetadataStore: themedAppMetadataStore });
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId);
      await seedBlueprint(f, { contract: GADGET_CONTRACT });

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      const committed = (await f.renderStore.get(sessionId))
        ?.render as ComponentGguiSession;
      expect(committed.gadgetDescriptors).toEqual([APP_GADGETS[0]]);

      // The descriptor reaches the shell as a gadget registration, and
      // its declared permission reaches the permissions policy — the
      // two projections a mounted wrapper actually depends on.
      const meta = parseMeta(shellText(read.contents));
      expect(meta.gadgets?.map((g) => g.package)).toEqual([
        REFERENCED_GADGET_PACKAGE,
      ]);
      expect(meta.permissionsPolicy).toEqual(["geolocation"]);
    } finally {
      await f.close();
    }
  });

  it("still re-mints when the app-metadata store is unavailable, minus the sidecars", async () => {
    // The sidecars are presentation. A metadata store having a bad
    // moment must cost the render its theme, never its rehydrate —
    // the body and props, which a mount cannot do without, were
    // resolved before this lookup runs.
    const f = await boot({ appMetadataStore: failingAppMetadataStore });
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      const html = shellText(read.contents);
      expect(isLoadingShell(html)).toBe(false);
      const meta = parseMeta(html);
      expect(meta.wsToken).toBe(`ws-token-for-${sessionId}`);
      expect(parseProps(meta)).toEqual(RECORD_PROPS);
      expect(meta.theme).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("restores an absence of props as an absence, never as contract defaults", async () => {
    // `props` is optional on both the record and the wire shape, so a
    // record with none describes a render that had none. Booting the
    // contract's authoring-time defaults instead would show
    // plausible-looking wrong state that nothing ever corrects —
    // props travel the session channel, and no agent turn runs at
    // rehydration.
    const f = await boot();
    try {
      const sessionId = randomUUID();
      await seedRecord(f.identityStore, sessionId, { props: undefined });
      await seedBlueprint(f);

      const read = await f.client.readResource({
        uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`,
      });
      const html = shellText(read.contents);
      // Still a live mount — absent props are not a resolution failure.
      expect(isLoadingShell(html)).toBe(false);
      const meta = parseMeta(html);
      expect(meta.wsToken).toBe(`ws-token-for-${sessionId}`);
      // No props on the slice, and none on the committed row.
      expect(meta.propsJson).toBeUndefined();
      expect(html).not.toContain(CONTRACT_DEFAULT_CITY);
      const committed = (await f.renderStore.get(sessionId))
        ?.render as ComponentGguiSession;
      expect(committed.props).toBeUndefined();
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
      expect(parseProps(parseMeta(html))).toEqual(RECORD_PROPS);
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
      expect(parseMeta(html).appId).toBe(BUILDER_APP_ID);
      expect(parseProps(parseMeta(html))).toEqual(RECORD_PROPS);
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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "BLUEPRINT_UNRESOLVABLE",
        detail: "the record names no blueprint",
      });
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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "BLUEPRINT_UNRESOLVABLE",
        detail: "the blueprint the record names is gone",
      });
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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "BLUEPRINT_UNRESOLVABLE",
        detail: "the blueprint stores no component reference",
      });
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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "BLUEPRINT_UNRESOLVABLE",
        detail: "the component body behind the blueprint is gone",
      });
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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(SESSION_NOT_FOUND);
      expect(failure.data).toEqual({ code: "NOT_FOUND" });
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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(SESSION_NOT_FOUND);
      expect(failure.data).toEqual({ code: "NOT_FOUND" });
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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(SESSION_NOT_FOUND);
      expect(failure.data).toEqual({ code: "NOT_FOUND" });
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

      const refused = await readFailure(
        f.client,
        `${RESOURCE_URI}/${resolvableSessionId}/${CONTRACT_KEY}`,
      );
      const missing = await readFailure(
        f.client,
        `${RESOURCE_URI}/${neverExistedSessionId}/${CONTRACT_KEY}`,
      );

      // The refused locator is fully re-mintable for its owner, and
      // the other never existed at all — yet neither the code, the
      // message, nor `data` may differ.
      expect(normalize(refused, resolvableSessionId)).toEqual(
        normalize(missing, neverExistedSessionId),
      );
      expect(refused.data).toEqual({ code: "NOT_FOUND" });
    } finally {
      await f.close();
    }
  });

  it("stays byte-identical when the registry fallback actually answers", async () => {
    // The variant that matters. With no registry wired, both probes
    // fail with the same typed error and the comparison is nearly free
    // — a regression could leak through the fallback and this pin
    // would not notice. Here a blueprint IS registered under the
    // fallback scope, so BOTH reads resolve a real registry shell, and
    // byte-identity has to survive a response with content in it.
    const f = await boot({
      getContext: () => intruderCtx,
      withRegistryFallback: true,
    });
    try {
      const registered = await registerBlueprint(
        {
          embedding: new MockEmbeddingProvider(),
          vectorStore: f.vectorStore,
          index: f.index,
        },
        BUILDER_APP_ID,
        {
          kind: "template",
          contract: {},
          intent: "registry-fallback probe",
          componentCode: "export default function Fallback(){return null;}",
          source: { kind: "user" },
        },
      );
      const registryKey = registered.contractKey;

      const resolvableSessionId = randomUUID();
      await seedRemintable(f, resolvableSessionId);
      const neverExistedSessionId = randomUUID();

      const refused = await f.client.readResource({
        uri: `${RESOURCE_URI}/${resolvableSessionId}/${registryKey}`,
      });
      const missing = await f.client.readResource({
        uri: `${RESOURCE_URI}/${neverExistedSessionId}/${registryKey}`,
      });

      // Both really did resolve the registry shell — otherwise this is
      // the loading-shell comparison again under a longer name.
      expect(isLoadingShell(shellText(refused.contents))).toBe(false);
      expect(isLoadingShell(shellText(missing.contents))).toBe(false);
      // And nothing from the record's owner leaked into the refused one.
      expect(shellText(refused.contents)).not.toContain(RECORD_APP_ID);

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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({
        code: "NOT_MOUNTABLE",
        detail: "the render has not committed a component yet",
      });
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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(SESSION_NOT_FOUND);
      expect(failure.data).toEqual({ code: "NOT_FOUND" });
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
      expect(parseProps(meta)).toEqual({ city: "Live" });

      const stillLive = (await f.renderStore.get(sessionId))?.render as ComponentGguiSession;
      expect(stillLive.componentCode).toBe(LIVE_ROW_CODE);
    } finally {
      await f.close();
    }
  });
});

describe("resource read — deployments that bind nothing touch nothing", () => {
  it("skips the path entirely when the durable pair is absent", async () => {
    const f = await boot({ withoutDurableBlueprints: true });
    try {
      const sessionId = randomUUID();
      await seedRemintable(f, sessionId);
      const recordRead = vi.spyOn(f.identityStore, "get");

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({ code: "NOT_SUPPORTED" });
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

      const failure = await readFailure(f.client, `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}`);
      expect(failure.code).toBe(MOUNT_UNAVAILABLE);
      expect(failure.data).toEqual({ code: "NOT_SUPPORTED" });
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
