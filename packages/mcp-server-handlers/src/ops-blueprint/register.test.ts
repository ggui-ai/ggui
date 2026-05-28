import type {
  GeneratorRegistry,
  UiGenerateInput,
  UiGenerateResult,
  UiGenerator,
} from "@ggui-ai/mcp-server-core";
import {
  InMemoryBlueprintStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
  createInMemoryGeneratorRegistry,
} from "@ggui-ai/mcp-server-core/in-memory";
import type { DataContract } from "@ggui-ai/protocol";
import { blueprintKey } from "@ggui-ai/protocol/blueprint-key";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { findBlueprintExact } from "../renders/blueprint-registry.js";
import type { HandlerContext } from "../types.js";
import { createGguiOpsRegisterBlueprintHandler } from "./register.js";

/**
 * Mock generator just to satisfy the registry. Register never
 * dispatches through it — present here purely so
 * `registry.defaultGenerator().slug` resolves to a known value.
 */
function makeMockGenerator(slug = "ui-gen-default-haiku-4-5"): UiGenerator {
  return {
    slug,
    tier: "default",
    model: "haiku-4-5",
    async generate(_input: UiGenerateInput): Promise<UiGenerateResult> {
      throw new Error("register handler should NEVER dispatch through generator");
    },
  };
}

function makeRegistry(slug = "ui-gen-default-haiku-4-5"): GeneratorRegistry {
  return createInMemoryGeneratorRegistry({ default: makeMockGenerator(slug) });
}

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
  it("persists operator-supplied componentCode verbatim without dispatching a generator", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      registry: makeRegistry(),
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
    expect(result.generator).toBe("ui-gen-default-haiku-4-5");

    // codeHash = full sha256 of the literal componentCode bytes —
    // operator-supplied, no LLM amendment.
    const expectedCodeHash = createHash("sha256").update(SAMPLE_CODE).digest("hex");
    expect(result.codeHash).toBe(expectedCodeHash);

    // Blueprint landed in the store with the canonical contract hash.
    const stored = await blueprintStore.get(result.blueprintId);
    expect(stored).not.toBeNull();
    expect(stored!.contractHash).toBe(blueprintKey(SAMPLE_CONTRACT));
    expect(stored!.codeHash).toBe(expectedCodeHash);
    expect(stored!.createdBy).toBe("operator");
    expect(stored!.contract).toEqual(SAMPLE_CONTRACT);
  });

  it("dual-writes into the cache vectorStore so matchBlueprint exact-key finds it", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const vectorStore = new InMemoryVectorStore();
    const embedding = new MockEmbeddingProvider();
    const handler = createGguiOpsRegisterBlueprintHandler({
      registry: makeRegistry(),
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
      cacheRegistry: { embedding, vectorStore },
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
    const found = await findBlueprintExact({ vectorStore }, "app-1", "template", expectedKey);
    expect(found).not.toBeNull();
    expect(found!.contractKey).toBe(expectedKey);
    expect(found!.componentCode).toBe(SAMPLE_CODE);
    expect(found!.contract).toEqual(SAMPLE_CONTRACT);
  });

  it("honors generator-slug override for the audit/provenance field", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      registry: makeRegistry("ui-gen-default-haiku-4-5"),
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
    });

    // Stamp a different slug on the persisted Blueprint.generator
    // field. The register handler doesn't validate against the
    // registry — operators can stamp arbitrary slugs (audit
    // provenance, not dispatch routing).
    const result = await handler.handler(
      {
        contract: SAMPLE_CONTRACT,
        componentCode: SAMPLE_CODE,
        generator: "ui-gen-imported-from-prod",
      },
      makeCtx("app-1")
    );
    expect(result.generator).toBe("ui-gen-imported-from-prod");

    const stored = await blueprintStore.get(result.blueprintId);
    expect(stored!.generator).toBe("ui-gen-imported-from-prod");
  });

  it("pins as operator default when requested", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const handler = createGguiOpsRegisterBlueprintHandler({
      registry: makeRegistry(),
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
      registry: makeRegistry(),
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
      registry: makeRegistry(),
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
      registry: makeRegistry(),
      blueprintStore,
      putCode: (codeHash, body) => {
        blueprintStore.putCode(codeHash, body);
      },
      cacheRegistry: {
        embedding: new MockEmbeddingProvider(),
        vectorStore: failingVectorStore,
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
