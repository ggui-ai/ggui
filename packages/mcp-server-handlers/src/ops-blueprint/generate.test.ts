import type {
  AppMetadataStore,
  BlueprintProvider,
  GeneratorRegistry,
  UiGenerateInput,
  UiGenerateResult,
  UiGenerator, GenerationMetadata
} from "@ggui-ai/mcp-server-core";
import {
  InMemoryAppMetadataStore,
  InMemoryBlueprintStore,
  createInMemoryGeneratorRegistry,
} from "@ggui-ai/mcp-server-core/in-memory";
import type { Blueprint, DataContract, UIGenerationResponse } from "@ggui-ai/protocol";
import type { GeneratorId } from '@ggui-ai/protocol';
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import { findBlueprintExact, listBlueprints } from '../renders/blueprint-registry.js';
import type { TelemetryEvent } from "@ggui-ai/mcp-server-core";
import { describe, expect, it, vi } from "vitest";
import { GadgetNotRegisteredError } from "../renders/assert-gadgets.js";
import type { GenerationCredentials } from "../renders/index.js";
import type { HandlerContext } from "../types.js";
import {
  GenerationFailedError,
  GeneratorNotFoundError,
  MissingCredentialsError,
} from "./errors.js";
import { createGguiOpsGenerateBlueprintHandler } from "./generate.js";

/**
 * Build a mock UiGenerator that returns a pre-baked componentCode.
 * The slug + tier + model are required by the registry; pick valid
 * fixed-format values.
 */
function makeMockGenerator(
  opts: {
    slug?: GeneratorId;
    componentCode?: string;
    validatorScore?: number;
    fail?: boolean;
    throws?: boolean;
  } = {}
): UiGenerator {
  const componentCode = opts.componentCode ?? "export default function Foo() { return null; }";
  return {
    slug: opts.slug ?? "ui-gen-default",
    tier: "default",
    model: "anthropic/claude-haiku-4-5",
    async generate(_input: UiGenerateInput): Promise<UiGenerateResult> {
      if (opts.throws) {
        throw new Error("mock generator threw");
      }
      if (opts.fail) {
        return {
          ok: false,
          error: {
            code: "PRODUCTION_FAILED",
            message: "mock generator failed",
          },
        };
      }
      const response: UIGenerationResponse = {
        sessionId: "render_mock",
        componentCode,
      };
      const metadata: GenerationMetadata = {
        provider: "anthropic",
        generator: opts.slug ?? "ui-gen-default",
        model: "anthropic/claude-haiku-4-5",
        inputTokens: 100,
        outputTokens: 200,
        latencyMs: 50,
        cacheHit: false,
        ...(opts.validatorScore !== undefined ? { validatorScore: opts.validatorScore } : {}),
      };
      return { ok: true, response, metadata };
    },
  };
}

const fakeBlueprints: BlueprintProvider = {
  async list() {
    return [];
  },
  async get() {
    return null;
  },
};

const fakeCredentials: GenerationCredentials = {
  selection: {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
  },
  providerKey: {
    provider: "anthropic",
    key: "sk-test",
  },
};

function makeCtx(appId: string): HandlerContext {
  return { appId, requestId: "req-1" };
}

function emptyContract(): DataContract {
  return {};
}

function defaultDeps(
  opts: {
    registry?: GeneratorRegistry;
    blueprintStore?: InMemoryBlueprintStore;
    resolveLlm?: (
      ctx: HandlerContext
    ) => Promise<GenerationCredentials | null> | GenerationCredentials | null;
    listAllForApp?: (appId: string) => Promise<readonly Blueprint[]>;
    generator?: UiGenerator;
    appMetadataStore?: AppMetadataStore;
  } = {}
) {
  const generator = opts.generator ?? makeMockGenerator();
  const registry = opts.registry ?? createInMemoryGeneratorRegistry({ default: generator });
  const blueprintStore = opts.blueprintStore ?? new InMemoryBlueprintStore();
  return {
    registry,
    blueprintStore,
    blueprints: fakeBlueprints,
    resolveLlm: opts.resolveLlm ?? (() => fakeCredentials),
    putCode: (codeHash: string, body: string) => {
      blueprintStore.putCode(codeHash, body);
    },
    ...(opts.listAllForApp ? { listAllForApp: opts.listAllForApp } : {}),
    ...(opts.appMetadataStore ? { appMetadataStore: opts.appMetadataStore } : {}),
    now: () => "2026-05-12T00:00:00.000Z",
    mintBlueprintId: (() => {
      let n = 0;
      return () => `bp_test_${++n}`;
    })(),
  };
}

describe("createGguiOpsGenerateBlueprintHandler — declaration", () => {
  it("exposes the canonical tool name", () => {
    const handler = createGguiOpsGenerateBlueprintHandler(defaultDeps());
    expect(handler.name).toBe("ggui_ops_generate_blueprint");
  });

  it("is tagged audience: ops", () => {
    const handler = createGguiOpsGenerateBlueprintHandler(defaultDeps());
    expect(handler.audience).toEqual(["ops"]);
  });
});

describe("createGguiOpsGenerateBlueprintHandler — happy path", () => {
  it("dispatches through the registry default generator", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler({ contract: emptyContract() }, makeCtx("app-1"));
    expect(result.blueprintId).toBe("bp_test_1");
    // Provenance is the llm arm, stamped from the engine's own
    // metadata claim (generator slug + model id).
    expect(result.source).toEqual({
      kind: "llm",
      generator: "ui-gen-default",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(result.codeHash).toBeDefined();
    expect(result.codeHash?.length).toBe(32);
  });

  it("dispatches through an explicit generator slug", async () => {
    const advancedGen = makeMockGenerator({
      slug: "ui-gen-advanced",
      componentCode: "export default function Bar() { return null; }",
      validatorScore: 0.92,
    });
    const registry = createInMemoryGeneratorRegistry({
      default: makeMockGenerator(),
      generators: [advancedGen],
    });
    const deps = defaultDeps({ registry });
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      {
        contract: emptyContract(),
        generator: "ui-gen-advanced",
      },
      makeCtx("app-1")
    );
    expect(result.source).toEqual({
      kind: "llm",
      generator: "ui-gen-advanced",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(result.validatorScore).toBe(0.92);
  });

  it('persists the blueprint with createdBy="operator"', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler({ contract: emptyContract() }, makeCtx("app-1"));
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted).not.toBeNull();
    expect(persisted?.createdBy).toBe("operator");
    expect(persisted?.appId).toBe("app-1");
    // createdBy and source are DIFFERENT axes: operator-initiated,
    // engine-generated.
    expect(persisted?.source).toEqual({
      kind: "llm",
      generator: "ui-gen-default",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(persisted?.contractHash).toBe(blueprintKey(emptyContract()));
  });

  it("normalizes persona to lowercase + trim", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      {
        contract: emptyContract(),
        persona: "  Data-Dense  ",
      },
      makeCtx("app-1")
    );
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted?.variance.persona).toBe("data-dense");
  });

  it("persists seedPrompt and context", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      {
        contract: emptyContract(),
        seedPrompt: "make it red",
        context: { palette: "warm" },
      },
      makeCtx("app-1")
    );
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted?.variance.seedPrompt).toBe("make it red");
    expect(persisted?.variance.context).toEqual({ palette: "warm" });
  });

  it("mirrors the cache row under the REQUESTED variance, never the default sentinel (#697)", async () => {
    const cacheRegistry = {
      embedding: new MockEmbeddingProvider(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
    };
    const deps = { ...defaultDeps(), cacheRegistry };
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const variance = { persona: "data-dense", aesthetic: "editorial" };
    const result = await handler.handler(
      { contract: emptyContract(), ...variance },
      makeCtx("app-1")
    );
    // MVB row carries the full variance incl. aesthetic.
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted?.variance).toEqual(variance);
    // Cache mirror resolves at the requested variantKey…
    const contractKey = blueprintKey(emptyContract());
    const atRequested = await findBlueprintExact(
      cacheRegistry,
      "app-1",
      "template",
      contractKey,
      variantKey(variance)
    );
    expect(atRequested).not.toBeNull();
    expect(atRequested?.variance).toEqual(variance);
    // …and NOT under the default-variant sentinel.
    const atSentinel = await findBlueprintExact(cacheRegistry, "app-1", "template", contractKey);
    expect(atSentinel).toBeNull();
  });

  it("pins as operator default when setAsOperatorDefault=true", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      {
        contract: emptyContract(),
        setAsOperatorDefault: true,
      },
      makeCtx("app-1")
    );
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted?.isOperatorDefault).toBe(true);
  });

  it("clears prior default when setAsOperatorDefault=true", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    // First generation pinned as default
    const first = await handler.handler(
      {
        contract: emptyContract(),
        setAsOperatorDefault: true,
      },
      makeCtx("app-1")
    );
    // Second generation also pinned — should clear first
    const second = await handler.handler(
      {
        contract: emptyContract(),
        persona: "data-dense",
        setAsOperatorDefault: true,
      },
      makeCtx("app-1")
    );
    const firstRow = await deps.blueprintStore.get(first.blueprintId);
    const secondRow = await deps.blueprintStore.get(second.blueprintId);
    expect(firstRow?.isOperatorDefault).toBeUndefined();
    expect(secondRow?.isOperatorDefault).toBe(true);
  });

  it("makes code retrievable via the in-memory putCode hook", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler({ contract: emptyContract() }, makeCtx("app-1"));
    expect(result.codeHash).toBeDefined();
    const code = deps.blueprintStore.getCode(result.codeHash!);
    expect(code).toContain("export default");
  });
});

describe("createGguiOpsGenerateBlueprintHandler — error paths", () => {
  it("throws GeneratorNotFoundError for unknown slug", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler(
        {
          contract: emptyContract(),
          generator: "ui-gen-nonexistent",
        },
        makeCtx("app-1")
      )
    ).rejects.toBeInstanceOf(GeneratorNotFoundError);
  });

  it("throws MissingCredentialsError when resolveLlm returns null", async () => {
    const deps = defaultDeps({
      resolveLlm: () => null,
    });
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler({ contract: emptyContract() }, makeCtx("app-1"))
    ).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it("throws GenerationFailedError when generator returns ok:false", async () => {
    const failingGen = makeMockGenerator({ fail: true });
    const registry = createInMemoryGeneratorRegistry({ default: failingGen });
    const deps = defaultDeps({ registry });
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler({ contract: emptyContract() }, makeCtx("app-1"))
    ).rejects.toBeInstanceOf(GenerationFailedError);
  });

  it("throws GenerationFailedError when generator throws", async () => {
    const throwingGen = makeMockGenerator({ throws: true });
    const registry = createInMemoryGeneratorRegistry({ default: throwingGen });
    const deps = defaultDeps({ registry });
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler({ contract: emptyContract() }, makeCtx("app-1"))
    ).rejects.toBeInstanceOf(GenerationFailedError);
  });

  it("throws when appId is empty", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler({ contract: emptyContract() }, { appId: "", requestId: "req-1" })
    ).rejects.toThrow();
  });
});

describe("createGguiOpsGenerateBlueprintHandler — persona near-dup", () => {
  it("emits a near-duplicate-persona warning via telemetry when distance < 2", async () => {
    // Seed an existing blueprint with persona='minimalist'
    const blueprintStore = new InMemoryBlueprintStore();
    const seed: Blueprint = {
      blueprintId: "bp_seed",
      contractHash: blueprintKey(emptyContract()),
      appId: "app-1",
      source: {
        kind: "llm",
        generator: "ui-gen-default",
        model: "anthropic/claude-haiku-4-5",
      },
      variance: { persona: "minimalist" },
      createdAt: "2026-05-12T00:00:00.000Z",
      createdBy: "operator",
      contract: emptyContract(),
    };
    await blueprintStore.put(seed);

    const emissions: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
    const deps = {
      ...defaultDeps({ blueprintStore }),
      listAllForApp: (appId: string) => blueprintStore.listAllForApp(appId),
      telemetry: {
        emit(event: {
          name: string;
          at: number;
          attributes?: Record<string, string | number | boolean>;
        }) {
          emissions.push({ name: event.name, attributes: event.attributes });
        },
      },
    };
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await handler.handler(
      {
        contract: emptyContract(),
        persona: "minimalst", // distance 1 from 'minimalist'
      },
      makeCtx("app-1")
    );
    const nearDup = emissions.find((e) => e.name === "blueprint.near_duplicate_persona");
    expect(nearDup).toBeDefined();
    expect(nearDup?.attributes?.newPersona).toBe("minimalst");
    expect(nearDup?.attributes?.nearestExisting).toBe("minimalist");
    expect(nearDup?.attributes?.nearestDistance).toBe(1);
  });

  it("does NOT emit a warning when persona is unique", async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const seed: Blueprint = {
      blueprintId: "bp_seed",
      contractHash: blueprintKey(emptyContract()),
      appId: "app-1",
      source: {
        kind: "llm",
        generator: "ui-gen-default",
        model: "anthropic/claude-haiku-4-5",
      },
      variance: { persona: "minimalist" },
      createdAt: "2026-05-12T00:00:00.000Z",
      createdBy: "operator",
      contract: emptyContract(),
    };
    await blueprintStore.put(seed);

    const emissions: Array<{ name: string }> = [];
    const deps = {
      ...defaultDeps({ blueprintStore }),
      listAllForApp: (appId: string) => blueprintStore.listAllForApp(appId),
      telemetry: {
        emit(event: {
          name: string;
          at: number;
          attributes?: Record<string, string | number | boolean>;
        }) {
          emissions.push({ name: event.name });
        },
      },
    };
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await handler.handler(
      {
        contract: emptyContract(),
        persona: "data-dense", // unrelated
      },
      makeCtx("app-1")
    );
    const nearDup = emissions.find((e) => e.name === "blueprint.near_duplicate_persona");
    expect(nearDup).toBeUndefined();
  });
});

describe("createGguiOpsGenerateBlueprintHandler — appId input + authorizer", () => {
  it("explicit appId equal to ctx.appId resolves (seam unbound)", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      { contract: emptyContract(), appId: "app-1" },
      makeCtx("app-1")
    );
    expect(result.blueprintId).toBe("bp_test_1");
  });

  it("explicit differing appId with NO authorizer fails closed with cross_app_curation_unavailable", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler({ contract: emptyContract(), appId: "other-app" }, makeCtx("app-1"))
    ).rejects.toThrow(/cross_app_curation_unavailable/);
  });

  it("bound authorizer is consulted even when the input is omitted", async () => {
    const authorizeAppAccess = vi.fn(async () => ({ allowed: true as const }));
    const handler = createGguiOpsGenerateBlueprintHandler({
      ...defaultDeps(),
      authorizeAppAccess,
    });
    await handler.handler({ contract: emptyContract() }, makeCtx("app-1"));
    expect(authorizeAppAccess).toHaveBeenCalledTimes(1);
  });

  it("authorizer-approved cross-app call persists the row under the EXPLICIT appId", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler({
      ...deps,
      authorizeAppAccess: async () => ({ allowed: true as const }),
    });
    const result = await handler.handler(
      { contract: emptyContract(), appId: "other-app" },
      makeCtx("app-1")
    );
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted?.appId).toBe("other-app");
  });

  it("authorizer not_owner denial surfaces the denial error", async () => {
    const handler = createGguiOpsGenerateBlueprintHandler({
      ...defaultDeps(),
      authorizeAppAccess: async () => ({ allowed: false as const, reason: "not_owner" as const }),
    });
    await expect(
      handler.handler({ contract: emptyContract(), appId: "other-app" }, makeCtx("app-1"))
    ).rejects.toThrow(/not curatable/);
  });

  it("resolveLlm receives the effective appId, not ctx.appId", async () => {
    let seen: string | undefined;
    const resolveLlm = vi.fn((c: HandlerContext) => {
      seen = c.appId;
      return fakeCredentials;
    });
    const deps = defaultDeps({ resolveLlm });
    const handler = createGguiOpsGenerateBlueprintHandler({
      ...deps,
      authorizeAppAccess: async () => ({ allowed: true as const }),
    });
    await handler.handler({ contract: emptyContract(), appId: "other-app" }, makeCtx("app-1"));
    expect(seen).toBe("other-app");
  });

  it("the generator receives the effective appId on UiGenerateInput", async () => {
    // Deployments whose generator meters or bills per app read
    // `UiGenerateInput.appId` to attribute the generation. It must name
    // the app being CURATED — billing the caller's bound app for a
    // cross-app curation would charge the wrong owner.
    const seen: UiGenerateInput[] = [];
    const inner = makeMockGenerator();
    const capturing: UiGenerator = {
      slug: inner.slug,
      tier: inner.tier,
      model: inner.model,
      generate(generateInput: UiGenerateInput): Promise<UiGenerateResult> {
        seen.push(generateInput);
        return inner.generate(generateInput);
      },
    };
    const handler = createGguiOpsGenerateBlueprintHandler({
      ...defaultDeps({ registry: createInMemoryGeneratorRegistry({ default: capturing }) }),
      authorizeAppAccess: async () => ({ allowed: true as const }),
    });
    await handler.handler({ contract: emptyContract(), appId: "other-app" }, makeCtx("app-1"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.appId).toBe("other-app");
    // The generation id the hosted charge path records on the ledger row.
    expect(seen[0]?.request.sessionId).toMatch(/^ops_gen_/);
  });
});

describe("createGguiOpsGenerateBlueprintHandler — appMetadataStore gadget gate", () => {
  it("throws GadgetNotRegisteredError before dispatching the LLM when the contract references a gadget the app hasn't registered", async () => {
    // `InMemoryAppMetadataStore.register("app-1")` with no `gadgets`
    // input resolves to the STDLIB floor only (`resolveAppGadgets` —
    // "app declares no [custom] gadgets"), never truly empty. A
    // contract referencing a non-stdlib export must still reject —
    // same fixture shape as assert-gadgets.test.ts's own
    // `gadget_not_registered` case.
    const appMetadataStore = new InMemoryAppMetadataStore();
    appMetadataStore.register("app-1");
    const generator = vi.fn();
    const registry = createInMemoryGeneratorRegistry({
      default: {
        slug: "ui-gen-default",
        tier: "default",
        model: "anthropic/claude-haiku-4-5",
        generate: generator,
      },
    });
    const deps = defaultDeps({ registry, appMetadataStore });
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: { "@acme/doordash": { useDoorDashCheckout: {} } },
      },
    };
    await expect(handler.handler({ contract }, makeCtx("app-1"))).rejects.toBeInstanceOf(
      GadgetNotRegisteredError,
    );
    // The gate runs BEFORE generator dispatch — no LLM spend on a
    // reject that never reaches the provider.
    expect(generator).not.toHaveBeenCalled();
  });

  it("does not gate on gadgets when no appMetadataStore is bound (unchanged default posture)", async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: { "@acme/doordash": { useDoorDashCheckout: {} } },
      },
    };
    await expect(handler.handler({ contract }, makeCtx("app-1"))).resolves.toBeDefined();
  });
});

describe("createGguiOpsGenerateBlueprintHandler — the generation prompt (#1046)", () => {
  /** A generator that records every input it is dispatched with. */
  function capturingGenerator(): { generator: UiGenerator; seen: UiGenerateInput[] } {
    const base = makeMockGenerator();
    const seen: UiGenerateInput[] = [];
    return {
      seen,
      generator: {
        ...base,
        async generate(input: UiGenerateInput) {
          seen.push(input);
          return base.generate(input);
        },
      },
    };
  }
  function sink(): { telemetry: { emit(event: TelemetryEvent): void }; events: TelemetryEvent[] } {
    const events: TelemetryEvent[] = [];
    return { events, telemetry: { emit: (event) => { events.push(event); } } };
  }
  const BOARD: DataContract = {
    propsSpec: { properties: { columns: { required: true, schema: { type: "array", items: { type: "object" } } } } },
  };

  it("`intent` is the generation prompt, and is never written into the persisted variance", async () => {
    const { generator, seen } = capturingGenerator();
    const { telemetry, events } = sink();
    const deps = { ...defaultDeps({ generator }), telemetry };
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      { contract: BOARD, persona: "planner", intent: "a kanban board for this week" },
      makeCtx("app-1")
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.prompt).toBe("a kanban board for this week");
    expect(events.map((e) => e.name)).not.toContain("blueprint.generate_prompt_placeholder");
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted?.variance).toEqual({ persona: "planner" });
    expect("intent" in (persisted?.variance ?? {})).toBe(false);
  });

  it("identity is untouched: the same call with and without `intent` persists the same variantKey", async () => {
    const depsA = defaultDeps();
    const withIntent = await createGguiOpsGenerateBlueprintHandler(depsA).handler(
      { contract: BOARD, persona: "planner", intent: "a kanban board for this week" },
      makeCtx("app-1")
    );
    const depsB = defaultDeps();
    const without = await createGguiOpsGenerateBlueprintHandler(depsB).handler({ contract: BOARD, persona: "planner" }, makeCtx("app-1"));
    const rowA = await depsA.blueprintStore.get(withIntent.blueprintId);
    const rowB = await depsB.blueprintStore.get(without.blueprintId);
    expect(rowA?.variance).toEqual(rowB?.variance);
    expect(variantKey(rowA?.variance ?? {})).toBe(variantKey(rowB?.variance ?? {}));
  });

  it("falls back to the variance's `seedPrompt` when no `intent` is given", async () => {
    const { generator, seen } = capturingGenerator();
    const { telemetry, events } = sink();
    const handler = createGguiOpsGenerateBlueprintHandler({ ...defaultDeps({ generator }), telemetry });
    await handler.handler({ contract: BOARD, seedPrompt: "make it red" }, makeCtx("app-1"));
    expect(seen[0]?.request.prompt).toBe("make it red");
    expect(events.map((e) => e.name)).not.toContain("blueprint.generate_prompt_placeholder");
  });

  it("neither: the placeholder prompt is used and ONE observable event says so", async () => {
    const { generator, seen } = capturingGenerator();
    const { telemetry, events } = sink();
    const handler = createGguiOpsGenerateBlueprintHandler({ ...defaultDeps({ generator }), telemetry });
    await handler.handler({ contract: BOARD }, makeCtx("app-1"));
    expect(seen[0]?.request.prompt).toBe("Operator-authored blueprint variant");
    const placeholder = events.filter((e) => e.name === "blueprint.generate_prompt_placeholder");
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0]?.attributes).toMatchObject({ appId: "app-1", requestId: "req-1", reason: "no-intent-no-seedPrompt" });
  });
});

// ggui#1275 — an explicit intent or a seed prompt is the UI's task
// (authored); a persona alone is a stand-in (fallback).
describe("ggui_ops_generate_blueprint — the cache mirror's intentSource (ggui#1275)", () => {
  it.each([
    [{ intent: "a weekly spend summary" }, undefined],
    [{ seedPrompt: "make it red" }, undefined],
    [{ persona: "data-dense" }, "fallback"],
  ] as const)("%j mirrors intentSource %s", async (hints, expected) => {
    const cacheRegistry = {
      embedding: new MockEmbeddingProvider(),
      vectorStore: new InMemoryVectorStore(),
      index: new InMemoryBlueprintIndex(),
    };
    const handler = createGguiOpsGenerateBlueprintHandler({ ...defaultDeps(), cacheRegistry });
    await handler.handler({ contract: emptyContract(), ...hints }, makeCtx("app-1"));
    const rows = await listBlueprints(cacheRegistry, "app-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.intentSource).toBe(expected);
  });
});
