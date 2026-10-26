// Pin (ggui#2010): the choice axis reads `offered-items` exactly when some action's payload is ONE key that is a field
// of an offered list's items (the 1-key rule), the key read from the action's schema and its example alike. Each
// clause has a case that breaks only it. The known miss (an action naming two item fields) stays `none`, on record.
import type { DataContract, JsonObject } from "@ggui-ai/protocol";
import { describe, expect, it } from "vitest";
import { classifyAxes } from "./index.js";

const ITEMS = { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } } };

function contract(opts: { props?: JsonObject; schemaKeys?: readonly string[]; example?: JsonObject; noAction?: boolean }): DataContract {
  const schema = opts.schemaKeys === undefined ? undefined : { type: "object", properties: Object.fromEntries(opts.schemaKeys.map((k) => [k, { type: "string" }])) };
  return {
    propsSpec: { properties: opts.props ?? { suggestions: { required: true, schema: ITEMS } } },
    ...(opts.noAction
      ? {}
      : { actionSpec: { pick: { label: "Pick", ...(schema !== undefined ? { schema } : {}), ...(opts.example !== undefined ? { example: opts.example } : {}) } } }),
  } as DataContract;
}

const choice = (c: DataContract) => {
  const r = classifyAxes({ contract: c, prompt: "pick one" });
  return { value: r.vector.choice, source: r.provenance.choice };
};

describe("choice axis — the 1-key rule (ggui#2010)", () => {
  it("one schema key that is an item field: offered-items, from the contract", () => {
    expect(choice(contract({ schemaKeys: ["id"] }))).toEqual({ value: "offered-items", source: "contract" });
  });

  it("one example key that is an item field: offered-items (the example counts as the schema does)", () => {
    expect(choice(contract({ example: { label: "Yes" } })).value).toBe("offered-items");
  });

  it("the same key in schema and example is still one key: offered-items", () => {
    expect(choice(contract({ schemaKeys: ["id"], example: { id: "a" } })).value).toBe("offered-items");
  });

  it("one key that is not an item field: none", () => {
    expect(choice(contract({ schemaKeys: ["reason"] })).value).toBe("none");
  });

  it("schema and example naming different keys make two keys: none", () => {
    expect(choice(contract({ schemaKeys: ["id"], example: { note: "x" } })).value).toBe("none");
  });

  it("known miss, on record: an action naming two item fields stays none", () => {
    expect(choice(contract({ schemaKeys: ["id", "label"] })).value).toBe("none");
  });

  it("one key but no offered list (a scalar prop): none", () => {
    expect(choice(contract({ props: { id: { required: true, schema: { type: "string" } } }, schemaKeys: ["id"] })).value).toBe("none");
  });

  it("no action at all: none, by default", () => {
    expect(choice(contract({ noAction: true }))).toEqual({ value: "none", source: "default" });
  });
});
