/**
 * Typed `LlmRoute` system — the structural-correctness replacement for
 * string-typed model identifiers.
 *
 * Two concepts, one type:
 *   - `provider` — the API endpoint you authenticate against, owns its
 *     own model namespace. Includes marketplaces (Bedrock, OpenRouter)
 *     and direct-author APIs (Claude/Anthropic, OpenAI, Google AI
 *     Studio). NOT a separate "platform" dimension — each provider's
 *     API surface IS the platform.
 *   - `model` — the wire-canonical string for THIS provider. Registry
 *     KEY == what goes on the HTTP wire to the provider. No
 *     transformation at dispatch — what you write in `MODELS[provider]`
 *     is exactly what the API sees.
 *
 * Why this exists: three bugs of the same class in one week (#22 CLI
 * sent slash-prefixed `google/gemini-3.5-flash` → Gemini 404; #42
 * mcp-server negotiator sent `anthropic/claude-haiku-4-5` → Anthropic
 * 404; the next one would have been...). The pattern was always
 * "someone wrote a code path that bypassed `getUpstreamModelId`". The
 * typed-route system makes the bug class structurally impossible —
 * `LlmRoute` is a discriminated union, the dispatch is
 * exhaustiveness-checked, and there's no transformation step to
 * forget because the model string IS the wire form.
 *
 * Slice spec: `docs/plans/2026-05-25-llm-route-typed-system.md`
 */

// ============================================================================
// MODELS registry — single source of truth
// ============================================================================

/**
 * Wire-canonical model names per provider. The KEY for each entry is
 * EXACTLY what the provider's API expects on the wire — no
 * transformation, no prefix-strip, no map. Register a new model by
 * adding its wire-canonical string to the matching provider's array.
 *
 * Provider naming uses the COMPANY name for consistency across all
 * providers (`anthropic`, `openai`, `google`) — matches LiteLLM's
 * `anthropic/` prefix + the existing `ANTHROPIC_API_KEY` env var
 * convention. Marketplaces (`bedrock`, `openrouter`) keep their
 * platform name because that IS the company you authenticate against.
 *
 *   - `anthropic` — Anthropic's direct API
 *     (`api.anthropic.com`). Auth: `ANTHROPIC_API_KEY`.
 *   - `openai` — OpenAI's direct API.
 *   - `google` — Google AI Studio (`generativelanguage.googleapis.com`).
 *   - `bedrock` — AWS Bedrock marketplace. Region prefix (`us.`,
 *     `eu.`, `apac.`) is part of the wire name; each region is its
 *     own registry entry, not a `{region}` field.
 *   - `openrouter` — OpenRouter marketplace. Authors are sub-namespaced
 *     in the model string (`<author>/<model>`).
 *   - `vertex` — DEFERRED to its own slice. Vertex needs region +
 *     projectId + GCP IAM setup; migration is purely additive when
 *     ready.
 */
export const MODELS = {
  anthropic: [
    // Wire-canonical IDs accepted by api.anthropic.com/v1/messages.
    // Per Anthropic's official models doc (claude.com/docs/about-claude/models/overview):
    // 4.6/4.7 generation dropped the date suffix in the wire ID;
    // Haiku 4.5 still uses the dated form.
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'claude-opus-4-6',
  ],
  openai: [
    // Per OpenAI's model registry (developers.openai.com/api/docs/models/all).
    // Both unversioned aliases AND dated snapshots are valid wire IDs;
    // we enumerate both because operators reasonably use either.
    'gpt-5.5',
    'gpt-5.5-2026-04-23',
    'gpt-5.5-pro',
    'gpt-5.5-pro-2026-04-23',
    'gpt-5.4',
    'gpt-5.4-2026-03-05',
    'gpt-5.4-mini',
    'gpt-5.4-mini-2026-03-17',
    'gpt-5.4-nano',
    'gpt-5.4-nano-2026-03-17',
    'gpt-5.3-codex',
  ],
  google: [
    // Per Google AI Studio's model registry (ai.google.dev/gemini-api/docs/models).
    // Stable + the commonly-used previews. The `-preview` suffix is
    // load-bearing on the wire for preview models — Gemini's API
    // rejects the bare name for those.
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-3-flash-preview',
  ],
  bedrock: [
    // AWS cross-region inference profile IDs. Each region is its own
    // wire-canonical entry — no `{region}` field on the route.
    // Per AWS docs the 4.6/4.7 generation dropped `-vN:0`; Haiku 4.5
    // keeps it. Coverage per region (us/eu/apac/global) varies per
    // model — verify on individual model card pages under
    // docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html
    // before locking expanded coverage.

    // Haiku 4.5 — has full us/eu/apac/global coverage per Anthropic docs
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    'apac.anthropic.claude-haiku-4-5-20251001-v1:0',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',

    // Sonnet 4.6 — current generation, full multi-region per Anthropic docs
    'us.anthropic.claude-sonnet-4-6',
    'eu.anthropic.claude-sonnet-4-6',
    'apac.anthropic.claude-sonnet-4-6',

    // Opus 4.7 — current generation, full multi-region per Anthropic docs
    'us.anthropic.claude-opus-4-7',
    'eu.anthropic.claude-opus-4-7',
    'apac.anthropic.claude-opus-4-7',
    'global.anthropic.claude-opus-4-7',

    // Opus 4.6 — legacy generation, US-only profile listed in Anthropic docs
    'us.anthropic.claude-opus-4-6-v1',
  ],
  openrouter: [
    // Commonly-used routes get type-level coverage. Arbitrary
    // `<author>/<model>` strings are also accepted at runtime via the
    // `string & {}` escape hatch on the `ModelOf<'openrouter'>` type
    // — OpenRouter hosts hundreds of model permutations and
    // enumerating all of them in source would create a maintenance
    // burden the type system can't repay.
    // Curated from a live fetch of openrouter.ai/api/v1/models (358
    // models on 2026-05-25). Picks favor the latest stable slug per
    // slot, skipping `:free`, dated `-preview-MMDD`, `-fast`, image/
    // audio/vision-only variants. Note OpenRouter uses dot-separator
    // for Anthropic version (`claude-haiku-4.5`) where Anthropic direct
    // uses dash (`claude-haiku-4-5`) — preserve OpenRouter's wire form.

    // Anthropic family
    'anthropic/claude-haiku-4.5',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-4.7',
    // OpenAI family
    'openai/gpt-5.5',
    'openai/gpt-5.5-pro',
    'openai/gpt-5.4-mini',
    'openai/gpt-5.4-nano',
    // Google family
    'google/gemini-3.5-flash',
    'google/gemini-3.1-pro-preview',
    'google/gemini-3.1-flash-lite',
    // Frontier alternatives
    'x-ai/grok-4.3',
    // Open-source heavy hitters
    'meta-llama/llama-4-maverick',
    'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-r1-0528',
    'qwen/qwen3.7-max',
    'qwen/qwen3-coder',
    'mistralai/mistral-large-2512',
    'openai/gpt-oss-120b',
  ],
} as const;

// ============================================================================
// Derived types — autoupdate when the registry grows
// ============================================================================

/**
 * Every supported LLM provider. Adding a new provider = add a key to
 * `MODELS` + add a dispatch case wherever `LlmRoute` is consumed (TS
 * exhaustiveness check forces handling).
 */
export type LlmProvider = keyof typeof MODELS;

/**
 * Model names known at compile time for a given provider. For
 * OpenRouter, this is the enumerated subset; for every other provider,
 * this is the full set (their model lists are small + stable).
 */
export type KnownModelOf<P extends LlmProvider> = (typeof MODELS)[P][number];

/**
 * Model names accepted on a route for a given provider. OpenRouter's
 * `<author>/<model>` permutation space is too large to enumerate
 * exhaustively — accept arbitrary strings at runtime, validated by
 * shape via {@link isValidOpenrouterModel}. Every other provider is
 * strict-enum: only the names in `MODELS[provider]` typecheck.
 *
 * The `(string & {})` trick preserves IDE autocomplete on the known
 * subset while still accepting arbitrary strings — without it, the
 * union collapses to `string` and the known entries lose autocomplete.
 */
export type ModelOf<P extends LlmProvider> = P extends 'openrouter'
  ? KnownModelOf<'openrouter'> | (string & {})
  : KnownModelOf<P>;

/**
 * A typed LLM call target. The pair `(provider, model)` is sufficient
 * — `provider` selects the SDK / endpoint / auth scheme, `model` is
 * the wire string that SDK sends literally.
 *
 * Discriminated union via mapped type: `LlmRoute` is the union of
 * `{provider: P, model: ModelOf<P>}` for every `P`. TypeScript
 * enforces that the model belongs to the provider's namespace — e.g.
 * `{provider: 'bedrock', model: 'claude-haiku-4-5-20251001'}` is a
 * compile error (that model lives under `claude`, not `bedrock`).
 *
 * Vertex AI is deferred — it needs `region` and `projectId` fields
 * for endpoint construction + IAM. When added, the Vertex variant
 * will look like `{provider: 'vertex', model: ..., region: ...,
 * projectId: ...}` — purely additive, doesn't disturb existing routes.
 */
export type LlmRoute = {
  [P in LlmProvider]: { provider: P; model: ModelOf<P> };
}[LlmProvider];

// ============================================================================
// Type guards
// ============================================================================

/**
 * Runtime type guard for the provider enum. Pairs with the parser at
 * wire boundaries (ggui.json, CLI flags, env vars) where the value
 * arrives as an unvalidated string.
 */
export function isLlmProvider(s: string): s is LlmProvider {
  return s in MODELS;
}

/**
 * Runtime type guard for a known model string under a given provider.
 * Strict-enum check; does NOT accept OpenRouter's arbitrary-string
 * extension — for that, use {@link isValidOpenrouterModel}.
 */
export function isKnownModel<P extends LlmProvider>(
  provider: P,
  model: string,
): model is KnownModelOf<P> {
  return (MODELS[provider] as readonly string[]).includes(model);
}

/**
 * Validate an OpenRouter model string by shape: `<author>/<model>`
 * where both segments are non-empty and contain only the characters
 * OpenRouter's catalog uses (alphanumerics + `-` + `.` + `_` + `:`).
 *
 * Used for the OpenRouter escape hatch — strings that pass this check
 * are accepted into `LlmRoute` even if not in `MODELS.openrouter[]`.
 * Strings that fail it are rejected at the parser boundary.
 */
export function isValidOpenrouterModel(s: string): boolean {
  // `<author>/<model>` with both segments non-empty.
  // Permissive char class: alphanumerics, `-`, `.`, `_`, `:`, and one
  // `/` separator. OpenRouter's catalog uses all of these.
  return /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/.test(s);
}

/**
 * Validate that a (provider, model) pair would construct a valid
 * `LlmRoute`. Handles the OpenRouter arbitrary-string escape hatch
 * — for OpenRouter, accepts any string passing
 * {@link isValidOpenrouterModel}; for every other provider, requires
 * the model to be in `MODELS[provider]`.
 */
export function isValidLlmRoute(provider: string, model: string): boolean {
  if (!isLlmProvider(provider)) return false;
  if (provider === 'openrouter') {
    return isKnownModel('openrouter', model) || isValidOpenrouterModel(model);
  }
  return isKnownModel(provider, model);
}

// ============================================================================
// Canonical serialization — `provider:model`
// ============================================================================

/**
 * Canonical wire format separator. `:` chosen over `/` because
 * `/` collides with OpenRouter's own `<author>/<model>` form
 * (`openrouter/anthropic/claude-3-5-sonnet` has TWO slashes; ambiguous
 * to split). Bedrock's model string also contains `.` and `:` — `:`
 * is fine as the OUTER separator because the inner `:` is always
 * preceded by a `.` or alphanumerics; the FIRST `:` in the serialized
 * string is unambiguously the provider/model boundary.
 */
const CANONICAL_SEPARATOR = ':';

/**
 * Serialize an `LlmRoute` to the canonical `provider:model` string.
 * Round-trip with {@link parseLlmRoute}. Used for human-readable
 * logging, `ggui.json` config values, and CLI `--model` flags.
 *
 * Examples:
 *   `{provider: 'anthropic', model: 'claude-haiku-4-5-20251001'}`
 *     → `'anthropic:claude-haiku-4-5-20251001'`
 *   `{provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0'}`
 *     → `'bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0'`
 *   `{provider: 'openrouter', model: 'anthropic/claude-3-5-sonnet'}`
 *     → `'openrouter:anthropic/claude-3-5-sonnet'`
 */
export function serializeLlmRoute(route: LlmRoute): string {
  return `${route.provider}${CANONICAL_SEPARATOR}${route.model}`;
}

/**
 * Parse a canonical `provider:model` string into an `LlmRoute`.
 * Returns `null` if the string isn't well-formed or if (provider,
 * model) wouldn't construct a valid route. Permissive on the model
 * side for OpenRouter — accepts any string passing
 * {@link isValidOpenrouterModel} even when not in `MODELS.openrouter[]`.
 *
 * Round-trip with {@link serializeLlmRoute}.
 */
export function parseLlmRoute(serialized: string): LlmRoute | null {
  const sep = serialized.indexOf(CANONICAL_SEPARATOR);
  if (sep <= 0) return null;
  const provider = serialized.substring(0, sep);
  const model = serialized.substring(sep + 1);
  if (model.length === 0) return null;
  if (!isValidLlmRoute(provider, model)) return null;
  return { provider, model } as LlmRoute;
}

// ============================================================================
// LiteLLM back-compat parser/serializer
// ============================================================================

/**
 * Map from LiteLLM transport prefix → our `LlmProvider` enum. Used by
 * {@link parseLiteLlmString} to accept legacy ggui.json files and
 * ecosystem inputs without forcing a migration on every operator.
 *
 * Note: LiteLLM separates `gemini/` (AI Studio) from `vertex_ai/`
 * (enterprise Vertex). We don't have a Vertex variant in this slice;
 * `vertex_ai/` parsing falls through to `null` until Vertex lands.
 */
const LITELLM_PROVIDER_PREFIX_MAP: Record<string, LlmProvider> = {
  anthropic: 'anthropic',
  gemini: 'google',
  openai: 'openai',
  bedrock: 'bedrock',
  openrouter: 'openrouter',
};

/**
 * LiteLLM canonical → wire-canonical model mappings for providers
 * whose LiteLLM-form differs from the wire-canonical form.
 * Anthropic's LiteLLM strings (`anthropic/claude-haiku-4-5`) map to
 * dated wire IDs (`claude-haiku-4-5-20251001`).
 *
 * For providers where LiteLLM form == wire form (Gemini, OpenAI,
 * OpenRouter), no mapping is needed — the parser passes the model
 * through after stripping the prefix.
 */
const LITELLM_TO_WIRE: Partial<Record<LlmProvider, Record<string, string>>> = {
  // Anthropic's 4.6/4.7 generation wire IDs ARE the short LiteLLM
  // form (no date suffix), so no mapping needed for those. Only
  // Haiku 4.5 keeps the dated wire form, so it needs an explicit
  // LiteLLM-short → wire-dated entry. Adding a new mapping here is
  // only required when the LiteLLM short form differs from the wire
  // ID (typically only Anthropic Haiku-class models, which keep
  // dated IDs per Anthropic convention).
  anthropic: {
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  },
};

/**
 * Parse a LiteLLM-format string (`<prefix>/<model>` or
 * `<prefix>/<sub>/<model>` for OpenRouter) into an `LlmRoute`.
 * Returns `null` if the prefix is unknown or the resulting route
 * wouldn't construct.
 *
 * Supports the historical formats ggui has used:
 *   - `anthropic/claude-haiku-4-5` → `{anthropic, claude-haiku-4-5-20251001}`
 *   - `gemini/gemini-3.5-flash`    → `{google, gemini-3.5-flash}`
 *   - `openai/gpt-5.5-...`         → `{openai, gpt-5.5-...}`
 *   - `bedrock/us.anthropic...`    → `{bedrock, us.anthropic...}`
 *   - `openrouter/anthropic/claude-3-5-sonnet`
 *     → `{openrouter, anthropic/claude-3-5-sonnet}`
 *
 * Used at wire boundaries (ggui.json parser, CLI flag, env var) so
 * existing operator configs keep working without a forced migration.
 */
export function parseLiteLlmString(s: string): LlmRoute | null {
  const firstSlash = s.indexOf('/');
  if (firstSlash <= 0) return null;
  const prefix = s.substring(0, firstSlash);
  const provider = LITELLM_PROVIDER_PREFIX_MAP[prefix];
  if (!provider) return null;
  // For OpenRouter the model is everything after the first slash
  // (which itself includes a `<author>/<model>` sub-path); for
  // every other provider, it's also everything after the first slash
  // but with no internal `/`.
  const rawModel = s.substring(firstSlash + 1);
  if (rawModel.length === 0) return null;
  // Apply LiteLLM → wire mapping if one exists for this provider.
  const mapped = LITELLM_TO_WIRE[provider]?.[rawModel] ?? rawModel;
  if (!isValidLlmRoute(provider, mapped)) return null;
  return { provider, model: mapped } as LlmRoute;
}

/**
 * Inverse mapping for {@link toLiteLlmString} — wire-canonical model
 * back to the LiteLLM short form for a provider's LiteLLM serialization.
 * Built lazily by inverting LITELLM_TO_WIRE on first use.
 */
let WIRE_TO_LITELLM_CACHE: Partial<Record<LlmProvider, Record<string, string>>> | null = null;
function getWireToLitellm(): Partial<Record<LlmProvider, Record<string, string>>> {
  if (WIRE_TO_LITELLM_CACHE) return WIRE_TO_LITELLM_CACHE;
  const out: Partial<Record<LlmProvider, Record<string, string>>> = {};
  for (const [provider, map] of Object.entries(LITELLM_TO_WIRE)) {
    if (!map) continue;
    const inverted: Record<string, string> = {};
    for (const [litellm, wire] of Object.entries(map)) {
      inverted[wire] = litellm;
    }
    out[provider as LlmProvider] = inverted;
  }
  WIRE_TO_LITELLM_CACHE = out;
  return out;
}

/**
 * Serialize an `LlmRoute` to LiteLLM format for outbound observability
 * (Datadog, PostHog, OpenTelemetry `gen_ai.*` semantic conventions
 * recognize LiteLLM IDs). Inverse of {@link parseLiteLlmString}.
 *
 *   `{provider: 'anthropic', model: 'claude-haiku-4-5-20251001'}`
 *     → `'anthropic/claude-haiku-4-5'`
 *
 * For models without an explicit LITELLM_TO_WIRE mapping (Gemini,
 * OpenAI, OpenRouter), serialization uses the wire model as-is.
 */
export function toLiteLlmString(route: LlmRoute): string {
  const prefix = providerLiteLlmPrefix(route.provider);
  const inverseMap = getWireToLitellm()[route.provider];
  const modelForLitellm = inverseMap?.[route.model] ?? route.model;
  return `${prefix}/${modelForLitellm}`;
}

function providerLiteLlmPrefix(provider: LlmProvider): string {
  // Find the LiteLLM prefix that maps to this provider. There's at
  // most one prefix per provider in LITELLM_PROVIDER_PREFIX_MAP today.
  for (const [prefix, p] of Object.entries(LITELLM_PROVIDER_PREFIX_MAP)) {
    if (p === provider) return prefix;
  }
  // Defensive: every provider in MODELS should have a LiteLLM prefix.
  // If not, fall through to the provider's own name (degrades gracefully
  // for observability — the trace just won't match LiteLLM's exact
  // wording, but it still names the provider).
  return provider;
}

// ============================================================================
// Combined parser (accepts either format)
// ============================================================================

/**
 * Single-entry parser that accepts both canonical (`provider:model`)
 * and LiteLLM (`prefix/model`) formats. Used at wire boundaries that
 * receive unvalidated strings — `ggui.json#generation.model`, CLI
 * `--model` flag, env-var defaults.
 *
 * Tries the canonical form first (no internal `/` ambiguity); if it
 * doesn't parse, falls back to LiteLLM. Returns `null` if neither
 * format produces a valid route.
 */
export function parseAnyLlmRoute(s: string): LlmRoute | null {
  return parseLlmRoute(s) ?? parseLiteLlmString(s);
}
