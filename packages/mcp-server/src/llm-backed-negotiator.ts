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
import type { LLMCaller, Metered, TokenUsage } from "@ggui-ai/negotiator";
import { anthropicRejectsForcedToolChoice, isRecord } from "@ggui-ai/protocol";
import { selectAdapter } from "@ggui-ai/ui-gen/providers";

/**
 * Wrap a resolved BYOK credential pair into an `LLMCaller` the
 * negotiator can call. The adapter is chosen via `selectAdapter`
 * (anthropic / openai / google / openrouter / bedrock). `call` runs
 * one `complete()` round-trip on the underlying adapter.
 *
 * `callStructured` (and `callStructuredMetered`, the same call with the
 * response's token usage beside the tool input — ggui#1418) is wired for
 * Anthropic only. Anthropic's
 * `/v1/messages` natively supports forced tool use via `tools[] +
 * tool_choice: {type:'tool', name}` — on the models that accept it; the
 * always-thinking models refuse a forced tool (see
 * `anthropicCallStructured`) — so we hit the API directly here
 * instead of expanding the `ProviderAdapter` interface for one
 * provider. Other providers (OpenAI, Google, OpenRouter, Bedrock)
 * omit `callStructured`; consumers detect absence and fall back to
 * regex-JSON extraction on the text path. When this story shifts —
 * e.g., we want OpenAI tool use too — promote `completeWithTool`
 * onto `ProviderAdapter` as an optional method and wire each
 * adapter; this in-place implementation stays the bridge until then.
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
      anthropicCallStructured({
        apiKey: providerKey.key,
        model: selection.model,
        systemPrompt,
        userMessage,
        tool,
        maxTokens,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    caller.callStructuredMetered = metered;
    caller.callStructured = async (systemPrompt, userMessage, tool, maxTokens) =>
      (await metered(systemPrompt, userMessage, tool, maxTokens)).value;
  }
  return caller;
}

/**
 * Thinking budget added to the caller's ANSWER budget when the model
 * refuses a forced tool. Those are the always-thinking models: their
 * thinking counts against `max_tokens` and comes before the tool call,
 * so a caller's small answer budget (the rerank judge asks for 512)
 * would be spent before the `tool_use` block exists. `max_tokens` is a
 * ceiling, not spend.
 */
export const ALWAYS_THINKING_HEADROOM_TOKENS = 16_000;

/** How a structured call ended without the tool input it asked for. */
export type AnthropicStructuredCallFailureKind =
  /** The budget ran out (`stop_reason: max_tokens`) before the tool call. */
  | "max_tokens"
  /** The model finished without calling the tool (possible under `auto`). */
  | "no_tool_call"
  /** The model declined (`stop_reason: refusal`). */
  | "refusal"
  /** The API answered non-2xx. */
  | "http"
  /** The body was not a Messages response. */
  | "malformed";

/**
 * A structured call that returned no tool input, NAMED by why. The kind
 * is in the message too (`[max_tokens]` …), so a consumer that only
 * surfaces the message — the rerank judge's `reason` — still reports
 * which failure it was instead of an anonymous null decision.
 */
export class AnthropicStructuredCallError extends Error {
  readonly kind: AnthropicStructuredCallFailureKind;
  readonly status: number | undefined;
  readonly stopReason: string | undefined;
  constructor(
    kind: AnthropicStructuredCallFailureKind,
    detail: string,
    extra: { readonly status?: number; readonly stopReason?: string } = {}
  ) {
    super(`anthropic structured call [${kind}]: ${detail}`);
    this.name = "AnthropicStructuredCallError";
    this.kind = kind;
    this.status = extra.status;
    this.stopReason = extra.stopReason;
  }
}

/**
 * Anthropic-direct tool-use call; returns the tool's `input` JSON.
 *
 * Two request shapes, chosen by the shared model-rule predicate
 * (`anthropicRejectsForcedToolChoice`, the same list the harness router
 * reads — one list, so a model the API starts refusing is added once):
 *
 *   - Models that accept a forced tool: `tool_choice: {type: 'tool'}`
 *     and the caller's `max_tokens`, as before.
 *   - Models that refuse it (the always-thinking family): a forced tool
 *     is an HTTP 400 on every call, so they get `tool_choice: auto` with
 *     at most one call, an instruction naming the tool appended to the
 *     system prompt, and `ALWAYS_THINKING_HEADROOM_TOKENS` added to the
 *     caller's budget. `strict: true` is deliberately NOT sent: the two
 *     consumers' schemas carry keywords strict tool use rejects (the
 *     rerank judge's `minimum`/`maximum`, the synthesizer's map-shaped
 *     `additionalProperties`), so it would trade one 400 for another;
 *     both consumers already validate the input they get back.
 *
 * Every way the turn ends without the tool input throws an
 * `AnthropicStructuredCallError` whose kind says which — the caller
 * (rerank judge, synthesizer) collapses it to its null-decision
 * fallback, and the kind rides along in the reason.
 */
async function anthropicCallStructured(args: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  tool: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<Metered<unknown>> {
  const answerBudget = args.maxTokens ?? 1024;
  const refusesForcedTool = anthropicRejectsForcedToolChoice(args.model);
  const body = {
    model: args.model,
    max_tokens: refusesForcedTool ? answerBudget + ALWAYS_THINKING_HEADROOM_TOKENS : answerBudget,
    // `temperature` was pinned to 0 for deterministic structured
    // output, but Anthropic deprecated the parameter on newer
    // tool-use models (Haiku 4.5+ rejects it with HTTP 400). Dropped.
    // Residual stochasticity is in field VALUES (e.g. action names);
    // both consumers (synthesizer + rerank judge) MUST tolerate
    // paraphrase via canonical-key normalisation rather than relying
    // on temperature=0.
    system: refusesForcedTool
      ? `${args.systemPrompt}\n\nAnswer by calling the \`${args.tool.name}\` tool exactly once. Do not answer in text.`
      : args.systemPrompt,
    messages: [{ role: "user", content: args.userMessage }],
    tools: [
      {
        name: args.tool.name,
        description: args.tool.description,
        input_schema: args.tool.input_schema,
      },
    ],
    // Forced tool use where the model allows it — the model MUST emit
    // exactly this tool. Where it doesn't, `auto` + one call + the
    // instruction above, and a missing call is a named failure below.
    tool_choice: refusesForcedTool
      ? { type: "auto", disable_parallel_tool_use: true }
      : { type: "tool", name: args.tool.name },
  };
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AnthropicStructuredCallError("http", `HTTP ${response.status}: ${text.slice(0, 500)}`, {
      status: response.status,
    });
  }
  const json: unknown = await response.json();
  if (!isRecord(json) || !Array.isArray(json["content"])) {
    throw new AnthropicStructuredCallError("malformed", "response body is not a Messages response");
  }
  const stopReason = typeof json["stop_reason"] === "string" ? json["stop_reason"] : undefined;
  const toolUse = json["content"].find(
    (block): block is Record<string, unknown> =>
      isRecord(block) && block["type"] === "tool_use" && block["name"] === args.tool.name
  );
  if (toolUse !== undefined && toolUse["input"] !== undefined) {
    const usage = readMessagesUsage(json["usage"]);
    return { value: toolUse["input"], ...(usage !== undefined ? { usage } : {}) };
  }
  if (stopReason === "max_tokens") {
    throw new AnthropicStructuredCallError(
      "max_tokens",
      `stop_reason=max_tokens before the "${args.tool.name}" tool_use block (max_tokens=${body.max_tokens})`,
      { stopReason }
    );
  }
  if (stopReason === "refusal") {
    throw new AnthropicStructuredCallError("refusal", `the model declined (stop_reason=refusal)`, { stopReason });
  }
  throw new AnthropicStructuredCallError(
    "no_tool_call",
    `the turn ended (stop_reason=${stopReason ?? "absent"}) without a "${args.tool.name}" tool_use block`,
    stopReason !== undefined ? { stopReason } : {}
  );
}

/**
 * The token usage of a Messages response, as `{ input, output }`: its
 * `usage.input_tokens` and `usage.output_tokens` when both are numbers,
 * else absent (unmetered, never zeros — ggui#1418). No `cache_control` is
 * sent on this call, so the cache token counts are not added.
 */
function readMessagesUsage(usage: unknown): TokenUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const input = usage["input_tokens"];
  const output = usage["output_tokens"];
  return typeof input === "number" && typeof output === "number" ? { input, output } : undefined;
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
