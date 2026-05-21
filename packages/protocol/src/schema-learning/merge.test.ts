import { describe, it, expect } from "vitest";
import { inferSchema, mergeSchema } from "./merge.js";

describe("inferSchema — primitives", () => {
  it("infers null", () => {
    expect(inferSchema(null)).toEqual({ type: "null" });
  });
  it("infers boolean", () => {
    expect(inferSchema(true)).toEqual({ type: "boolean" });
  });
  it("infers integer vs number", () => {
    expect(inferSchema(1)).toEqual({ type: "integer" });
    expect(inferSchema(1.5)).toEqual({ type: "number" });
  });
  it("infers string", () => {
    expect(inferSchema("x")).toEqual({ type: "string" });
  });
});

describe("inferSchema — arrays", () => {
  it("empty array has no items", () => {
    expect(inferSchema([])).toEqual({ type: "array" });
  });
  it("homogeneous array", () => {
    expect(inferSchema(["a", "b"])).toEqual({ type: "array", items: { type: "string" } });
  });
  it("mixed array unions item types", () => {
    const s = inferSchema([1, "a"]);
    expect(s.type).toBe("array");
    expect(s.items?.anyOf).toBeDefined();
    expect(s.items?.anyOf?.length).toBe(2);
  });
});

describe("inferSchema — objects", () => {
  it("infers flat object with required = all keys", () => {
    expect(inferSchema({ a: 1, b: "x" })).toEqual({
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "string" } },
      required: ["a", "b"],
    });
  });
  it("recurses into nested objects", () => {
    const s = inferSchema({ user: { id: "u1" } });
    expect(s.properties?.user?.properties?.id).toEqual({ type: "string" });
  });
});

describe("mergeSchema — required fields", () => {
  it("field seen in both stays required", () => {
    const s1 = inferSchema({ a: 1, b: 2 });
    const s2 = mergeSchema(s1, { a: 1, b: 2 });
    expect(s2.required).toEqual(["a", "b"]);
  });
  it("field missing in one sample becomes optional", () => {
    const s1 = inferSchema({ a: 1, b: 2 });
    const s2 = mergeSchema(s1, { a: 1 });
    expect(s2.required).toEqual(["a"]);
    expect(s2.properties?.b).toEqual({ type: "integer" });
  });
  it("new field from later sample is optional", () => {
    const s1 = inferSchema({ a: 1 });
    const s2 = mergeSchema(s1, { a: 1, c: "x" });
    expect(s2.required).toEqual(["a"]);
    expect(s2.properties?.c).toEqual({ type: "string" });
  });
});

describe("mergeSchema — null handling", () => {
  it("null + type → nullable true", () => {
    const s1 = inferSchema({ a: "x" });
    const s2 = mergeSchema(s1, { a: null });
    expect(s2.properties?.a.nullable).toBe(true);
    expect(s2.properties?.a.type).toBe("string");
  });
  it("type + null (reverse order)", () => {
    const s1 = inferSchema({ a: null });
    const s2 = mergeSchema(s1, { a: "x" });
    expect(s2.properties?.a.nullable).toBe(true);
    expect(s2.properties?.a.type).toBe("string");
  });
});

describe("mergeSchema — type widening", () => {
  it("integer + number → number", () => {
    const s1 = inferSchema({ a: 1 });
    const s2 = mergeSchema(s1, { a: 1.5 });
    expect(s2.properties?.a.type).toBe("number");
  });
  it("string + number → anyOf", () => {
    const s1 = inferSchema({ a: "x" });
    const s2 = mergeSchema(s1, { a: 1 });
    expect(s2.properties?.a.anyOf).toBeDefined();
    expect(s2.properties?.a.anyOf?.length).toBe(2);
  });
  it("anyOf dedupe across multiple samples", () => {
    let s = inferSchema({ a: "x" });
    s = mergeSchema(s, { a: 1 });
    s = mergeSchema(s, { a: "y" }); // already have string
    expect(s.properties?.a.anyOf?.length).toBe(2);
  });
  it("anyOf dedupe distinguishes nested object shapes", () => {
    // Regression: canonicalKey must recurse — not drop nested property names.
    let s = inferSchema({ a: { k1: "x" } });
    s = mergeSchema(s, { a: 1 });               // anyOf: [object{k1}, integer]
    s = mergeSchema(s, { a: { k2: "y" } });     // object{k2} must NOT collapse onto object{k1}
    const anyOf = s.properties?.a.anyOf;
    expect(anyOf).toBeDefined();
    const objectVariants = anyOf!.filter((v) => v.type === "object");
    // Each distinct object shape is kept (either as two variants, or as one merged variant —
    // but NOT as one arbitrary variant that silently dropped the other's keys).
    const allKeys = new Set<string>();
    for (const v of objectVariants) {
      for (const k of Object.keys(v.properties ?? {})) allKeys.add(k);
    }
    expect(allKeys.has("k1") && allKeys.has("k2")).toBe(true);
  });
});

describe("mergeSchema — arrays", () => {
  it("array items merge across samples", () => {
    const s1 = inferSchema({ list: [{ id: "a" }] });
    const s2 = mergeSchema(s1, { list: [{ id: "b", x: 1 }] });
    expect(s2.properties?.list.type).toBe("array");
    expect(s2.properties?.list.items?.properties?.id).toEqual({ type: "string" });
    expect(s2.properties?.list.items?.properties?.x).toEqual({ type: "integer" });
    expect(s2.properties?.list.items?.required).toEqual(["id"]);
  });
});

describe("mergeSchema — from null baseline", () => {
  it("null existing returns inferred", () => {
    expect(mergeSchema(null, { a: 1 })).toEqual({
      type: "object",
      properties: { a: { type: "integer" } },
      required: ["a"],
    });
  });
});

describe("mergeTwoSchemas — convergence on the Gmail example from spec", () => {
  it("merges three message-list responses correctly", () => {
    const s1 = inferSchema({ messages: [{ id: "1", from: "a", subject: "s" }] });
    const s2 = mergeSchema(s1, {
      messages: [{ id: "2", from: "b", subject: "s2", labels: ["x"], snippet: "..." }],
    });
    const s3 = mergeSchema(s2, {
      messages: [{ id: "3", from: "c", subject: "s3", snippet: "...", isUnread: true }],
    });

    const msg = s3.properties?.messages.items;
    expect(msg?.required).toEqual(["from", "id", "subject"]);
    expect(msg?.properties?.labels).toBeDefined();
    expect(msg?.properties?.snippet).toBeDefined();
    expect(msg?.properties?.isUnread).toBeDefined();
  });
});
