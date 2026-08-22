/**
 * ggui#598-C INTEGRATION VERIFY — register → validate → store →
 * deliver, end to end against the REAL components and the in-memory
 * reference store (cloud mirrors this suite on the Dynamo adapter).
 *
 * Chain under test: the ops register handler (real coverage validator
 * + real manifest + id gates) writes the canonical document; the
 * read-door envelope delivers the registered ladder as `theme.base`
 * ({documentHash, light, dark}) resolved through the design package's
 * parser-grounded resolver; re-registration rolls the hash; delete
 * returns the surface to the static path.
 */
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryGguiSessionStore, InMemoryThemeStore } from "@ggui-ai/mcp-server-core/in-memory";
import type { ComponentGguiSession } from "@ggui-ai/protocol";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import type { AppsSource, AppRecord } from "@ggui-ai/mcp-server-handlers/ops-apps";
import {
  createRegisterThemeHandler,
  createDeleteThemeHandler,
  createListThemesHandler,
  ThemeCoverageError,
  ThemeIdentityError,
  ThemeDocumentError,
} from "@ggui-ai/mcp-server-handlers/ops-themes";
import {
  lightTheme,
  darkTheme,
  validateThemeCoverage,
  consumedTokenManifest,
  resolveRegistrationVariables,
  type ThemeRegistrationDocs,
} from "@ggui-ai/design";
import { registerGguiRenderResourceTemplate } from "./mcp-apps-outbound.js";

const APP = "app-598c-verify";
const OWNER = "owner-598c";
const SID = "render-598c";
const THEME_ID = "acme-brand-v1";

const ctx: HandlerContext = { appId: APP, userId: OWNER, requestId: "r-1" } as HandlerContext;
/**
 * Honest AppsSource stub — the ONE exercised method behaves; every
 * other throws loudly (no `as unknown as` laundering; the compiler
 * checks the full surface, the runtime catches accidental use).
 */
const notExercised = (method: string) => async (): Promise<never> => {
  throw new Error(`AppsSource.${method} is not exercised by this suite`);
};
const apps: AppsSource = {
  get: async ({ appId, ownerSub }) =>
    ownerSub === OWNER && appId === APP
      ? ({ appId } as AppRecord)
      : null,
  list: notExercised("list"),
  create: notExercised("create"),
  update: notExercised("update"),
  delete: notExercised("delete"),
  setTheme: notExercised("setTheme"),
};

/** A fully-covering registration: the default pair (100% by the s2 gate). */
const COVERING: ThemeRegistrationDocs = { light: lightTheme, dark: darkTheme };

function buildHandlers(store: InMemoryThemeStore) {
  const deps = {
    apps,
    themeStore: store,
    coverageValidator: (docs: { light: Record<string, unknown>; dark: Record<string, unknown> }, tokens: readonly string[]) =>
      validateThemeCoverage(docs, tokens),
    manifestTokens: consumedTokenManifest,
    staticThemeIds: ["ggui", "midnight", "indigo"],
  };
  return {
    register: createRegisterThemeHandler(deps),
    del: createDeleteThemeHandler(deps),
    list: createListThemesHandler(deps),
  };
}

/** The reference themeBaseProvider: store → parser-grounded resolver. */
function referenceProvider(store: InMemoryThemeStore) {
  return async (appId: string, themeName: string) => {
    const stored = await store.get(appId, themeName);
    if (stored === null) return null;
    const docs = JSON.parse(stored.document) as ThemeRegistrationDocs;
    const resolved = resolveRegistrationVariables(docs);
    return { documentHash: stored.documentHash, light: { ...resolved.light }, dark: { ...resolved.dark } };
  };
}

async function bootReadDoor(store: InMemoryThemeStore) {
  const renderStore = new InMemoryGguiSessionStore();
  const server = new McpServer({ name: "598c-verify", version: "0.0.1" });
  registerGguiRenderResourceTemplate(server, {
    renderStore,
    runtimeUrl: "https://runtime.example/bundle.js",
    getContext: () => ({ appId: APP }) as HandlerContext,
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    themeBaseProvider: referenceProvider(store),
  });
  const client = new Client({ name: "598c-host", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const render: ComponentGguiSession = {
    type: "component",
    id: SID,
    appId: APP,
    componentCode: "export default function X(){return null}",
    eventSequence: 0,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    expiresAt: 1_900_000_000_000,
    theme: { name: THEME_ID, mode: "dark", cssVariables: {} },
  };
  await renderStore.commit({ render, appId: APP });
  return {
    client,
    close: () => client.close(),
    async readBase(): Promise<{ documentHash: string; light: Record<string, string>; dark: Record<string, string> } | undefined> {
      const read = await client.readResource({ uri: `ui://ggui/render/${SID}` });
      const html = (read.contents[0] as { text?: string }).text ?? "";
      const match = html.match(/__GGUI_META__\s*=\s*(.*?);<\/script>/);
      expect(match).not.toBeNull();
      const raw = match![1]!.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&");
      const slice = (JSON.parse(raw) as Record<string, Record<string, unknown>>)["ai.ggui/render"];
      return (slice.theme as { base?: { documentHash: string; light: Record<string, string>; dark: Record<string, string> } })?.base;
    },
  };
}

describe("598-C integration: register → validate → store → deliver (in-memory reference)", () => {
  it("the full chain: registration's hash arrives on the painted envelope with parser-exact variables", async () => {
    const store = new InMemoryThemeStore();
    const { register } = buildHandlers(store);
    const out = await register.handler({ appId: APP, themeId: THEME_ID, registration: COVERING }, ctx);
    expect(out.themeId).toBe(THEME_ID);
    expect(out.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.updated).toBe(false);
    expect(out.coverage.inheritMatched).toEqual([]);

    const door = await bootReadDoor(store);
    const base = await door.readBase();
    expect(base?.documentHash).toBe(out.documentHash);
    expect(base?.light["--ggui-color-surface"]).toBeDefined();
    expect(base?.dark["--ggui-color-surface"]).toBeDefined();
    expect(base?.light["--ggui-spacing-4"]).toBe("1rem");
    await door.close();
  });

  it("re-registration rolls the hash and the NEXT read delivers the new ladder — no redeploy", async () => {
    const store = new InMemoryThemeStore();
    const { register } = buildHandlers(store);
    const first = await register.handler({ appId: APP, themeId: THEME_ID, registration: COVERING }, ctx);
    const modified: ThemeRegistrationDocs = {
      light: lightTheme,
      dark: {
        ...darkTheme,
        color: {
          ...darkTheme.color,
          surface: { ...darkTheme.color.surface, $value: "#0a0c10" },
        },
      },
    };
    const second = await register.handler({ appId: APP, themeId: THEME_ID, registration: modified }, ctx);
    expect(second.updated).toBe(true);
    expect(second.documentHash).not.toBe(first.documentHash);

    const door = await bootReadDoor(store);
    const base = await door.readBase();
    expect(base?.documentHash).toBe(second.documentHash);
    expect(base?.dark["--ggui-color-surface"]).toBe("#0a0c10");
    await door.close();
  });

  it("delete returns the surface to the static path — no base on the next read; list reflects lifecycle", async () => {
    const store = new InMemoryThemeStore();
    const { register, del, list } = buildHandlers(store);
    await register.handler({ appId: APP, themeId: THEME_ID, registration: COVERING }, ctx);
    expect((await list.handler({ appId: APP }, ctx)).themes.map((t: { themeId: string }) => t.themeId)).toEqual([THEME_ID]);
    const deleted = await del.handler({ appId: APP, themeId: THEME_ID }, ctx);
    expect(deleted.deleted).toBe(true);
    expect((await list.handler({ appId: APP }, ctx)).themes).toEqual([]);

    const door = await bootReadDoor(store);
    expect(await door.readBase()).toBeUndefined();
    await door.close();
  });

  it("the four refusal walls fire with the real validator: coverage, identity ×2, document", async () => {
    const store = new InMemoryThemeStore();
    const { register } = buildHandlers(store);
    const sparse = { ...lightTheme, spacing: {}, font: { ...lightTheme.font, size: {} } };
    await expect(
      register.handler({ appId: APP, themeId: THEME_ID, registration: { light: sparse, dark: sparse } }, ctx),
    ).rejects.toThrow(ThemeCoverageError);
    await expect(
      register.handler({ appId: APP, themeId: "Bad_Id", registration: COVERING }, ctx),
    ).rejects.toThrow(ThemeIdentityError);
    await expect(
      register.handler({ appId: APP, themeId: "ggui", registration: COVERING }, ctx),
    ).rejects.toThrow(ThemeIdentityError);
    await expect(
      register.handler({ appId: APP, themeId: THEME_ID, registration: { light: { junk: true }, dark: { junk: true } } }, ctx),
    ).rejects.toThrow(ThemeDocumentError);
  });
});
