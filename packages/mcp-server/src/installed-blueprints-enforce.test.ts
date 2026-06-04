/**
 * Slice 5 follow-up (2026-05-18, H1) — `createGguiServer` enforces
 * the shared-instance contract for the `installedBlueprints` bridge.
 *
 * The bridge writes to `provider.deps.vectorStore`; the matcher reads
 * from the server's resolved `vectors`. Without reference-equality,
 * the bridge writes into a store the matcher never sees → silent
 * drift, no Tier-1 hit. Same applies to `embedding`. Sandbox audit
 * surfaced this as the load-bearing wiring invariant — without the
 * runtime guard the contract is documented but unenforced.
 *
 * The same invariant extends to the blueprint `index` (the
 * `(scope, exactKey) → blueprintId` resolver): the bridge + matcher
 * MUST share one index instance, enforced identically.
 */
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from "@ggui-ai/mcp-server-core/in-memory";
import { createInstalledBlueprintsProvider } from "@ggui-ai/mcp-server-handlers/renders";
import { describe, expect, it } from "vitest";
import { createGguiServer } from "./server.js";

describe("createGguiServer installedBlueprints shared-instance enforcement", () => {
  it("throws when the provider was constructed with a different vectorStore than the server", () => {
    const embedding = new MockEmbeddingProvider();
    const index = new InMemoryBlueprintIndex();
    const serverVectors = new InMemoryVectorStore();
    const bridgeVectors = new InMemoryVectorStore(); // ← different instance

    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [],
      compile: async () => ({ kind: "ok", code: "x" }),
      deps: { embedding, vectorStore: bridgeVectors, index },
    });

    expect(() =>
      createGguiServer({
        renderChannel: true,
        mcpApps: true,
        embedding,
        vectors: serverVectors,
        index,
        generation: {
          // Minimal generation deps; the enforcement runs irrespective
          // of generator wiring.
          uiGenerator: {
            slug: "ui-gen-default-haiku-4-5",
            tier: "default",
            model: "claude-haiku-4-5",
            generate: async () => ({
              ok: false as const,
              error: { code: "PRODUCTION_FAILED" as const, message: "unused" },
            }),
          },
          resolveLlm: () => null,
          blueprints: { list: async () => [], get: async () => null },
          installedBlueprints: provider,
        },
      })
    ).toThrow(/different `vectorStore`/);
  });

  it("throws when the provider was constructed with a different embedding than the server", () => {
    const serverEmbedding = new MockEmbeddingProvider();
    const bridgeEmbedding = new MockEmbeddingProvider(); // ← different instance
    const vectors = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();

    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [],
      compile: async () => ({ kind: "ok", code: "x" }),
      deps: { embedding: bridgeEmbedding, vectorStore: vectors, index },
    });

    expect(() =>
      createGguiServer({
        renderChannel: true,
        mcpApps: true,
        embedding: serverEmbedding,
        vectors,
        index,
        generation: {
          uiGenerator: {
            slug: "ui-gen-default-haiku-4-5",
            tier: "default",
            model: "claude-haiku-4-5",
            generate: async () => ({
              ok: false as const,
              error: { code: "PRODUCTION_FAILED" as const, message: "unused" },
            }),
          },
          resolveLlm: () => null,
          blueprints: { list: async () => [], get: async () => null },
          installedBlueprints: provider,
        },
      })
    ).toThrow(/different `embedding`/);
  });

  it("throws when the provider was constructed with a different index than the server", () => {
    const embedding = new MockEmbeddingProvider();
    const vectors = new InMemoryVectorStore();
    const serverIndex = new InMemoryBlueprintIndex();
    const bridgeIndex = new InMemoryBlueprintIndex(); // ← different instance

    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [],
      compile: async () => ({ kind: "ok", code: "x" }),
      deps: { embedding, vectorStore: vectors, index: bridgeIndex },
    });

    expect(() =>
      createGguiServer({
        renderChannel: true,
        mcpApps: true,
        embedding,
        vectors,
        index: serverIndex,
        generation: {
          uiGenerator: {
            slug: "ui-gen-default-haiku-4-5",
            tier: "default",
            model: "claude-haiku-4-5",
            generate: async () => ({
              ok: false as const,
              error: { code: "PRODUCTION_FAILED" as const, message: "unused" },
            }),
          },
          resolveLlm: () => null,
          blueprints: { list: async () => [], get: async () => null },
          installedBlueprints: provider,
        },
      })
    ).toThrow(/different `index`/);
  });

  it("accepts a provider whose deps match the server-resolved instances", () => {
    const embedding = new MockEmbeddingProvider();
    const vectors = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();

    const provider = createInstalledBlueprintsProvider({
      installedBlueprints: () => [],
      compile: async () => ({ kind: "ok", code: "x" }),
      deps: { embedding, vectorStore: vectors, index },
    });

    expect(() =>
      createGguiServer({
        renderChannel: true,
        mcpApps: true,
        embedding,
        vectors,
        index,
        generation: {
          uiGenerator: {
            slug: "ui-gen-default-haiku-4-5",
            tier: "default",
            model: "claude-haiku-4-5",
            generate: async () => ({
              ok: false as const,
              error: { code: "PRODUCTION_FAILED" as const, message: "unused" },
            }),
          },
          resolveLlm: () => null,
          blueprints: { list: async () => [], get: async () => null },
          installedBlueprints: provider,
        },
      })
    ).not.toThrow();
  });
});
