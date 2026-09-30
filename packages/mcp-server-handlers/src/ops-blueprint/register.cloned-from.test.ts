/**
 * ggui#1570 emit step — a copied row says it is a copy. The operator door
 * (`ggui_ops_register_blueprint`) and the in-process generated-bytes entry
 * (`createRegisterGeneratedBlueprint`), which parses the same input, take
 * `clonedFrom`: the id of the row whose bytes they register. The durable row
 * carries it. One refusal covers an empty id, the row's own id, a row the
 * store does not hold and a row of another app, with the same answer for the
 * last two, so the refusal is no oracle about another app's rows. Refused
 * before anything is persisted.
 */
import { InMemoryBlueprintStore } from "@ggui-ai/mcp-server-core/in-memory";
import type { Blueprint, DataContract } from "@ggui-ai/protocol";
import { blueprintKey } from "@ggui-ai/protocol/blueprint-key";
import { describe, expect, it } from "vitest";
import type { HandlerContext } from "../types.js";
import { ClonedFromRefusedError } from "./errors.js";
import { createGguiOpsRegisterBlueprintHandler, createRegisterGeneratedBlueprint } from "./register.js";

const CONTRACT: DataContract = { propsSpec: { properties: { title: { schema: { type: "string" } } } } };
const CODE = "export default function R() { return null; }";
const LLM = { kind: "llm", generator: "ui-gen-default", model: "anthropic/claude-haiku-4-5" } as const;
const ctx = (appId: string): HandlerContext => ({ appId, requestId: "req-clone" });

function parentRow(blueprintId: string, appId: string): Blueprint {
  return {
    blueprintId,
    contractHash: blueprintKey(CONTRACT),
    appId,
    codeHash: "0".repeat(64),
    source: LLM,
    variance: {},
    createdAt: "2026-09-30T00:00:00.000Z",
    createdBy: "operator",
    contract: CONTRACT,
  };
}

const INPUT = { contract: CONTRACT, componentCode: CODE, persona: "control-clone" };

async function world(opts: { mint?: string } = {}) {
  const blueprintStore = new InMemoryBlueprintStore();
  await blueprintStore.put(parentRow("bp_parent", "app-1"));
  await blueprintStore.put(parentRow("bp_foreign", "app-2"));
  const deps = { blueprintStore, ...(opts.mint !== undefined ? { mintBlueprintId: () => opts.mint! } : {}) };
  const generated = createRegisterGeneratedBlueprint(deps);
  const door = createGguiOpsRegisterBlueprintHandler(deps);
  /** Both paths, one input: the generated entry with its bytes, and the operator door as the wire reaches it. */
  const paths = {
    generated: (clonedFrom: string | undefined, appId = "app-1") =>
      generated({ ...INPUT, ...(clonedFrom !== undefined ? { clonedFrom } : {}) }, { sourceCode: "authored", source: LLM }, ctx(appId)),
    door: (clonedFrom: string | undefined, appId = "app-1") =>
      door.handler({ ...INPUT, ...(clonedFrom !== undefined ? { clonedFrom } : {}) }, ctx(appId)),
  } as const;
  return { blueprintStore, paths };
}


describe.each(["generated", "door"] as const)("clonedFrom on the %s path (ggui#1570 emit)", (path) => {
  it("a copy names its parent: the durable row carries clonedFrom, and the parent is untouched", async () => {
    const { blueprintStore, paths } = await world();
    const out = await paths[path]("bp_parent");
    expect((await blueprintStore.get(out.blueprintId))?.clonedFrom).toBe("bp_parent");
    expect((await blueprintStore.get("bp_parent"))?.clonedFrom).toBeUndefined();
  });

  it("a registration that names no parent carries no clonedFrom (absent is not 'produced here')", async () => {
    const { blueprintStore, paths } = await world();
    const out = await paths[path](undefined);
    expect((await blueprintStore.get(out.blueprintId))?.clonedFrom).toBeUndefined();
  });

  it("refuses an empty id, a missing row, another app's row and the row's own id, persisting nothing", async () => {
    const cases: Array<[string, string, string | undefined]> = [
      ["empty", "", undefined],
      ["missing", "bp_nowhere", undefined],
      ["another app's", "bp_foreign", undefined],
      ["its own id", "bp_parent", "bp_parent"],
    ];
    for (const [label, clonedFrom, mint] of cases) {
      const { blueprintStore, paths } = await world(mint !== undefined ? { mint } : {});
      const before = (await blueprintStore.listAllForApp("app-1")).length;
      await expect(paths[path](clonedFrom), label).rejects.toBeInstanceOf(ClonedFromRefusedError);
      expect((await blueprintStore.listAllForApp("app-1")).length, label).toBe(before);
    }
  });

  it("another app's row and a missing row get the same answer: the refusal is no oracle", async () => {
    const { paths } = await world();
    const message = async (clonedFrom: string) =>
      paths[path](clonedFrom).then(
        () => "resolved",
        (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
      );
    const foreign = await message("bp_foreign");
    const missing = await message("bp_nowhere");
    expect(foreign).not.toBe("resolved");
    expect(foreign.replace("bp_foreign", "<id>")).toBe(missing.replace("bp_nowhere", "<id>"));
  });
});
