/**
 * State (b) — a render row that is PRESENT but past its `expiresAt`
 * (#430 slice 3, task 4).
 *
 * A store may keep a row readable for a while after it expires — a
 * reaper runs on its own schedule, and some stores stamp the deletion
 * deadline with a grace window on top of `expiresAt` rather than at it.
 * A read landing in that window mounts the row and mints a fresh
 * live-channel token against it, and the token then outlives the row it
 * addresses: the iframe opens a WebSocket for a render the next reaper
 * pass deletes.
 *
 * The fix is to give the row back a full lifetime on such a read, which
 * makes the token's promise true rather than making the token weaker.
 * Two properties carry it, and both are pinned here:
 *
 *   - the extension is CONDITIONAL. A read of a live row must not write
 *     to the store at all; a resource read is the hottest path this
 *     handler has, and turning every one of them into an UpdateItem is
 *     a cost regression disguised as a lifecycle fix.
 *   - the extension happens BEFORE the mint. Reversed, the window it
 *     closes is still open — narrower, but a token minted against a row
 *     whose expiry has not yet moved is the same bug.
 *
 * The lifetime comes from the operator's one retention knob
 * (`renderTtlMs`, the same value `ggui_render` stamps with), never from
 * a constant local to the read path — a server whose renders live 90
 * days must not have its rehydrated ones silently demoted to an hour.
 */
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InMemoryBlueprintStore,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryRenderIdentityStore,
} from "@ggui-ai/mcp-server-core/in-memory";
import type { Blueprint, ComponentGguiSession, DataContract } from "@ggui-ai/protocol";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import {
  registerGguiRenderResourceTemplate,
  type GguiRenderResourceTemplateOptions,
} from "./mcp-apps-outbound.js";

const RESOURCE_URI = "ui://ggui/render";
const APP_ID = "app_owner";
const OTHER_APP_ID = "app_intruder";
const CONTRACT_KEY = "0123456789abcdef";
const BLUEPRINT_ID = "bp_00000000-0000-4000-8000-000000000042";
const COMPONENT_CODE = "export default function Card(){return null;}";
const DURABLE_CODE = "export default function ReMinted(){return null;}";

/**
 * Deliberately odd, and deliberately not a round hour or day: a passing
 * assertion can only come from the option being read, never from a
 * leftover constant that happens to agree.
 */
const OPERATOR_TTL_MS = 86_401_000;

/**
 * The handler's own fallback, spelled out rather than imported — the
 * slice convention is that production code owns the constant and tests
 * pin the value, so a change to one is visible as a diff on the other.
 */
const FALLBACK_TTL_MS = 60 * 60 * 1000;

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

const intruderCtx: HandlerContext = {
  appId: OTHER_APP_ID,
  authSource: "apikey",
  apiKeyHash: "intruder-hash",
  requestId: "req-intruder",
};

const CONTRACT: DataContract = {
  propsSpec: { properties: { city: { schema: { type: "string" } } } },
};

function sha256Hex(code: string): string {
  return createHash("sha256").update(code, "utf-8").digest("hex");
}

interface Fixture {
  readonly client: Client;
  readonly renderStore: InMemoryGguiSessionStore;
  readonly identityStore: InMemoryRenderIdentityStore;
  readonly blueprintStore: InMemoryBlueprintStore;
  readonly durableCodeStore: InMemoryCodeStore;
  readonly update: MockInstance<InMemoryGguiSessionStore["update"]>;
  readonly mint: MockInstance<
    NonNullable<GguiRenderResourceTemplateOptions["mintWsToken"]>
  >;
  readonly warn: ReturnType<typeof vi.fn>;
  /**
   * Make every subsequent `update` reject. Called AFTER seeding, never
   * as a boot option: the fixture sets a row's expiry through the same
   * method, so breaking it up front would break the fixture rather than
   * the handler.
   */
  readonly breakUpdate: () => void;
  readonly close: () => Promise<void>;
}

async function boot(
  options: {
    readonly getContext?: () => HandlerContext | undefined;
    /** Leave `renderTtlMs` unset so the handler's own fallback answers. */
    readonly withoutTtlOption?: boolean;
  } = {},
): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const identityStore = new InMemoryRenderIdentityStore();
  const blueprintStore = new InMemoryBlueprintStore();
  const durableCodeStore = new InMemoryCodeStore();
  const warn = vi.fn();
  const mint = vi.fn((sessionId: string, appId: string) => ({
    wsUrl: `wss://live.example/${appId}`,
    token: `ws-token-for-${sessionId}`,
    expiresAt: "2030-01-01T00:00:00.000Z",
  }));
  const update = vi.spyOn(renderStore, "update");

  const server = new McpServer({ name: "ttl-bump-test", version: "0.0.1" });
  registerGguiRenderResourceTemplate(server, {
    renderStore,
    runtimeUrl: "https://runtime.example/bundle.js",
    getContext: options.getContext ?? (() => ownerCtx),
    logger: { ...silentLogger, warn },
    mintWsToken: mint,
    renderIdentityStore: identityStore,
    durableBlueprints: { blueprintStore, codeStore: durableCodeStore },
    ...(options.withoutTtlOption ? {} : { renderTtlMs: OPERATOR_TTL_MS }),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ttl-bump-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    renderStore,
    identityStore,
    blueprintStore,
    durableCodeStore,
    update,
    mint,
    warn,
    breakUpdate: () => {
      update.mockRejectedValue(new Error("session store is having a bad moment"));
    },
    close: async () => {
      update.mockRestore();
      await client.close();
      await server.close();
    },
  };
}

/**
 * Commit a mountable row, then backdate its expiry and clear the spy —
 * so every `update` a test observes is the handler's own, never the
 * one that set the fixture up.
 */
async function seedExpiredRow(f: Fixture, sessionId: string): Promise<void> {
  await seedLiveRow(f, sessionId);
  await f.renderStore.update(sessionId, { expiresAt: Date.now() - 1_000 });
  f.update.mockClear();
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
  f.update.mockClear();
}

/** A row the caller may read that carries nothing to mount. */
async function seedExpiredPlaceholder(f: Fixture, sessionId: string): Promise<void> {
  const render: ComponentGguiSession = {
    type: "component",
    id: sessionId,
    appId: APP_ID,
    componentCode: "",
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  await f.renderStore.commit({ render, appId: APP_ID });
  await f.renderStore.update(sessionId, { expiresAt: Date.now() - 1_000 });
  f.update.mockClear();
}

/** Record + blueprint row + body: the fully re-mintable state. */
async function seedRemintable(f: Fixture, sessionId: string): Promise<void> {
  await f.identityStore.put({
    sessionId,
    appId: APP_ID,
    blueprintId: BLUEPRINT_ID,
    contractKey: CONTRACT_KEY,
    variantKey: "default",
    props: { city: "Seoul" },
    seqAtLastCommit: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
  });
  const blueprint: Blueprint = {
    blueprintId: BLUEPRINT_ID,
    contractHash: CONTRACT_KEY,
    appId: APP_ID,
    codeHash: sha256Hex(DURABLE_CODE),
    source: { kind: "user" },
    variance: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: "agent",
    contract: CONTRACT,
  };
  await f.blueprintStore.put(blueprint);
  await f.durableCodeStore.put(sha256Hex(DURABLE_CODE), DURABLE_CODE);
}

async function read(f: Fixture, sessionId: string): Promise<void> {
  await f.client.readResource({ uri: `${RESOURCE_URI}/${sessionId}/${CONTRACT_KEY}` });
}

async function readFailure(f: Fixture, sessionId: string): Promise<unknown> {
  try {
    await read(f, sessionId);
  } catch (err) {
    return err;
  }
  throw new Error(`read of ${sessionId} returned a result; expected a typed failure`);
}

describe("expired-row reads extend the row (#430 slice 3, state b)", () => {
  it("gives an expired row a full lifetime and still mounts it", async () => {
    const f = await boot();
    try {
      await seedExpiredRow(f, "render_expired");
      const before = Date.now();
      await read(f, "render_expired");
      const after = Date.now();

      expect(f.update).toHaveBeenCalledTimes(1);
      const stored = await f.renderStore.get("render_expired");
      expect(stored?.expiresAt).toBeGreaterThanOrEqual(before + OPERATOR_TTL_MS);
      expect(stored?.expiresAt).toBeLessThanOrEqual(after + OPERATOR_TTL_MS);
    } finally {
      await f.close();
    }
  });

  it("writes nothing when the row is still live", async () => {
    // The conditional half. A resource read is the hottest path here;
    // extending unconditionally would put a store write on every one.
    const f = await boot();
    try {
      await seedLiveRow(f, "render_live");
      await read(f, "render_live");
      expect(f.update).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("extends the row BEFORE minting the token that addresses it", async () => {
    // Reversed, the token is still minted against a row whose expiry
    // has not moved — the same bug, in a narrower window.
    const f = await boot();
    try {
      await seedExpiredRow(f, "render_order");
      await read(f, "render_order");
      expect(f.update).toHaveBeenCalledTimes(1);
      expect(f.mint).toHaveBeenCalledTimes(1);
      expect(f.update.mock.invocationCallOrder[0]).toBeLessThan(
        f.mint.mock.invocationCallOrder[0]!,
      );
    } finally {
      await f.close();
    }
  });

  it("falls back to an hour when the operator names no retention", async () => {
    const f = await boot({ withoutTtlOption: true });
    try {
      await seedExpiredRow(f, "render_default_ttl");
      const before = Date.now();
      await read(f, "render_default_ttl");
      const after = Date.now();
      const stored = await f.renderStore.get("render_default_ttl");
      expect(stored?.expiresAt).toBeGreaterThanOrEqual(before + FALLBACK_TTL_MS);
      expect(stored?.expiresAt).toBeLessThanOrEqual(after + FALLBACK_TTL_MS);
    } finally {
      await f.close();
    }
  });

  it("serves the read even when the extension fails, and says so", async () => {
    // A store that cannot extend is a worse outcome than one that can,
    // but it is not a reason to refuse a render the caller owns and the
    // handler can mount: failing here would turn a bad moment into a
    // dead card. It must not be silent, though — the row is now known
    // to be living on borrowed time.
    const f = await boot();
    try {
      await seedExpiredRow(f, "render_broken_update");
      f.breakUpdate();
      const resp = await f.client.readResource({
        uri: `${RESOURCE_URI}/render_broken_update/${CONTRACT_KEY}`,
      });
      expect(resp.contents).toHaveLength(1);
      expect(f.warn).toHaveBeenCalledWith(
        "render_resource_ttl_extend_failed",
        expect.objectContaining({ sessionId: "render_broken_update" }),
      );
    } finally {
      await f.close();
    }
  });

  it("never extends a row the caller may not read", async () => {
    // The gate collapses a refused row to absent before any of this
    // runs. A write here would be a side effect the caller is not
    // entitled to cause — and a timing signal that the row exists.
    const f = await boot({ getContext: () => intruderCtx });
    try {
      await seedExpiredRow(f, "render_refused");
      await readFailure(f, "render_refused");
      expect(f.update).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("does not extend an expired row that has nothing to mount", async () => {
    // No mount, no token, nothing whose promise needs to be kept.
    const f = await boot();
    try {
      await seedExpiredPlaceholder(f, "render_placeholder");
      await readFailure(f, "render_placeholder");
      expect(f.update).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("does not extend a row the same read just re-minted", async () => {
    // The re-mint commits a fresh row, so its expiry is already ahead
    // of now; extending it would be a second write for one read.
    const f = await boot();
    try {
      await seedRemintable(f, "render_reminted");
      await read(f, "render_reminted");
      expect(f.update).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("stamps the operator's retention on the row a re-mint commits", async () => {
    // The same knob on both halves of the read path: the re-mint used
    // to carry its own module-local hour, which would have expired a
    // rehydrated render 89 days before its neighbours.
    const f = await boot();
    try {
      await seedRemintable(f, "render_reminted_ttl");
      const before = Date.now();
      await read(f, "render_reminted_ttl");
      const after = Date.now();
      const stored = await f.renderStore.get("render_reminted_ttl");
      const committed = stored?.render as ComponentGguiSession | undefined;
      expect(committed?.expiresAt).toBeGreaterThanOrEqual(before + OPERATOR_TTL_MS);
      expect(committed?.expiresAt).toBeLessThanOrEqual(after + OPERATOR_TTL_MS);
    } finally {
      await f.close();
    }
  });
});
