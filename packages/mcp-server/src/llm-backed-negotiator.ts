/**
 * LLM-backed `HandshakeNegotiator` for the OSS server.
 *
 * Composes BYOK credentials + a `ProviderAdapter` from
 * `@ggui-ai/ui-gen/providers` into an `LLMCaller`, then runs
 * `@ggui-ai/negotiator`'s `negotiate()` pipeline. Mirrors the cloud
 * `createBedrockNegotiator` pattern (cloud/ggui-protocol-pod/src/
 * tools/handshake.ts), stripped of Bedrock-specific embedding +
 * vector-store wiring — those are absent on OSS by default and
 * `negotiate()` handles missing RAG deps gracefully.
 *
 * ## What this binding does
 *
 * On every `ggui_handshake` call:
 *
 *   1. Resolves BYOK creds via the supplied `resolveLlm(ctx)`. No
 *      creds → returns a "create" result with a `no-creds` reason.
 *   2. Selects the matching `ProviderAdapter` for the resolved
 *      provider (anthropic / openai / google / openrouter / bedrock).
 *   3. Wraps the adapter into an `LLMCaller` (single-shot text
 *      completion).
 *   4. Calls `negotiate(deps, input)` with `embedding: undefined,
 *      vectors: undefined` — RAG search is skipped, decision LLM
 *      runs against an empty candidate list, returns a sensible
 *      create/update decision based on session state + agent
 *      prompt.
 *   5. Maps the `NegotiateResult` onto the OSS-shape
 *      `HandshakeNegotiatorResult`.
 *
 * ## Failure modes
 *
 * Operational errors (network flap, provider 5xx, rate limit) fail
 * open: returns a "create" result with the error reason. Bugs
 * (TypeError / ReferenceError / RangeError / SyntaxError) re-throw
 * — those are programmer errors that should surface, not be
 * silently swallowed.
 *
 * ## Cost posture
 *
 * One LLM call per handshake (when creds resolve). Operators
 * concerned about cost can either (a) skip handshake and call
 * `ggui_render` directly with `{story}`, or (b) bind a different
 * negotiator (e.g., the cache-backed one for read-only cache
 * lookups) via `createGguiServer({handshake: {negotiator: ...}})`.
 *
 * ## Default binding
 *
 * Bound by default in `createGguiServer` when handshake is enabled
 * AND a `resolveLlm` is wired into `generation`. OSS is cloud-aligned:
 * same `negotiate()` pipeline, just with degraded RAG when local
 * infrastructure isn't bound.
 */

import type {
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
  DEFAULT_GENERATOR_SLUG,
  matchBlueprint,
  type HandshakeNegotiator,
  type HandshakeNegotiatorResult,
  type InstalledBlueprintsProvider,
  type MatchBlueprintDeps,
} from "@ggui-ai/mcp-server-handlers/renders";
import { negotiate, type LLMCaller } from "@ggui-ai/negotiator";
import type { Blueprint, DataContract, HandshakeSuggestion } from "@ggui-ai/protocol";
import { blueprintKey } from "@ggui-ai/protocol/blueprint-key";
import { selectAdapter } from "@ggui-ai/ui-gen/providers";
import { createHash, randomUUID } from "node:crypto";

/**
 * Operational error classifier — mirrors the cloud helper. Bugs
 * surface; provider failures + network blips degrade to a "create"
 * stub so the agent isn't blocked by a transient infrastructure
 * issue.
 */
function isOperationalError(err: unknown): boolean {
  if (err instanceof TypeError) return false;
  if (err instanceof ReferenceError) return false;
  if (err instanceof RangeError) return false;
  if (err instanceof SyntaxError) return false;
  return true;
}

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
   * Estimated cold-generation latency, embedded on the "create"
   * fallback result's `plan.estimatedLatencyMs`. Default 30s.
   */
  estimatedGenerationLatencyMs?: number;
  /**
   * Blueprint-registry deps for the handshake-time exact-key match
   * fast path. When bound, every `decide()` call first asks
   * `matchBlueprint` whether the agent's draft canonical-key-equals
   * an already-registered blueprint. A hit short-circuits the synth
   * LLM round-trip and returns `origin: 'cache'` with the cached
   * blueprint's contract + codeHash.
   *
   * The exact-key strategy is the only safe match when a contract is
   * supplied (see the fuzzy-match gate in `blueprint-matcher.ts` —
   * fuzzy matches across non-equal canonical contracts let cached
   * call sites drift from the request's actionSpec/contextSpec wire
   * surface).
   * Semantic strategy fires only when contract is omitted, which the
   * handshake input schema today disallows.
   *
   * Optional so deployments without RAG infrastructure (no embedding
   * / vector store) continue to use the synth-only path. Mirrors the
   * shape used by `push.ts:1539-1541` so a single
   * `generationWithCache.cache` value threads into both seams.
   */
  cache?: {
    readonly embedding: EmbeddingProvider;
    readonly vectorStore: VectorStore;
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
}

const DEFAULT_GEN_LATENCY_MS = 30_000;

function buildCreateFallback(
  draftContract: DataContract,
  reason: string,
  _estimatedLatencyMs: number
): HandshakeNegotiatorResult {
  // Fallback path stamps an `origin: 'agent'` suggestion against the
  // agent's draft. Gen-pending; no codeHash; provisional blueprintId.
  const contractHash = blueprintKey(draftContract);
  const suggestion: HandshakeSuggestion = {
    origin: "agent",
    rationale: reason,
    blueprintMeta: {
      blueprintId: `bp_${randomUUID()}`,
      contractHash,
      generator: "ui-gen-default-haiku-4-5",
      variance: {},
    },
  };
  return {
    action: "create",
    reason,
    suggestion,
    effectiveContract: draftContract,
  };
}

/**
 * Build an LLM-backed `HandshakeNegotiator` for the OSS server.
 * Wires BYOK creds + an LLM provider adapter into
 * `@ggui-ai/negotiator`'s `negotiate()` pipeline. Operators get the
 * same negotiation shape cloud uses, with RAG gracefully degraded
 * (no embedding / vectors required).
 *
 * @public
 */
export function createLlmBackedHandshakeNegotiator(
  deps: LlmBackedHandshakeNegotiatorDeps
): HandshakeNegotiator {
  const estimatedLatencyMs = deps.estimatedGenerationLatencyMs ?? DEFAULT_GEN_LATENCY_MS;

  return {
    async decide({ intent, blueprintDraft, gadgets, ctx }): Promise<HandshakeNegotiatorResult> {
      const draftContract = blueprintDraft.contract;

      // Handshake-time exact-key fast path. Runs BEFORE the BYOK
      // creds resolve + LLM synth — a cache hit needs neither the
      // operator's API key nor a model round-trip. When the agent's
      // draft canonical-key-equals a registered blueprint, return
      // `origin: 'cache'` with the matched blueprint's contract +
      // componentCode hash so the paired push.accept short-circuits
      // straight into commitCachedRender.
      //
      // No-match (or any throw) falls through to today's synth path
      // — the negotiator stays useful when the registry is cold,
      // when matchBlueprint hiccups, or when the deployment skipped
      // the cache deps entirely.
      if (deps.cache) {
        try {
          const matchDeps: MatchBlueprintDeps = {
            registry: deps.cache,
            ...(deps.installedBlueprints ? { installedBlueprints: deps.installedBlueprints } : {}),
          };
          const matchResult = await matchBlueprint(matchDeps, ctx.appId, {
            intent,
            contract: draftContract,
          });
          if (matchResult.strategy === "exact-key") {
            const matched = matchResult.blueprint;
            const codeHash = createHash("sha256").update(matched.componentCode).digest("hex");
            const suggestion: HandshakeSuggestion = {
              origin: "cache",
              rationale: matchResult.reason,
              blueprintMeta: {
                blueprintId: matched.id,
                contractHash: matched.contractKey,
                codeHash,
                generator: DEFAULT_GENERATOR_SLUG,
                variance: {},
                selectedReason: matchResult.reason,
              },
            };
            return {
              action: "reuse",
              reason: matchResult.reason,
              suggestion,
              effectiveContract: matched.contract,
            };
          }
          // Other strategies (no-match, semantic) fall through to
          // the negotiate() path below. Semantic doesn't fire when
          // a contract is supplied (the fuzzy-match gate blocks it);
          // listing it here is structural completeness, not a
          // reachable branch today.
        } catch (err) {
          if (!isOperationalError(err)) throw err;
          // Registry hiccup — log + fall through to synth so the
          // handshake never crashes on a transient cache backend
          // issue.
          const message = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console -- operator-visible signal
          console.warn(
            `[llm-backed-negotiator] matchBlueprint exact-key probe failed; falling through to synth: ${message}`
          );
        }
      }

      const creds = await deps.resolveLlm(ctx);
      if (!creds) {
        return buildCreateFallback(
          draftContract,
          "no-creds: no BYOK credentials resolved for the configured provider; ggui_render will surface the same error and the handshake stays a no-op create.",
          estimatedLatencyMs
        );
      }

      try {
        const llm = buildLlmCaller(creds.selection, creds.providerKey);
        const declaredAgentTools = Object.keys(draftContract.agentCapabilities?.tools ?? {});
        const synthPrompt = blueprintDraft.variance?.seedPrompt ?? intent;
        const result = await negotiate(
          { llm },
          {
            agent: {
              prompt: synthPrompt,
              ...(declaredAgentTools.length > 0 ? { agentTools: declaredAgentTools } : {}),
              ...(gadgets !== undefined ? { gadgets } : {}),
            },
            config: {
              appId: ctx.appId,
              // Handshake runs ahead of any concrete render — no renderId
              // is bound yet. The negotiator only uses `renderId` to key
              // its optional `readRenderState` callback, which the OSS
              // path doesn't wire here, so a stable placeholder works.
              renderId: "handshake",
              includeSharedPool: false,
            },
          }
        );

        const decision = result.decision;
        const contract = decision.contract;
        const contractHash = result.storedContractHash ?? blueprintKey(contract);
        const draftHash = blueprintKey(draftContract);
        const blueprintId = decision.blueprintId;

        // Origin routing:
        //   - blueprintId present (cache hit) → origin: 'cache'
        //   - contract == draft               → origin: 'agent'
        //   - contract != draft               → origin: 'synth'
        let suggestion: HandshakeSuggestion;
        if (blueprintId) {
          suggestion = {
            origin: "cache",
            rationale: decision.reasoning ?? `cache match (${blueprintId})`,
            blueprintMeta: {
              blueprintId,
              contractHash,
              generator: "ui-gen-default-haiku-4-5",
              variance: {},
            },
          };
        } else if (contractHash === draftHash) {
          suggestion = {
            origin: "agent",
            rationale: decision.reasoning ?? "novel-but-clean contract",
            blueprintMeta: {
              blueprintId: `bp_${randomUUID()}`,
              contractHash,
              generator: "ui-gen-default-haiku-4-5",
              variance: {},
            },
          };
        } else {
          suggestion = {
            origin: "synth",
            rationale: decision.reasoning ?? "synth amended contract",
            blueprintMeta: {
              blueprintId: `bp_${randomUUID()}`,
              contractHash,
              generator: "ui-gen-default-haiku-4-5",
              variance: {},
            },
            amendments: {
              contractDiff: [
                {
                  op: "replace",
                  path: "",
                  value: contract as unknown as import("@ggui-ai/protocol").JsonValue,
                },
              ],
              reasoning: decision.reasoning ?? "negotiator-amended contract",
            },
          };
        }

        return {
          action: blueprintId ? "reuse" : "create",
          reason: decision.reasoning ?? "negotiated",
          suggestion,
          effectiveContract: contract,
        };
      } catch (err) {
        if (!isOperationalError(err)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        const errorClass = err instanceof Error ? err.name : "unknown";
        return buildCreateFallback(
          draftContract,
          `negotiator-degraded: ${errorClass} during decision LLM call — ${message}. Falling back to bare-create; the paired ggui_render will still generate the UI.`,
          estimatedLatencyMs
        );
      }
    },

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
