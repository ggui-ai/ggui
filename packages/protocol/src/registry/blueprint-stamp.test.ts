import { describe, it, expect } from "vitest";
import { computeToolCatalogHash } from "./blueprint-stamp.js";

describe("computeToolCatalogHash", () => {
  it("is stable regardless of key order", () => {
    const a = computeToolCatalogHash({
      todo_add: { name: "@x/todo" },
      todo_list: { name: "@x/todo" },
    });
    const b = computeToolCatalogHash({
      todo_list: { name: "@x/todo" },
      todo_add: { name: "@x/todo" },
    });
    expect(a).toBe(b);
  });
  it("changes when a canonical name changes", () => {
    const a = computeToolCatalogHash({ todo_add: { name: "@x/todo" } });
    const b = computeToolCatalogHash({ todo_add: { name: "@y/todo" } });
    expect(a).not.toBe(b);
  });
  it("returns a 16-char hex string", () => {
    expect(computeToolCatalogHash({ todo_add: { name: "@x/todo" } })).toMatch(/^[0-9a-f]{16}$/);
  });
  it("empty catalog is stable", () => {
    expect(computeToolCatalogHash({})).toMatch(/^[0-9a-f]{16}$/);
  });
});
