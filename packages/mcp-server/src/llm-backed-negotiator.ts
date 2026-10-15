/**
 * LLM-backed `HandshakeNegotiator` for the OSS server.
 *
 * A thin adapter over the SHARED handshake-decision core
 * (`decideHandshake` in `@ggui-ai/mcp-server-handlers`). This file owns
 * only this server's seams; the decision spine is shared verbatim
 * across every negotiator binding of the server family — same code,
 * different adapter.
 *
 * ## OSS adapter seams
 *
 *   - **LLM** — `buildLlmCaller` composes BYOK credentials + a
 *     `ProviderAdapter` from `@ggui-ai/ui-gen/providers` into an
 *     `LLMCaller` (anthropic / openai / google / openrouter / bedrock).
 *     The adapter's `resolveLlm(ctx)` returns it, or `undefined` when no
 *     creds resolve (⇒ the core returns a no-LLM `create` fallback).
 *   - **Pools** — a single per-app blueprint pool from `deps.cache`
 *     (scope defaults to `ctx.appId`). Absent ⇒ no pools ⇒ synth-only.
 *   - **warn** — `console.warn` for swallowed operational errors.
 *
 * ## Shared decision spine (in the core, not here)
 *
 *   find-similar across pools (exact-key → coverage guard → judge →
 *   atomic reuse) ⇒ else synth-repair create via
 *   `ensureConformingContract`. Operational errors fail open; programmer
 *   errors re-throw. See `decide-handshake.ts` for the full contract.
 *
 * ## Default binding
 *
 * Bound by default in `createGguiServer` when handshake is enabled AND a
 * `resolveLlm` is wired into `generation`.
 */

import type {
  BlueprintIndex,
  EmbeddingProvider,
  LlmRoute,
  LlmSelection,
  ProviderKeyRef,
  VectorStore,
} from "@ggui-ai/mcp-server-core";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import {
  decideHandshake,
  type BlueprintPool,
  type HandshakeDecisionAdapter,
  type HandshakeNegotiator,
  type InstalledBlueprintsProvider,
  type ToolIdentityCatalogStore,
} from "@ggui-ai/mcp-server-handlers/renders";
import type { LLMCaller, Metered } from "@ggui-ai/negotiator";
import { anthropicToolCall, selectAdapter } from "@ggui-ai/ui-gen/providers";

/**
 * Wrap a resolved BYOK credential pair into an `LLMCaller` the
 * negotiator can call. The adapter is chosen via `selectAdapter`
 * (anthropic / openai / google / openrouter / bedrock). `call` runs
 * one `complete()` round-trip on the underlying adapter.
 *
 * `callStructured` (and `callStructuredMetered`, the same call with the
 * response's token usage beside the tool input — ggui#1418) is wired for
 * Anthropic only, through the shared structured call
 * (`anthropicToolCall` in `@ggui-ai/ui-gen/providers`, ggui#1271): one
 * `/v1/messages` request asking for one tool call, a forced
 * `tool_choice` where the model accepts one, and every way the turn ends
 * without the tool input thrown as a NAMED `AnthropicStructuredCallError`
 * (re-exported from this package's index). The rerank judge and the synthesizer collapse that
 * throw to their null-decision fallback, with the kind in the reason.
 * Other providers (OpenAI, Google, OpenRouter, Bedrock) omit
 * `callStructured`; consumers detect absence and fall back to
 * regex-JSON extraction on the text path.
 *
 * Used by:
 *   - `@ggui-ai/negotiator/llm-rerank` (Tier 2 RAG match judge)
 *   - `@ggui-ai/negotiator/synthesize-contract` (cold-path contract
 *     synthesizer)
 */
export interface BuildLlmCallerOptions {
  /**
   * Aborts every request this caller makes — both `call` (through the
   * provider adapter) and `callStructured` (the direct `/v1/messages`
   * request). A caller that bounds the call's wall-clock time passes a
   * timed signal here so the bound cancels the request itself rather than
   * racing it. Absent ⇒ the requests run unbounded, as before.
   *
   * The signal is bound for this caller's lifetime and shared by every
   * request it makes: once it fires, every later request on this caller
   * rejects at once. A caller that bounds each call builds one caller per
   * bound, never caches one with a timed signal.
   */
  readonly signal?: AbortSignal;
}

export function buildLlmCaller(
  selection: LlmSelection,
  providerKey: ProviderKeyRef,
  options: BuildLlmCallerOptions = {}
): LLMCaller {
  const adapter = selectAdapter(selection.provider);
  const isAnthropic = selection.provider === "anthropic";
  // `selection` IS an `LlmRoute & {inference params}` — the typed
  // discriminated union means `selection.model` is already in the
  // wire-canonical form the provider SDK expects. No LiteLLM-prefix
  // strip happens here; if one were ever needed again, the validator
  // belongs at the route construction boundary (`parseAnyLlmRoute`),
  // not at the SDK-call site. This is what eliminates the #22 / #42
  // bug class structurally. We pass `selection` itself as the `route`
  // — re-constructing an object literal would widen the typed
  // discriminator and lose the (provider, model) pairing TS needs to
  // narrow against `LlmRoute`'s union.
  const route: LlmRoute = selection;
  const caller: LLMCaller = {
    async call(systemPrompt, userMessage, maxTokens) {
      const result = await adapter.complete({
        apiKey: providerKey.key,
        route,
        systemPrompt,
        userPrompt: userMessage,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (!result.ok) {
        throw new Error(
          `[llm-backed-negotiator] ${selection.provider} ${selection.model} ` +
            `failed: ${result.error.kind} — ${result.error.message}`
        );
      }
      return result.response.text;
    },
  };
  if (isAnthropic) {
    const metered = (
      systemPrompt: string,
      userMessage: string,
      tool: { name: string; description: string; input_schema: Record<string, unknown> },
      maxTokens?: number
    ): Promise<Metered<unknown>> =>
      anthropicToolCall({
        apiKey: providerKey.key,
        model: selection.model,
        systemPrompt,
        userPrompt: userMessage,
        tool,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }).then(({ input, usage }) => ({ value: input, ...(usage !== undefined ? { usage } : {}) }));
    caller.callStructuredMetered = metered;
    caller.callStructured = async (systemPrompt, userMessage, tool, maxTokens) =>
      (await metered(systemPrompt, userMessage, tool, maxTokens)).value;
  }
  return caller;
}

/**
 * Dependencies for `createLlmBackedHandshakeNegotiator`. Only
 * `resolveLlm` is required; the rest carry default fallbacks.
 */
export interface LlmBackedHandshakeNegotiatorDeps {
  /**
   * Per-call BYOK resolver. Returns `null` when no creds are
   * available — the negotiator falls back to a "create" result with
   * a clear reason rather than failing the handshake. Sync-or-async
   * to match `GenerationDeps.resolveLlm`'s wider shape (in-process
   * dispatchers can return synchronously).
   */
  resolveLlm: (
    ctx: HandlerContext
  ) =>
    | { selection: LlmSelection; providerKey: ProviderKeyRef }
    | Promise<{ selection: LlmSelection; providerKey: ProviderKeyRef } | null>
    | null;
  /**
   * Blueprint-registry deps for the handshake-time find-similar match
   * (exact-key → coverage guard → judge). When bound, the shared
   * `decideHandshake` core probes this registry (as a single per-app
   * pool) before the synth path: an exact-key or semantic hit
   * short-circuits the synth LLM round-trip and returns `origin:
   * 'cache'` with the matched blueprint's contract + codeHash.
   *
   * Optional so deployments without RAG infrastructure (no embedding
   * / vector store) continue to use the synth-only path. Mirrors the
   * shape used by the render handler (`render.ts`) so a single
   * `generationWithCache.cache` value threads into both seams.
   */
  cache?: {
    readonly embedding: EmbeddingProvider;
    readonly vectorStore: VectorStore;
    readonly index: BlueprintIndex;
  };
  /**
   * Marketplace-install bridge. When wired alongside
   * `cache`, handshake-time exact-key matches consult the installed-
   * blueprint pool too — the provider lazily compiles + caches each
   * installed blueprint on first ensureCached per scope, so the same
   * canonical key the agent draft hashes to becomes a cache hit
   * without a separate synth round-trip.
   */
  installedBlueprints?: InstalledBlueprintsProvider;
  /**
   * Per-app tool-identity catalog store (READ side). When wired, the
   * shared `decideHandshake` core runs `canonicalizeToolIdentity`
   * against `catalogStore.get(ctx.appId)` BEFORE keying — rewriting each
   * tool's `serverInfo` to the canonical identity the host runtime
   * declared via `ggui_runtime_declare_tool_catalog`, so blueprint reuse
   * is framework-invariant. Absent ⇒ the canonicalization step is a
   * no-op (Tier 2). The SAME instance the declaration handler writes.
   */
  catalogStore?: ToolIdentityCatalogStore;
  /**
   * Read-only shared/seed pools (cross-deployment reuse). Appended to
   * adapter.pools AFTER the per-app pool, so a deployment's own
   * blueprints win on exact-key first-match. Each is typically built by
   * `buildSeedPool` from a distributable artifact. Absent ⇒ no shared pool.
   */
  readonly seedPools?: readonly BlueprintPool[];
}

/**
 * Build the handshake pool list: the per-app pool (from `cache`) first —
 * so a deployment's own blueprints win on exact-key first-match — then
 * any read-only seed pools.
 */
export function assembleHandshakePools(
  deps: Pick<LlmBackedHandshakeNegotiatorDeps, 'cache' | 'installedBlueprints' | 'seedPools'>,
): BlueprintPool[] {
  const perAppPool: BlueprintPool | undefined = deps.cache
    ? {
        registry: deps.cache,
        ...(deps.installedBlueprints ? { installedBlueprints: deps.installedBlueprints } : {}),
      }
    : undefined;
  return [...(perAppPool ? [perAppPool] : []), ...(deps.seedPools ?? [])];
}

/**
 * Build an LLM-backed `HandshakeNegotiator` for the OSS server.
 *
 * Thin wrapper over the shared `decideHandshake` core
 * (`@ggui-ai/mcp-server-handlers`): injects the OSS adapter — a BYOK
 * LLM resolver (`resolveLlm` → `buildLlmCaller`) and a single per-app
 * blueprint pool (`deps.cache`, scope defaults to `ctx.appId`). The
 * decision spine (find-similar → coverage guard → judge → atomic
 * reuse, else synth-repair create) is shared verbatim across every
 * negotiator binding; only the injected adapter differs.
 *
 * @public
 */
export function createLlmBackedHandshakeNegotiator(
  deps: LlmBackedHandshakeNegotiatorDeps
): HandshakeNegotiator {
  // Capture the store so the adapter resolver closes over a concrete
  // value (no `?.` chain inside the hot path; the spread below already
  // gates on presence).
  const catalogStore = deps.catalogStore;
  const pools = assembleHandshakePools(deps);
  const adapter: HandshakeDecisionAdapter = {
    // BYOK seam: resolve per-ctx creds + wrap into an LLMCaller. No
    // creds ⇒ undefined ⇒ the core returns a no-LLM create fallback.
    resolveLlm: async (ctx) => {
      const creds = await deps.resolveLlm(ctx);
      return creds
        ? buildLlmCaller(creds.selection, creds.providerKey)
        : undefined;
    },
    // Per-app pool first, then seed pools. No pools ⇒ the core takes
    // the synth-only path.
    ...(pools.length > 0 ? { pools } : {}),
    warn: (message) => {
      // eslint-disable-next-line no-console -- operator-visible signal
      console.warn(message);
    },
    // READ side of tool-identity canonicalization. When a catalog store
    // is wired, the core resolves the per-app catalog by ctx.appId and
    // runs canonicalizeToolIdentity before keying. Absent ⇒ the seam is
    // a no-op (Tier 2).
    ...(catalogStore
      ? { toolIdentityCatalog: (ctx) => catalogStore.get(ctx.appId) }
      : {}),
  };

  return {
    decide: (input) => decideHandshake(adapter, input),
  };
}
