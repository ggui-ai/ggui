import { describe, expect, it } from "vitest";
import type { HandlerContext } from "../types.js";
import { createGguiDeclareToolCatalogHandler } from "./declare-tool-catalog.js";
import { InMemoryToolIdentityCatalogStore } from "./tool-identity-catalog-store.js";

function makeCtx(appId: string): HandlerContext {
  return { appId, requestId: "req-1" };
}

describe("createGguiDeclareToolCatalogHandler", () => {
  it("persists the declared catalog under ctx.appId and acks {saved,appId}", async () => {
    const store = new InMemoryToolIdentityCatalogStore();
    const handler = createGguiDeclareToolCatalogHandler({ catalogStore: store });

    const catalog = {
      todo_add: { name: "@ggui-samples/mcp-todo", version: "0.0.1" },
    };

    const result = await handler.handler({ toolCatalog: catalog }, makeCtx("app-1"));

    expect(result).toEqual({ saved: true, appId: "app-1" });
    expect(await store.get("app-1")).toEqual(catalog);
  });

  it("declares audience runtime (routed on the agent endpoint, off the LLM tools/list)", () => {
    const store = new InMemoryToolIdentityCatalogStore();
    const handler = createGguiDeclareToolCatalogHandler({ catalogStore: store });
    expect(handler.name).toBe("ggui_runtime_declare_tool_catalog");
    expect(handler.audience).toEqual(["runtime"]);
  });

  it("scopes the write to ctx.appId — never crosses tenants", async () => {
    const store = new InMemoryToolIdentityCatalogStore();
    const handler = createGguiDeclareToolCatalogHandler({ catalogStore: store });

    await handler.handler(
      { toolCatalog: { todo_add: { name: "@a/todo" } } },
      makeCtx("app-a"),
    );
    await handler.handler(
      { toolCatalog: { todo_add: { name: "@b/todo" } } },
      makeCtx("app-b"),
    );

    expect(await store.get("app-a")).toEqual({ todo_add: { name: "@a/todo" } });
    expect(await store.get("app-b")).toEqual({ todo_add: { name: "@b/todo" } });
  });

  it("last-write-wins per appId (REPLACE semantics)", async () => {
    const store = new InMemoryToolIdentityCatalogStore();
    const handler = createGguiDeclareToolCatalogHandler({ catalogStore: store });

    await handler.handler(
      { toolCatalog: { todo_add: { name: "@old/todo", version: "0.0.1" } } },
      makeCtx("app-1"),
    );
    await handler.handler(
      { toolCatalog: { todo_remove: { name: "@new/todo" } } },
      makeCtx("app-1"),
    );

    expect(await store.get("app-1")).toEqual({ todo_remove: { name: "@new/todo" } });
  });

  it("rejects an unknown top-level field (strict schema)", async () => {
    const store = new InMemoryToolIdentityCatalogStore();
    const handler = createGguiDeclareToolCatalogHandler({ catalogStore: store });
    await expect(
      handler.handler(
        { toolCatalog: {}, bogus: true },
        makeCtx("app-1"),
      ),
    ).rejects.toThrow();
  });
});
