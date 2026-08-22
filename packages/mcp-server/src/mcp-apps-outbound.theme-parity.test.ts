/**
 * Theme parity across transports (ggui#539).
 *
 * The `resources/read` shell used to stamp `themeId`/`themeMode` from
 * server-level options ONLY, while the tool-result slice resolved them
 * through the layered `resolveSliceTheme` chain (live pick > per-render
 * override > static `ggui.json`). Under read-plane-only mounting every
 * host mounts by read, so the agent's `ggui_render({ themeId })`
 * override — and the operator's live console pick — silently vanished.
 *
 * These tests pin the fix: the read door stamps through THE SAME
 * resolver, off the committed render's own `themeId`. The precedence
 * ladder itself is pinned at the resolver's unit tests
 * (slice-meta-derivation.test.ts); here we pin that the read door
 * actually feeds the ladder its per-render + live inputs — and that a
 * mode no layer resolves stays ABSENT (the ggui#551 host fallback
 * fires only on absence).
 */
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryGguiSessionStore } from "@ggui-ai/mcp-server-core/in-memory";
import type { ComponentGguiSession } from "@ggui-ai/protocol";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import {
  registerGguiRenderResourceTemplate,
  type GguiRenderResourceTemplateOptions,
} from "./mcp-apps-outbound.js";

const APP = "app-theme-parity";
const SID = "render-theme-1";
const ownerCtx = { appId: APP } as HandlerContext;
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

type ThemeOpts = Pick<
  GguiRenderResourceTemplateOptions,
  "themeId" | "themeMode" | "themeProvider" | "themeBaseProvider"
>;

async function boot(themeOpts: ThemeOpts): Promise<{
  client: Client;
  store: InMemoryGguiSessionStore;
  close: () => Promise<void>;
}> {
  const store = new InMemoryGguiSessionStore();
  const server = new McpServer({ name: "theme-parity-test", version: "0.0.1" });
  registerGguiRenderResourceTemplate(server, {
    renderStore: store,
    runtimeUrl: "https://runtime.example/bundle.js",
    getContext: () => ownerCtx,
    logger: silentLogger,
    ...themeOpts,
  });
  const client = new Client({ name: "theme-parity-host", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, store, close: () => client.close() };
}

async function seedRender(
  store: InMemoryGguiSessionStore,
  themeId?: string,
  theme?: ComponentGguiSession["theme"]
): Promise<void> {
  const render: ComponentGguiSession = {
    type: "component",
    id: SID,
    appId: APP,
    componentCode: "export default function X(){return null}",
    eventSequence: 0,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    expiresAt: 1_900_000_000_000,
    // The agent's per-render override, exactly as ggui_render({themeId})
    // stores it (render.ts overlay re-commit).
    ...(themeId !== undefined ? { themeId } : {}),
    // The per-app App.theme sidecar snapshotted at render-commit —
    // the `sessionSidecar` layer of the theme-binding total order.
    ...(theme !== undefined ? { theme } : {}),
  };
  await store.commit({ render, appId: APP });
}

/** Extract + parse the `__GGUI_META__` envelope from the served shell. */
async function readEnvelope(client: Client): Promise<Record<string, unknown>> {
  const read = await client.readResource({ uri: `ui://ggui/render/${SID}` });
  const first = read.contents[0] as { text?: string };
  const html = first.text ?? "";
  const match = html.match(/__GGUI_META__\s*=\s*(.*?);<\/script>/);
  expect(match, "served shell carries no __GGUI_META__ envelope").not.toBeNull();
  const raw = match![1]!
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\u0026/g, "&");
  const envelope: unknown = JSON.parse(raw);
  const slice = (envelope as Record<string, Record<string, unknown>>)[
    "ai.ggui/render"
  ];
  expect(slice, "envelope carries no ai.ggui/render slice").toBeDefined();
  return slice;
}

describe("resources/read stamps the layered theme — parity with the tool-result slice (ggui#539)", () => {
  it("the per-render override the agent set survives a mount-by-read (beats the static preset)", async () => {
    const { client, store, close } = await boot({
      themeId: "static-preset",
      themeMode: "light",
    });
    await seedRender(store, "midnight");
    const slice = await readEnvelope(client);
    expect(slice.themeId).toBe("midnight");
    expect(slice.themeMode).toBe("light");
    await close();
  });

  it("the live themeProvider pick beats the per-render override — same first layer as the tool path", async () => {
    const { client, store, close } = await boot({
      themeId: "static-preset",
      themeProvider: () => ({ id: "live-pick", mode: "dark" }),
    });
    await seedRender(store, "midnight");
    const slice = await readEnvelope(client);
    expect(slice.themeId).toBe("live-pick");
    expect(slice.themeMode).toBe("dark");
    await close();
  });

  it("no override, no live pick → the static ggui.json layer still stamps (pre-#539 behavior preserved)", async () => {
    const { client, store, close } = await boot({
      themeId: "static-preset",
      themeMode: "dark",
    });
    await seedRender(store);
    const slice = await readEnvelope(client);
    expect(slice.themeId).toBe("static-preset");
    expect(slice.themeMode).toBe("dark");
    await close();
  });

  it("the theme sidecar's mode stamps themeMode when no higher layer resolves — and the stamp is IDENTICAL to the emitted theme object's own mode (the composition law's server-side identity precondition; adversarial-cycle pin, ggui#598 leg 4)", async () => {
    // The 81-combination law in @ggui-ai/protocol/integrations/
    // theme-binding is a pure-function law; THIS pin binds it to the
    // envelope: the `sessionSidecar` input the server projection
    // consumed is the mode of the very theme object the same envelope
    // emits. Without this identity, a transport could thread one mode
    // and emit another, and the law would hold vacuously.
    const { client, store, close } = await boot({});
    await seedRender(store, undefined, {
      name: "guuey-brand-v1",
      mode: "dark",
      cssVariables: {},
    });
    const slice = await readEnvelope(client);
    expect(slice.themeMode).toBe("dark");
    expect((slice.theme as { mode?: string }).mode).toBe("dark");
    await close();
  });

  it("static config outranks the sidecar in the stamp (total order) while the emitted theme object keeps its own mode", async () => {
    const { client, store, close } = await boot({ themeMode: "light" });
    await seedRender(store, undefined, {
      name: "guuey-brand-v1",
      mode: "dark",
      cssVariables: {},
    });
    const slice = await readEnvelope(client);
    // staticConfig > sessionSidecar per the normative order; the theme
    // OBJECT still carries its own mode — the client's composed result
    // obeys the stamp (stamped > sidecar), so no side ever re-ranks.
    expect(slice.themeMode).toBe("light");
    expect((slice.theme as { mode?: string }).mode).toBe("dark");
    await close();
  });

  it("a runtime-registered theme's ladder is DELIVERED on the read door — theme.base with documentHash + both modes (ggui#598-C)", async () => {
    const BASE = {
      documentHash: "d".repeat(64),
      light: { "--ggui-color-surface": "#ffffff" },
      dark: { "--ggui-color-surface": "#101216" },
    };
    const calls: Array<[string, string]> = [];
    const { client, store, close } = await boot({
      themeBaseProvider: async (appId, name) => {
        calls.push([appId, name]);
        return name === "acme-brand-v1" ? BASE : null;
      },
    });
    await seedRender(store, undefined, {
      name: "acme-brand-v1",
      mode: "dark",
      cssVariables: {},
    });
    const slice = await readEnvelope(client);
    const theme = slice.theme as { base?: typeof BASE; mode?: string };
    expect(calls).toEqual([[APP, "acme-brand-v1"]]);
    expect(theme.base).toEqual(BASE);
    expect(theme.mode).toBe("dark");
    await close();
  });

  it("an unregistered name leaves the served theme base-less — today's path byte-preserved", async () => {
    const { client, store, close } = await boot({
      themeBaseProvider: async () => null,
    });
    await seedRender(store, undefined, {
      name: "My Decorative",
      mode: "light",
      cssVariables: {},
    });
    const slice = await readEnvelope(client);
    expect((slice.theme as { base?: unknown }).base).toBeUndefined();
    await close();
  });

  it("no layer resolves a mode → themeMode ABSENT from the served slice — the ggui#551 host fallback's precondition", async () => {
    const { client, store, close } = await boot({});
    await seedRender(store, "midnight");
    const slice = await readEnvelope(client);
    expect(slice.themeId).toBe("midnight");
    expect("themeMode" in slice).toBe(false);
    await close();
  });
});
