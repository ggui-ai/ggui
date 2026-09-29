import {
  InMemoryBlueprintIndex,
  InMemoryBlueprintStore,
  InMemoryCodeStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from "@ggui-ai/mcp-server-core/in-memory";
import { opsRegisterBlueprintInputSchema, type DataContract, type GeneratorBuild } from "@ggui-ai/protocol";
import { blueprintKey, variantKey } from "@ggui-ai/protocol/blueprint-key";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { findBlueprintExact, listBlueprints } from "../renders/blueprint-registry.js";
import type { HandlerContext } from "../types.js";
import { createGguiOpsRegisterBlueprintHandler, createRegisterGeneratedBlueprint } from "./register.js";

function makeCtx(appId: string): HandlerContext {
  return { appId, requestId: "req-1" };
}

const SAMPLE_CONTRACT: DataContract = {
  propsSpec: {
    description: "register-test contract",
    properties: {
      title: {
        schema: { type: "string" },
        required: false,
        description: "optional title",
      },
    },
  },
};
const SAMPLE_CODE = "export default function R() { return null; }";

describe("createGguiOpsRegisterBlueprintHandler", () => {
  it("persists operator-supplied componentCode verbatim with source {kind:'user'}", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
    });

    const result = await handler.handler(
      {
        contract: SAMPLE_CONTRACT,
        componentCode: SAMPLE_CODE,
      },
      makeCtx("app-1")
    );

    expect(typeof result.blueprintId).toBe("string");
    expect(result.blueprintId.length).toBeGreaterThan(0);
    // Provenance is STRUCTURAL on this path — no engine claim exists
    // for operator-supplied bytes, and the handler stamps no slug.
    expect(result.source).toEqual({ kind: "user" });

    // codeHash = full sha256 of the literal componentCode bytes —
    // operator-supplied, no LLM amendment.
    const expectedCodeHash = createHash("sha256").update(SAMPLE_CODE).digest("hex");
    expect(result.codeHash).toBe(expectedCodeHash);

    // Blueprint landed in the store with the canonical contract hash
    // and the user-arm provenance.
    const stored = await blueprintStore.get(result.blueprintId);
    expect(stored).not.toBeNull();
    expect(stored!.contractHash).toBe(blueprintKey(SAMPLE_CONTRACT));
    expect(stored!.codeHash).toBe(expectedCodeHash);
    expect(stored!.source).toEqual({ kind: "user" });
    expect(stored!.createdBy).toBe("operator");
    expect(stored!.contract).toEqual(SAMPLE_CONTRACT);
  });

  it("dual-writes into the cache vectorStore so matchBlueprint exact-key finds it", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const vectorStore = new InMemoryVectorStore();
    const embedding = new MockEmbeddingProvider();
    const index = new InMemoryBlueprintIndex();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
      cacheRegistry: { embedding, vectorStore, index },
    });

    await handler.handler(
      {
        contract: SAMPLE_CONTRACT,
        componentCode: SAMPLE_CODE,
        seedPrompt: "a small register-test card",
      },
      makeCtx("app-1")
    );

    const expectedKey = blueprintKey(SAMPLE_CONTRACT);
    // `seedPrompt` is a variance key: the cache row carries the SAME variance as
    // the MVB row, so the exact-key probe must ask under that variant key — the
    // default-variant key holds nothing for this registration.
    const found = await findBlueprintExact({ vectorStore, index }, "app-1", "template", expectedKey, variantKey({ seedPrompt: "a small register-test card" }));
    expect(found).not.toBeNull();
    expect(found!.contractKey).toBe(expectedKey);
    expect(found!.componentCode).toBe(SAMPLE_CODE);
    expect(found!.contract).toEqual(SAMPLE_CONTRACT);
    // One handler call, ONE provenance claim across both stores — the
    // cache mirror carries the same user arm as the MVB row.
    expect(found!.source).toEqual({ kind: "user" });
    await expect(findBlueprintExact({ vectorStore, index }, "app-1", "template", expectedKey)).resolves.toBeNull();
  });

  it("binds the cache index under the registration's OWN variance key — a variant registers beside the base, never on top of it", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const vectorStore = new InMemoryVectorStore();
    const embedding = new MockEmbeddingProvider();
    const index = new InMemoryBlueprintIndex();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
      cacheRegistry: { embedding, vectorStore, index },
    });
    const contractKey = blueprintKey(SAMPLE_CONTRACT);
    const baseKey = `template:${contractKey}:${variantKey(undefined)}`;
    const variantKeyOf = (v: { aesthetic: string }) => `template:${contractKey}:${variantKey(v)}`;

    // The base take holds the default-variant key. (The index binds the handler's
    // own id since ggui#1497; it is still read for WHAT it holds, so this case
    // pins the variance binding, not the id.)
    await handler.handler({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE }, makeCtx("app-1"));
    const baseCacheId = await index.getId("app-1", baseKey);
    expect(baseCacheId).not.toBeNull();
    await expect(index.getId("app-1", variantKeyOf({ aesthetic: "hero-fill" }))).resolves.toBeNull();

    // A second take of the SAME contract under a named variance registers at ITS key;
    // the base keeps its binding, and the durable row and the cache row agree on the variance.
    await handler.handler(
      { contract: SAMPLE_CONTRACT, componentCode: "export default function V() { return null; }", aesthetic: "hero-fill" },
      makeCtx("app-1")
    );
    const variantCacheId = await index.getId("app-1", variantKeyOf({ aesthetic: "hero-fill" }));
    expect(variantCacheId).not.toBeNull();
    expect(variantCacheId).not.toBe(baseCacheId);
    await expect(index.getId("app-1", baseKey)).resolves.toBe(baseCacheId);
    const cached = await findBlueprintExact({ vectorStore, index }, "app-1", "template", contractKey, variantKey({ aesthetic: "hero-fill" }));
    expect(cached).not.toBeNull();
    expect(cached!.variance).toEqual({ aesthetic: "hero-fill" });
    expect(cached!.componentCode).toBe("export default function V() { return null; }");
    const baseCached = await findBlueprintExact({ vectorStore, index }, "app-1", "template", contractKey);
    expect(baseCached!.componentCode).toBe(SAMPLE_CODE);
  });

  it("rejects a `generator` input key — the slug-stamping surface is gone", async () => {
    // The retired input field used to fabricate an engine claim
    // (registry-default slug) for hand-authored bytes. The strict
    // schema now refuses it outright.
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
    });

    await expect(
      handler.handler(
        {
          contract: SAMPLE_CONTRACT,
          componentCode: SAMPLE_CODE,
          generator: "ui-gen-imported-from-prod",
        },
        makeCtx("app-1")
      )
    ).rejects.toThrow();
  });

  it("pins as operator default when requested", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
    });

    const result = await handler.handler(
      {
        contract: SAMPLE_CONTRACT,
        componentCode: SAMPLE_CODE,
        setAsOperatorDefault: true,
      },
      makeCtx("app-1")
    );

    const stored = await blueprintStore.get(result.blueprintId);
    expect(stored!.isOperatorDefault).toBe(true);
  });

  it("persists variance tags (persona normalized, aesthetic/context/seedPrompt verbatim)", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
    });

    const result = await handler.handler(
      {
        contract: SAMPLE_CONTRACT,
        componentCode: SAMPLE_CODE,
        persona: "  Minimalist  ",
        aesthetic: "glassmorphic",
        context: { theme: "dark" },
        seedPrompt: "minimal info card",
      },
      makeCtx("app-1")
    );

    const stored = await blueprintStore.get(result.blueprintId);
    expect(stored!.variance).toEqual({
      persona: "minimalist",
      aesthetic: "glassmorphic",
      context: { theme: "dark" },
      seedPrompt: "minimal info card",
    });
  });

  it("throws when ctx.appId is missing", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
    });
    await expect(
      handler.handler(
        { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
        { appId: "", requestId: "req-1" }
      )
    ).rejects.toThrow(/missing caller identity/);
  });

  it("swallows cache-mirror failures and emits telemetry", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const failingVectorStore = new InMemoryVectorStore();
    // Force putVector to reject so the mirror write throws.
    failingVectorStore.putVector = async () => {
      throw new Error("synthetic cache-mirror failure");
    };
    const events: Array<{
      name: string;
      attributes: Readonly<Record<string, string | number | boolean>> | undefined;
    }> = [];
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
      cacheRegistry: {
        embedding: new MockEmbeddingProvider(),
        vectorStore: failingVectorStore,
        index: new InMemoryBlueprintIndex(),
      },
      telemetry: {
        emit(event) {
          events.push({ name: event.name, attributes: event.attributes });
        },
      },
    });

    // Primary write succeeds even though the mirror fails.
    const result = await handler.handler(
      { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
      makeCtx("app-1")
    );
    expect(typeof result.blueprintId).toBe("string");

    const stored = await blueprintStore.get(result.blueprintId);
    expect(stored).not.toBeNull();

    // Telemetry captured the mirror-write failure.
    const mirrorFailed = events.find((e) => e.name === "blueprint.cache_mirror_failed");
    expect(mirrorFailed).toBeDefined();
    expect(String(mirrorFailed!.attributes?.errorMessage ?? "")).toContain(
      "synthetic cache-mirror failure"
    );
  });
});

describe("createGguiOpsRegisterBlueprintHandler — appId input + authorizer", () => {
  it("explicit appId equal to ctx.appId resolves (seam unbound)", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({ blueprintStore });
    const result = await handler.handler(
      { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, appId: "app-1" },
      makeCtx("app-1")
    );
    expect(typeof result.blueprintId).toBe("string");
  });

  it("explicit differing appId with NO authorizer fails closed with cross_app_curation_unavailable", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({ blueprintStore });
    await expect(
      handler.handler(
        { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, appId: "other-app" },
        makeCtx("app-1")
      )
    ).rejects.toThrow(/cross_app_curation_unavailable/);
  });

  it("bound authorizer is consulted even when the input is omitted", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const authorizeAppAccess = vi.fn(async () => ({ allowed: true as const }));
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      authorizeAppAccess,
    });
    await handler.handler(
      { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
      makeCtx("app-1")
    );
    expect(authorizeAppAccess).toHaveBeenCalledTimes(1);
  });

  it("authorizer-approved cross-app call persists the row's appId as the EXPLICIT one", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      authorizeAppAccess: async () => ({ allowed: true as const }),
    });
    const result = await handler.handler(
      { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, appId: "other-app" },
      makeCtx("app-1")
    );
    const persisted = await blueprintStore.get(result.blueprintId);
    expect(persisted?.appId).toBe("other-app");
  });

  it("authorizer not_owner denial surfaces the denial error", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      authorizeAppAccess: async () => ({ allowed: false as const, reason: "not_owner" as const }),
    });
    await expect(
      handler.handler(
        { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, appId: "other-app" },
        makeCtx("app-1")
      )
    ).rejects.toThrow(/not curatable/);
  });
});

// ggui#1275 — the cache mirror says when its intent is a stand-in. A seed
// prompt describes the UI (authored); a persona describes the agent, and the
// placeholder describes nothing (fallback — never offered to the judge).
describe("ggui_ops_register_blueprint — the cache mirror's intentSource (ggui#1275)", () => {
  it.each([
    [{ seedPrompt: "a small register-test card" }, undefined],
    [{ persona: "data-dense" }, "fallback"],
    [{}, "fallback"],
  ] as const)("%j mirrors intentSource %s", async (hints, expected) => {
    const cacheRegistry = {
      embedding: new MockEmbeddingProvider(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
    };
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
      cacheRegistry,
    });
    await handler.handler({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, ...hints }, makeCtx("app-1"));
    const rows = await listBlueprints(cacheRegistry, "app-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.intentSource).toBe(expected);
  });
});

describe("ggui_ops_register_blueprint — the fit facts and the non-identity intent (ggui#1427)", () => {
  function deps() {
    const blueprintStore = new InMemoryBlueprintStore();
    const vectorStore = new InMemoryVectorStore();
    const embedding = new MockEmbeddingProvider();
    const index = new InMemoryBlueprintIndex();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => { blueprintStore.putCode(codeHash, body); },
      cacheRegistry: { embedding, vectorStore, index },
    });
    return { handler, vectorStore, index };
  }

  it("stores the four on the cache row: intent makes the row authored; judgedCanvases, aestheticPreset and directionDigest read back", async () => {
    const { handler, vectorStore, index } = deps();
    await handler.handler(
      {
        contract: SAMPLE_CONTRACT,
        componentCode: SAMPLE_CODE,
        intent: "rate the meal you just had",
        judgedCanvases: ["xs-chat-card", "md"],
        aestheticPreset: { id: "editorial", version: "3" },
        directionDigest: "a".repeat(64),
      },
      makeCtx("app-1")
    );
    const found = await findBlueprintExact({ vectorStore, index }, "app-1", "template", blueprintKey(SAMPLE_CONTRACT));
    expect(found).not.toBeNull();
    expect(found!.intent).toBe("rate the meal you just had");
    expect(found!.intentSource).toBeUndefined();
    expect(found!.judgedCanvases).toEqual(["xs-chat-card", "md"]);
    expect(found!.aestheticPreset).toEqual({ id: "editorial", version: "3" });
    expect(found!.directionDigest).toBe("a".repeat(64));
  });

  it("stores nothing for absent inputs — the row reads not-evaluated for every fact, and a persona-only intent stays a fallback", async () => {
    const { handler, vectorStore, index } = deps();
    await handler.handler({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, persona: "minimalist" }, makeCtx("app-1"));
    const found = await findBlueprintExact({ vectorStore, index }, "app-1", "template", blueprintKey(SAMPLE_CONTRACT), variantKey({ persona: "minimalist" }));
    expect(found).not.toBeNull();
    expect(found!.intentSource).toBe("fallback");
    expect(found!.judgedCanvases).toBeUndefined();
    expect(found!.aestheticPreset).toBeUndefined();
    expect(found!.directionDigest).toBeUndefined();
  });

  it("intent is not part of the cache identity: two registrations that differ only in intent share the variant key and dedupe", async () => {
    const { handler, index } = deps();
    await handler.handler({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, intent: "rate the meal" }, makeCtx("app-1"));
    await handler.handler({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, intent: "score tonight's dinner" }, makeCtx("app-1"));
    const ids = await Promise.all([
      index.getId("app-1", `template:${blueprintKey(SAMPLE_CONTRACT)}:${variantKey(undefined)}`),
    ]);
    expect(ids[0]).toBeTruthy();
  });
});

describe("ggui_ops_register_blueprint — an empty judgedCanvases is refused at the door (ggui#1427, protocol's review)", () => {
  it("rejects `judgedCanvases: []` — unknown is omission; a declared empty list would mint a card no request can ever fit", () => {
    const parsed = opsRegisterBlueprintInputSchema.safeParse({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, judgedCanvases: [] });
    expect(parsed.success).toBe(false);
    expect(opsRegisterBlueprintInputSchema.safeParse({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, judgedCanvases: ["md"] }).success).toBe(true);
    expect(opsRegisterBlueprintInputSchema.safeParse({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE }).success).toBe(true);
  });
});

describe("ggui_ops_register_blueprint — directionScope (cto on ggui#1427)", () => {
  it("accepts `app` and `request`, refuses any other spelling, and stores the scope beside the digest", async () => {
    const base = { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, directionDigest: "a".repeat(64) };
    expect(opsRegisterBlueprintInputSchema.safeParse({ ...base, directionScope: "app" }).success).toBe(true);
    expect(opsRegisterBlueprintInputSchema.safeParse({ ...base, directionScope: "request" }).success).toBe(true);
    expect(opsRegisterBlueprintInputSchema.safeParse({ ...base, directionScope: "item" }).success).toBe(false);
    const blueprintStore = new InMemoryBlueprintStore();
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => { blueprintStore.putCode(codeHash, body); },
      cacheRegistry: { embedding: new MockEmbeddingProvider(), vectorStore, index },
    });
    await handler.handler({ ...base, directionScope: "request" }, makeCtx("app-1"));
    const found = await findBlueprintExact({ vectorStore, index }, "app-1", "template", blueprintKey(SAMPLE_CONTRACT));
    expect(found!.directionDigest).toBe("a".repeat(64));
    expect(found!.directionScope).toBe("request");
  });
  it("a scope sent without a digest is refused at the door (a scope for nothing); a digest without a scope is accepted", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const handler = createGguiOpsRegisterBlueprintHandler({
      blueprintStore,
      putCode: (codeHash, body) => { blueprintStore.putCode(codeHash, body); },
      cacheRegistry: { embedding: new MockEmbeddingProvider(), vectorStore, index },
    });
    await expect(
      handler.handler({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, directionScope: "app" }, makeCtx("app-1")),
    ).rejects.toThrow(/directionScope/);
    expect(await blueprintStore.get("bp_missing")).toBeNull();
    await handler.handler({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, directionDigest: "b".repeat(64) }, makeCtx("app-1"));
    const found = await findBlueprintExact({ vectorStore, index }, "app-1", "template", blueprintKey(SAMPLE_CONTRACT));
    expect(found!.directionDigest).toBe("b".repeat(64));
    expect(found).not.toHaveProperty("directionScope");
  });
});

// ggui#1493 — the in-process "register generated bytes" path (#1477's
// source half): an in-process caller that holds a generation's compiled
// output registers it WITH the authored source it was compiled from, so a
// render that reuses the registration can serve that source. Not on any wire; the public
// operator door stays source-free.
describe("createRegisterGeneratedBlueprint — generated bytes with their authored source (ggui#1493)", () => {
  const GENERATED_SOURCE = "export default function R() { return <div>authored</div>; }";
  const LLM_SOURCE = { kind: "llm", generator: "ui-gen-default", model: "anthropic/claude-haiku-4-5" } as const;

  function makeCache(withCodeStore: boolean) {
    const codeStore = new InMemoryCodeStore();
    const cacheRegistry = {
      embedding: new MockEmbeddingProvider(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
      // A code store with no durable blueprint store: the narrowest
      // durability that carries an authored source, and the shape a
      // deployment may give the ops mirror. (With a blueprint store the
      // mirror would ALSO write the durable record keyed by the served id.)
      ...(withCodeStore ? { durability: { codeStore } } : {}),
    };
    return { codeStore, cacheRegistry };
  }

  it("records full llm provenance on the durable row, and the cache row carries the source hash with the body stored", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const { codeStore, cacheRegistry } = makeCache(true);
    const register = createRegisterGeneratedBlueprint({ blueprintStore, cacheRegistry });

    const out = await register(
      { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
      { sourceCode: GENERATED_SOURCE, source: LLM_SOURCE },
      makeCtx("app-1"),
    );

    expect(out.source).toEqual(LLM_SOURCE);
    const stored = await blueprintStore.get(out.blueprintId);
    expect(stored!.source).toEqual(LLM_SOURCE);
    expect(stored!.createdBy).toBe("operator");

    const row = await findBlueprintExact(cacheRegistry, "app-1", "template", blueprintKey(SAMPLE_CONTRACT));
    expect(row).not.toBeNull();
    expect(row!.source).toEqual(LLM_SOURCE);
    expect(row!.sourceCodeHash).toBe(codeStore.hashOf(GENERATED_SOURCE));
    expect(await codeStore.get(codeStore.hashOf(GENERATED_SOURCE))).toBe(GENERATED_SOURCE);
  });

  it("writes no source hash when no code store is bound — honest absence, never a guess — control", async () => {
    const { cacheRegistry } = makeCache(false);
    const register = createRegisterGeneratedBlueprint({ blueprintStore: new InMemoryBlueprintStore(), cacheRegistry });
    await register(
      { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
      { sourceCode: GENERATED_SOURCE, source: LLM_SOURCE },
      makeCtx("app-1"),
    );
    const row = await findBlueprintExact(cacheRegistry, "app-1", "template", blueprintKey(SAMPLE_CONTRACT));
    expect(row!.sourceCodeHash).toBeUndefined();
  });

  it("records no source for a pair whose source is byte-identical to the compiled code — the registry's collapse rule — control", async () => {
    const { cacheRegistry } = makeCache(true);
    const register = createRegisterGeneratedBlueprint({ blueprintStore: new InMemoryBlueprintStore(), cacheRegistry });
    await register(
      { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
      { sourceCode: SAMPLE_CODE, source: LLM_SOURCE },
      makeCtx("app-1"),
    );
    const row = await findBlueprintExact(cacheRegistry, "app-1", "template", blueprintKey(SAMPLE_CONTRACT));
    expect(row!.sourceCodeHash).toBeUndefined();
  });

  it("refuses provenance the protocol's llm source schema rejects, before anything is persisted", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const register = createRegisterGeneratedBlueprint({ blueprintStore });
    // Type-valid (`ui-gen-${string}`) but no generator identity: the
    // pattern requires a tier token after the prefix.
    const notAGenerator = { kind: "llm", generator: "ui-gen-", model: "anthropic/claude-haiku-4-5" } as const;
    await expect(
      register(
        { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
        { sourceCode: GENERATED_SOURCE, source: notAGenerator },
        makeCtx("app-1"),
      ),
    ).rejects.toThrow();
    expect(await blueprintStore.listAllForApp("app-1")).toEqual([]);
  });

  it("refuses an empty source before anything is persisted", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const register = createRegisterGeneratedBlueprint({ blueprintStore });
    await expect(
      register(
        { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
        { sourceCode: "", source: LLM_SOURCE },
        makeCtx("app-1"),
      ),
    ).rejects.toThrow();
    expect(await blueprintStore.listAllForApp("app-1")).toEqual([]);
  });

  // ggui#1280 — a bootstrap bind registers a generation mint's bytes here,
  // so the mint's build rides with them onto the durable rows.
  const BUILD: GeneratorBuild = {
    version: "0.25.0",
    mode: "constrained",
    digests: { promptTemplateSha256: "a".repeat(64), boilerplateTemplateSha256: "b".repeat(64) },
  };

  it("stamps the mint's build on the durable row, and on the row a mirror writes through to a separate durable store under the same id (ggui#1280)", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const durableMirror = new InMemoryBlueprintStore();
    const { cacheRegistry } = makeCache(false);
    const register = createRegisterGeneratedBlueprint({
      blueprintStore,
      cacheRegistry: { ...cacheRegistry, durability: { blueprintStore: durableMirror } },
    });
    const out = await register(
      { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
      { sourceCode: GENERATED_SOURCE, source: LLM_SOURCE, build: BUILD },
      makeCtx("app-1"),
    );
    expect((await blueprintStore.get(out.blueprintId))?.build).toEqual(BUILD);
    const mirrored = await durableMirror.list("app-1", blueprintKey(SAMPLE_CONTRACT));
    expect(mirrored.map((b) => b.blueprintId)).toEqual([out.blueprintId]);
    expect(mirrored[0]?.build).toEqual(BUILD);
  });

  it("drops a stamp that fails the build schema, registers the row unstamped, and says so (ggui#1280)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const blueprintStore = new InMemoryBlueprintStore();
      const register = createRegisterGeneratedBlueprint({ blueprintStore });
      const notABuild = { ...BUILD, digests: { promptTemplateSha256: "short", boilerplateTemplateSha256: "b".repeat(64) } };
      const out = await register(
        { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
        { sourceCode: GENERATED_SOURCE, source: LLM_SOURCE, build: notABuild },
        makeCtx("app-1"),
      );
      expect(await blueprintStore.get(out.blueprintId)).not.toHaveProperty("build");
      expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("blueprint_build_stamp_dropped"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("writes no build when the mint reported none (ggui#1280) — control", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const register = createRegisterGeneratedBlueprint({ blueprintStore });
    const out = await register(
      { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE },
      { sourceCode: GENERATED_SOURCE, source: LLM_SOURCE },
      makeCtx("app-1"),
    );
    expect(await blueprintStore.get(out.blueprintId)).not.toHaveProperty("build");
  });

  it("the operator door's schema names no build field — control", () => {
    const parsed = opsRegisterBlueprintInputSchema.safeParse({ contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, build: BUILD });
    expect(parsed.success).toBe(false);
  });

  it("the public operator door stays source-free: its strict schema refuses a sourceCode field — control", () => {
    const parsed = opsRegisterBlueprintInputSchema.safeParse({
      contract: SAMPLE_CONTRACT,
      componentCode: SAMPLE_CODE,
      sourceCode: GENERATED_SOURCE,
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * ggui#1497 — where a re-mint reads, per deployment shape. A re-mint reads a
 * durable row by the SERVED id, then the body by that row's `codeHash`.
 *
 * - `pod`: one durable store; the writer's `putCode` feeds the code store
 *   re-mint reads; the mirror carries the code store only.
 * - `separate`: the writer's store (ops list) is not the store re-mint reads
 *   (`durableBlueprints`), which the mirror writes through to — a server
 *   that keeps them apart, as `createGguiServer` does by default.
 * - `shared`: the mirror writes through to the writer's own store.
 */
type Shape = "pod" | "separate" | "shared";

function world(shape: Shape) {
  const writerStore = new InMemoryBlueprintStore();
  const remintStore = shape === "separate" ? new InMemoryBlueprintStore() : writerStore;
  const codeStore = new InMemoryCodeStore();
  const cacheRegistry = {
    embedding: new MockEmbeddingProvider(),
    vectorStore: new InMemoryVectorStore(),
    index: new InMemoryBlueprintIndex(),
    durability: shape === "pod" ? { codeStore } : { blueprintStore: remintStore, codeStore },
  };
  const emitted: string[] = [];
  const handler = createGguiOpsRegisterBlueprintHandler({
    blueprintStore: writerStore,
    putCode: (codeHash, body) => {
      // The pod's writer feeds the store re-mint reads; the in-memory writer
      // keeps its own map.
      if (shape === "pod") void codeStore.put(codeHash, body);
      else writerStore.putCode(codeHash, body);
    },
    cacheRegistry,
    telemetry: { emit: (event: { name: string }) => void emitted.push(event.name) },
  });
  return { writerStore, remintStore, codeStore, cacheRegistry, emitted, handler };
}

async function register(w: ReturnType<typeof world>, seedPrompt = "a card"): Promise<string> {
  const out = (await w.handler.handler(
    { contract: SAMPLE_CONTRACT, componentCode: SAMPLE_CODE, seedPrompt },
    makeCtx("app-1")
  )) as { blueprintId: string };
  return out.blueprintId;
}

async function servedId(w: ReturnType<typeof world>, seedPrompt = "a card"): Promise<string | undefined> {
  const served = await findBlueprintExact(
    w.cacheRegistry,
    "app-1",
    "template",
    blueprintKey(SAMPLE_CONTRACT),
    variantKey({ seedPrompt })
  );
  return served?.id;
}

describe("ggui_ops_register_blueprint — one id per registration, and a re-mint of the served id resolves (ggui#1497)", () => {
  for (const shape of ["pod", "separate", "shared"] as const) {
    it(`${shape}: the cache serves the returned id; the re-mint store holds its row and body; the ops list has one row`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const w = world(shape);
        const id = await register(w);
        expect(await servedId(w)).toBe(id);
        // Both halves of a re-mint: the row by the served id, the body by its codeHash.
        const row = await w.remintStore.get(id);
        expect(row?.blueprintId).toBe(id);
        expect(row?.codeHash).toBeDefined();
        expect(await w.codeStore.get(row?.codeHash ?? "")).toBe(SAMPLE_CODE);
        expect((await w.writerStore.listAllForApp("app-1")).map((b) => b.blueprintId)).toEqual([id]);
        // A shared store is written once: no refused second put of the row.
        expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("blueprint_durable_write_failed"))).toEqual([]);
        expect(w.emitted).not.toContain("blueprint.cache_mirror_failed");
      } finally {
        warn.mockRestore();
      }
    });
  }

  it("a second registration of the same variant: the cache keeps serving the first id, whose row and body a re-mint finds", async () => {
    const w = world("separate");
    const first = await register(w);
    await register(w);
    expect(await servedId(w)).toBe(first);
    const row = await w.remintStore.get(first);
    expect(await w.codeStore.get(row?.codeHash ?? "")).toBe(SAMPLE_CODE);
  });
});
