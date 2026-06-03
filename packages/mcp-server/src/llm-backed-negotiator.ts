/**
 * LLM-backed `HandshakeNegotiator` for the OSS server.
 *
 * A thin adapter over the SHARED handshake-decision core
 * (`decideHandshake` in `@ggui-ai/mcp-server-handlers`). This file owns
 * only the OSS-specific seams; the decision spine is shared verbatim
 * with the cloud pod's `createBedrockNegotiator` — same code, different
 * adapter.
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
 * ## selectVariant
 *
 * The optional LLM-driven variant-selection seam is OSS-specific and
 * stays on this binding (it is not part of the shared decide spine).
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
  VariantSelectionContext,
  VariantSelectionDecision,
  VectorStore,
} from "@ggui-ai/mcp-server-core";
import type { HandlerContext } from "@ggui-ai/mcp-server-handlers";
import {
  decideHandshake,
  type HandshakeDecisionAdapter,
  type HandshakeNegotiator,
  type InstalledBlueprintsProvider,
  type ToolIdentityCatalogStore,
} from "@ggui-ai/mcp-server-handlers/renders";
import type { LLMCaller } from "@ggui-ai/negotiator";
import type { Blueprint } from "@ggui-ai/protocol";
import { selectAdapter } from "@ggui-ai/ui-gen/providers";

/**
 * Wrap a resolved BYOK credential pair into an `LLMCaller` the
 * negotiator can call. The adapter is chosen via `selectAdapter`
 * (anthropic / openai / google / openrouter / bedrock). `call` runs
 * one `complete()` round-trip on the underlying adapter.
 *
 * `callStructured` is wired for Anthropic only. Anthropic's
 * `/v1/messages` natively supports forced tool use via `tools[] +
 * tool_choice: {type:'tool', name}`, so we hit the API directly here
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
export function buildLlmCaller(selection: LlmSelection, providerKey: ProviderKeyRef): LLMCaller {
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
    caller.callStructured = async <T>(
      systemPrompt: string,
      userMessage: string,
      tool: { name: string; description: string; input_schema: Record<string, unknown> },
      maxTokens?: number
    ): Promise<T> => {
      const result = await anthropicCallStructured({
        apiKey: providerKey.key,
        model: selection.model,
        systemPrompt,
        userMessage,
        tool,
        maxTokens,
      });
      return result as T;
    };
  }
  return caller;
}

/** Anthropic-direct tool-use call. Forces a single tool invocation
 *  and returns the tool's `input` JSON. Throws on non-2xx, network
 *  errors, or response-shape failures so the caller (rerank judge,
 *  synthesizer) can collapse to its null-decision fallback. */
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
}): Promise<unknown> {
  const body = {
    model: args.model,
    max_tokens: args.maxTokens ?? 1024,
    // `temperature` was pinned to 0 for deterministic structured
    // output, but Anthropic deprecated the parameter on newer
    // tool-use models (Haiku 4.5+ rejects it with HTTP 400). Dropped.
    // `tool_choice: { type: 'tool', name }` below already binds the
    // output shape to the declared input_schema — the model can't
    // emit a free-form text response when forced-tool is set.
    // Residual stochasticity is in field VALUES (e.g. action names);
    // both consumers (synthesizer + rerank judge) MUST tolerate
    // paraphrase via canonical-key normalisation rather than relying
    // on temperature=0.
    system: args.systemPrompt,
    messages: [{ role: "user", content: args.userMessage }],
    tools: [
      {
        name: args.tool.name,
        description: args.tool.description,
        input_schema: args.tool.input_schema,
      },
    ],
    // Forced tool use — model MUST emit exactly this tool. Without
    // this the model can drift to a text reply and synth/rerank
    // both lose their structured guarantee.
    tool_choice: { type: "tool", name: args.tool.name },
  };
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`anthropic tool-use HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const json = (await response.json()) as {
    content?: Array<{
      type?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  // Find the tool_use block. With `tool_choice: {type:'tool'}` the
  // model is forced to emit exactly one; defensively scan in case the
  // shape ever shifts.
  const toolUse = json.content?.find(
    (block) => block.type === "tool_use" && block.name === args.tool.name
  );
  if (!toolUse || toolUse.input === undefined) {
    throw new Error(`anthropic tool-use response missing tool_use block for "${args.tool.name}"`);
  }
  return toolUse.input;
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
   * shape used by `push.ts:1539-1541` so a single
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
}

/**
 * Build an LLM-backed `HandshakeNegotiator` for the OSS server.
 *
 * Thin wrapper over the shared `decideHandshake` core
 * (`@ggui-ai/mcp-server-handlers`): injects the OSS adapter — a BYOK
 * LLM resolver (`resolveLlm` → `buildLlmCaller`) and a single per-app
 * blueprint pool (`deps.cache`, scope defaults to `ctx.appId`). The
 * decision spine (find-similar → coverage guard → judge → atomic
 * reuse, else synth-repair create) is shared verbatim with the cloud
 * pod's `createBedrockNegotiator`; only the injected adapter differs.
 * `selectVariant` is OSS-specific and stays on this binding.
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
  const adapter: HandshakeDecisionAdapter = {
    // BYOK seam: resolve per-ctx creds + wrap into an LLMCaller. No
    // creds ⇒ undefined ⇒ the core returns a no-LLM create fallback.
    resolveLlm: async (ctx) => {
      const creds = await deps.resolveLlm(ctx);
      return creds
        ? buildLlmCaller(creds.selection, creds.providerKey)
        : undefined;
    },
    // OSS searches a single per-app pool (scope defaults to ctx.appId).
    // No cache wired ⇒ no pools ⇒ the core takes the synth-only path.
    ...(deps.cache
      ? {
          pools: [
            {
              registry: deps.cache,
              ...(deps.installedBlueprints
                ? { installedBlueprints: deps.installedBlueprints }
                : {}),
            },
          ],
        }
      : {}),
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

    // LLM-driven variant selection. Reads each candidate's
    // `variance` + `validatorScore` + `isOperatorDefault` + the
    // generator slug, asks the LLM to pick the best fit for the
    // current request's `intent` + `variance`, and returns a
    // calibrated decision. The caller (`selectVariantWithLlm`)
    // thresholds on `confidence`.
    //
    // Errors throw — the caller catches and falls through to the
    // deterministic ladder. The decide() seam uses a more permissive
    // fail-open pattern because there's no fallback higher up; the
    // variant-selector caller owns the fallback path itself.
    async selectVariant({ candidates, context, ctx }): Promise<VariantSelectionDecision> {
      if (candidates.length === 0) {
        throw new Error(
          "selectVariant: empty candidates list — orchestration should short-circuit before calling"
        );
      }
      const creds = await deps.resolveLlm(ctx);
      if (!creds) {
        throw new Error(
          "selectVariant: no BYOK credentials resolved; orchestration falls through to deterministic ladder"
        );
      }
      const llm = buildLlmCaller(creds.selection, creds.providerKey);
      return runVariantSelectionLlm(llm, candidates, context);
    },
  };
}

/**
 * The system prompt for the variant-selection LLM call. Calibration
 * is load-bearing — the model is explicitly told to surface low
 * confidence when signals are weak so the deterministic-ladder
 * fallback takes over. The prompt is intentionally short: high
 * token budget on the user message (candidate JSON) is more useful
 * than verbose system framing.
 */
export const VARIANT_SELECTION_SYSTEM_PROMPT = `You are the variant selector for the ggui UI matcher. You receive a shortlist of pre-built UI blueprint variants and a request context. Pick the variant that best fits the request.

Each variant carries:
  - blueprintId: stable identity (you MUST echo back exactly one of these).
  - generator: which generator built it (e.g. "ui-gen-default-haiku-4-5", "ui-gen-advanced-opus-4-7"). Advanced wins on visual polish; default wins on simplicity.
  - validatorScore: optional 0-1 self-assessed quality from the advanced generator's validators. Higher is better, undefined ⇒ unknown.
  - isOperatorDefault: true ⇒ the human operator pinned this as the default. Strong signal.
  - variance.persona: free-form tag ("minimalist", "data-dense", "mobile-first"…).
  - variance.aesthetic: optional free-form tag ("glassy", "flat", "editorial"…).
  - variance.context: small structured signal (theme, accent, …).
  - variance.seedPrompt: the operator's original prose that produced this variant.

The request context carries the same fields. Match on:
  1. variance.persona equality / closeness (strongest non-pin signal).
  2. variance.aesthetic equality / closeness.
  3. variance.context overlap (shared keys + values).
  4. seedPrompt semantic similarity to context.intent.

Honor operator pins (isOperatorDefault: true) unless variance.persona / variance.aesthetic on the request clearly contradicts the pinned variant — that's the only case where you should override the pin.

Calibrate confidence honestly. Return high (≥ 0.7) only when a clear best match exists. Return low (< 0.6) when signals are weak — the orchestration falls back to a deterministic ladder in that case. The fallback is safe; over-confident picks are NOT.`;

const VARIANT_SELECTION_TOOL_NAME = "select_variant";

const VARIANT_SELECTION_TOOL_DESCRIPTION =
  "Pick the variant that best fits the request context. Return the chosen blueprintId, a calibrated 0-1 confidence, and a one-sentence reason citing the matching axes (persona / aesthetic / context / seedPrompt / pin / validator).";

/**
 * JSON Schema for the structured-output tool call. Forces the model
 * to emit `{blueprintId, confidence, reason}` — no free-text prose.
 * Used on Anthropic via `LLMCaller.callStructured`; the text-fallback
 * path parses the same shape from regex-extracted JSON.
 */
const VARIANT_SELECTION_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    blueprintId: {
      type: "string",
      description:
        "One of the candidate blueprintIds shown in the request. Echo exactly — must match a candidate.",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Calibrated confidence in this pick on [0, 1]. Use < 0.6 when signals are weak; the orchestration falls back to a deterministic ladder.",
    },
    reason: {
      type: "string",
      description:
        "One-sentence rationale citing the matching axes (persona, aesthetic, context, seedPrompt, validator, pin).",
    },
  },
  required: ["blueprintId", "confidence", "reason"],
};

/**
 * Build the user-message payload for the variant-selection prompt.
 * The candidate list is projected to a compact JSON shape that
 * surfaces the decision-relevant fields only — full contract
 * embedding is too much surface area for a sub-second pick.
 *
 * Exposed for testing — the prompt structure is load-bearing, so
 * snapshot tests against this output anchor regressions.
 */
export function buildVariantSelectionUserMessage(
  candidates: readonly Blueprint[],
  context: VariantSelectionContext
): string {
  const projectedCandidates = candidates.map((c) => ({
    blueprintId: c.blueprintId,
    generator: c.generator,
    ...(c.validatorScore !== undefined ? { validatorScore: c.validatorScore } : {}),
    ...(c.isOperatorDefault === true ? { isOperatorDefault: true } : {}),
    variance: {
      ...(c.variance.persona !== undefined ? { persona: c.variance.persona } : {}),
      ...(c.variance.context !== undefined ? { context: c.variance.context } : {}),
      ...(c.variance.seedPrompt !== undefined ? { seedPrompt: c.variance.seedPrompt } : {}),
    },
  }));
  const requestProjection = {
    contractHash: context.contractHash,
    ...(context.intent !== undefined ? { intent: context.intent } : {}),
    ...(context.variance !== undefined
      ? {
          variance: {
            ...(context.variance.persona !== undefined
              ? { persona: context.variance.persona }
              : {}),
            ...(context.variance.aesthetic !== undefined
              ? { aesthetic: context.variance.aesthetic }
              : {}),
            ...(context.variance.context !== undefined
              ? { context: context.variance.context }
              : {}),
            ...(context.variance.seedPrompt !== undefined
              ? { seedPrompt: context.variance.seedPrompt }
              : {}),
          },
        }
      : {}),
  };
  return [
    "CANDIDATES:",
    JSON.stringify(projectedCandidates, null, 2),
    "",
    "REQUEST:",
    JSON.stringify(requestProjection, null, 2),
    "",
    "Pick the variant that best fits the REQUEST. Echo the blueprintId exactly, surface calibrated confidence, give a one-sentence rationale.",
  ].join("\n");
}

/**
 * Run the LLM call + decode. Anthropic path uses `callStructured`
 * (forced tool use ⇒ guaranteed JSON); other providers fall back to
 * text + regex-extracted JSON. The caller (`selectVariantWithLlm`)
 * catches any throw from this function and routes through the
 * deterministic ladder; this function surfaces detail in the thrown
 * error so telemetry can attribute the fallback cause.
 */
async function runVariantSelectionLlm(
  llm: LLMCaller,
  candidates: readonly Blueprint[],
  context: VariantSelectionContext
): Promise<VariantSelectionDecision> {
  const userMessage = buildVariantSelectionUserMessage(candidates, context);
  if (llm.callStructured) {
    const decoded = await llm.callStructured(
      VARIANT_SELECTION_SYSTEM_PROMPT,
      userMessage,
      {
        name: VARIANT_SELECTION_TOOL_NAME,
        description: VARIANT_SELECTION_TOOL_DESCRIPTION,
        input_schema: VARIANT_SELECTION_TOOL_SCHEMA,
      },
      512
    );
    return parseVariantSelectionResponse(decoded);
  }
  // Text-fallback — parse JSON via regex. Lower reliability;
  // operators on non-Anthropic providers get this path until
  // `callStructured` extends to their adapter.
  const text = await llm.call(
    VARIANT_SELECTION_SYSTEM_PROMPT,
    `${userMessage}\n\nRespond as ONE LINE of JSON: {"blueprintId":"…","confidence":0.0-1.0,"reason":"…"}`,
    512
  );
  const match = text.match(/\{[\s\S]*?"blueprintId"[\s\S]*?\}/);
  if (!match) {
    throw new Error(
      `variant-selection: no JSON object found in text response (length ${text.length})`
    );
  }
  return parseVariantSelectionResponse(JSON.parse(match[0]));
}

/**
 * Parse + validate the LLM-tool-use response shape. Exposed for
 * testing; in production it is only called via `runVariantSelectionLlm`.
 *
 * @throws Error on any shape violation. The caller catches and falls
 *   through to the deterministic ladder; the message is surfaced in
 *   `VariantSelectionResult.reason` for telemetry.
 */
export function parseVariantSelectionResponse(raw: unknown): VariantSelectionDecision {
  if (raw === null || typeof raw !== "object") {
    throw new Error("variant-selection: response is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const blueprintId = obj["blueprintId"];
  const confidence = obj["confidence"];
  const reason = obj["reason"];
  if (typeof blueprintId !== "string" || blueprintId.length === 0) {
    throw new Error("variant-selection: blueprintId missing or non-string");
  }
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error(
      `variant-selection: confidence missing or out of range: ${JSON.stringify(confidence)}`
    );
  }
  if (typeof reason !== "string") {
    throw new Error("variant-selection: reason missing or non-string");
  }
  return { blueprintId, confidence, reason };
}
