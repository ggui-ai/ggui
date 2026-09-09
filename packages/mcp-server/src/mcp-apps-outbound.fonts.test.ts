/**
 * Font-face transport, the server's leg (ggui#987 §5): a deployment
 * that declares `fontFaces` gets (a) each face's origin unioned into
 * `_meta.ui.csp.resourceDomains` on every served shell — a declared
 * face is admitted by construction, as a gadget's bundle origin is —
 * and (b) the `@font-face` rules inlined in the served shell under
 * `<style data-ggui-fonts>`, so a host that announces no fonts of its
 * own still paints the app's faces.
 */
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryGguiSessionStore } from "@ggui-ai/mcp-server-core/in-memory";
import type { ComponentGguiSession } from "@ggui-ai/protocol";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import type { FontFaceDeclaration } from "@ggui-ai/design/themes";
import {
  buildInlineRenderShellHtml,
  registerGguiRenderResourceTemplate,
} from "./mcp-apps-outbound.js";

const APP = "app-fonts";
const SID = "render-fonts-1";
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger };
const FACES: readonly FontFaceDeclaration[] = [
  { family: "Acme Sans", src: "https://fonts.acme.example/acme.woff2", weight: 400 },
  { family: "Acme Mono", src: "https://cdn.other.example/mono.woff" },
];

async function served(fontFaces?: readonly FontFaceDeclaration[]) {
  const store = new InMemoryGguiSessionStore();
  const server = new McpServer({ name: "fonts-test", version: "0.0.1" });
  registerGguiRenderResourceTemplate(server, {
    renderStore: store,
    runtimeUrl: "https://runtime.example/bundle.js",
    publicBaseUrl: "https://api.example",
    getContext: () => ({ appId: APP }) as HandlerContext,
    logger: silentLogger,
    ...(fontFaces !== undefined ? { fontFaces } : {}),
  });
  const render: ComponentGguiSession = {
    type: "component",
    id: SID,
    appId: APP,
    componentCode: "export default function X(){return null}",
    eventSequence: 0,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_000,
    expiresAt: 1_900_000_000_000,
  };
  await store.commit({ render, appId: APP });
  const client = new Client({ name: "fonts-host", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const read = await client.readResource({ uri: `ui://ggui/render/${SID}` });
  await client.close();
  const first = read.contents[0] as {
    text?: string;
    _meta?: { ui?: { csp?: { resourceDomains?: readonly string[] } } };
  };
  return { html: first.text ?? "", resourceDomains: first._meta?.ui?.csp?.resourceDomains ?? [] };
}

describe("fontFaces on the served shell (ggui#987 §5)", () => {
  it("unions every declared face's origin into _meta.ui.csp.resourceDomains, deduped", async () => {
    const { resourceDomains } = await served(FACES);
    expect(resourceDomains).toContain("https://api.example");
    expect(resourceDomains).toContain("https://fonts.acme.example");
    expect(resourceDomains).toContain("https://cdn.other.example");
    expect(new Set(resourceDomains).size).toBe(resourceDomains.length);
  });

  it("inlines the @font-face rules under <style data-ggui-fonts> in the served shell", async () => {
    const { html } = await served(FACES);
    const m = html.match(/<style data-ggui-fonts>([\s\S]*?)<\/style>/);
    expect(m, "no <style data-ggui-fonts> in the served shell").not.toBeNull();
    expect(m![1]).toContain("@font-face { font-family: 'Acme Sans'; src: url('https://fonts.acme.example/acme.woff2') format('woff2'); font-weight: 400; }");
    expect(m![1]).toContain("font-family: 'Acme Mono'; src: url('https://cdn.other.example/mono.woff') format('woff')");
  });

  it("no faces declared → no fonts style, resourceDomains unchanged", async () => {
    const { html, resourceDomains } = await served();
    expect(html).not.toContain("data-ggui-fonts");
    expect(resourceDomains).toEqual(["https://api.example"]);
  });

  it("the inline /r/<shortCode> shell carries the same rules when handed them", () => {
    const css = "@font-face { font-family: 'Acme Sans'; src: url('https://fonts.acme.example/acme.woff2') format('woff2'); }";
    expect(buildInlineRenderShellHtml("globalThis.__x=1;", { fontFacesCss: css })).toContain(`<style data-ggui-fonts>${css}</style>`);
    expect(buildInlineRenderShellHtml("globalThis.__x=1;")).not.toContain("data-ggui-fonts");
  });
});
