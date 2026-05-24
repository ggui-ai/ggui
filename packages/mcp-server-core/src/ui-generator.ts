/**
 * UiGenerator — the harness contract.
 *
 * This is what the OSS `@ggui-ai/mcp-server` and the hosted runtime
 * both call to turn an agent's `ggui_push` request into renderable
 * component code. The open-source `@ggui-ai/ui-gen` package implements
 * this interface. Self-hosters can swap in their own implementation if
 * they want.
 */
import type {
  BlueprintVariance,
  GadgetDescriptor,
  DataContract,
  UIGenerationRequest,
  UIGenerationResponse,
  GenerationError,
  ProgressUpdate,
} from '@ggui-ai/protocol';
import type { BlueprintProvider } from './blueprint-provider.js';

/**
 * LLM provider identifier. Matches the harness's provider router.
 */
export type LlmProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'bedrock'
  | 'openrouter';

/**
 * Generator tier — coarse quality / cost / latency band. Two values
 * are recognized:
 *
 *   - `'default'` — single-pass generation, sub-second, no Playwright.
 *     Today's `@ggui-ai/ui-gen` path; the OSS default.
 *   - `'advanced'` — iterative validator-feedback loop with Playwright
 *     visual checks. Slower, higher quality, opt-in deploy.
 *
 * Operators may introduce custom tiers (`'enterprise'`, `'realtime'`,
 * etc.) — the type intersects with `(string & {})` so TS keeps the
 * autocomplete suggestions while accepting any string. Registry +
 * slug parser do not constrain the tier value beyond grammar rules.
 */
export type GeneratorTier = 'default' | 'advanced' | (string & {});

/**
 * LLM selection for a single generation. Resolved upstream by the server
 * (plan precedence: app config → workspace default → builder default).
 */
export interface LlmSelection {
  provider: LlmProvider;
  /** Provider-specific model ID, e.g. "claude-opus-4-7", "gpt-4o-2024-08". */
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Provider credential passed to the harness at generation time. Plaintext at
 * the UiGenerator boundary — the caller (server) resolves it from a
 * {@link ProviderKeyStore} before invoking. The harness must not persist it.
 */
export interface ProviderKeyRef {
  provider: LlmProvider;
  /** Opaque credential — API key, bearer token, or assume-role ARN. */
  key: string;
}

/**
 * Input envelope for a single UI generation.
 */
export interface UiGenerateInput {
  /** The agent's push request (prompt, schema, context, adapters). */
  request: UIGenerationRequest;
  /** Which LLM to use for this generation. */
  llm: LlmSelection;
  /** BYOK credential for the selected provider. */
  providerKey: ProviderKeyRef;
  /** Blueprint provider for cache hits and RAG lookups. */
  blueprints: BlueprintProvider;
  /**
   * Optional contract envelope the generator should conform to.
   *
   * When provided, the tier-0 CHECK that runs post-generation feeds
   * the contract into wire-preservation (useAction/useStream names
   * the generated code calls must appear in `actionSpec`/`streamSpec`)
   * and contract-validation (`actionSpec[name].schema`,
   * `streamSpec[name].schema`, `props` schema sanity). Contract-free
   * checks (security, forbidden imports, wire-import presence, react-
   * linter, Props-interface, default-export, pitfalls) still fire on
   * sourceCode alone when this is absent.
   *
   * Callers (ggui_push handler, self-hosted integrations) populate
   * from the blueprint/story envelope they already hold. Caller is
   * responsible for ensuring the contract matches what the LLM was
   * instructed to generate against — the generator does not re-derive.
   */
  contract?: DataContract;
  /**
   * Optional variance signals — persona, aesthetic, context,
   * seedPrompt — forwarded from the agent's `BlueprintDraft.variance`
   * (or the equivalent override draft's variance). When present, the
   * generator surfaces a "Variance" block in the user prompt so cold-gen
   * produces a component aligned with the requested persona/aesthetic.
   *
   * Cache-hit paths do NOT thread variance through here — those commit
   * the cached blueprint's pre-baked componentCode directly without
   * re-generation, so the cached blueprint's own `variance` field is
   * what was respected at original gen time.
   *
   * Absent → generator runs the default styling pass.
   */
  variance?: BlueprintVariance;
  /**
   * Optional rendering hint — device + shell + viewport. When present,
   * the generator surfaces a "Rendering Context" block in the user
   * prompt so the LLM picks an appropriate sizing strategy (e.g., a
   * `chat` shell sized 300-600px vs a `fullscreen` shell at 100vh).
   *
   * Mirrors the shape the hosted runtime's dispatch path passes through
   * `harness/result-types.RenderingContext`. Optional — callers without
   * a hint produce universal-shell components.
   */
  rendering?: {
    device: 'mobile' | 'tablet' | 'desktop' | 'spatial';
    shell: 'chat' | 'fullscreen' | 'partial';
    viewport?: { width: number; height: number };
  };
  /**
   * Operator-registered gadget catalog (`App.gadgets`)
   * to surface in the code-gen system prompt's `clientCapabilities —
   * registered catalog` table. Threaded by the push handler from the
   * bound `AppMetadataStore` so the code-gen LLM sees the same plugin
   * set as the synth + decision LLMs (via the negotiator's
   * `composeAvailableGadgetsSection`).
   *
   * Omit to let the system prompt default to `STDLIB_GADGETS`
   * (the 7 first-party browser-capability hooks). Callers that do
   * not use gadgets stay byte-identical at the prompt level when
   * this is absent.
   *
   * Callers who wired a `gadgetCatalog` at
   * `createUiGenerator` factory time MAY omit this field and instead
   * pass {@link UiGenerateInput.appId}; the generator resolves the
   * descriptor list via `gadgetCatalog.list(appId)`. `appGadgets`
   * wins on precedence when both are supplied (handler-side
   * pre-fetch path stays authoritative).
   */
  appGadgets?: readonly GadgetDescriptor[];
  /**
   * App identifier for catalog-side gadget resolution. Used only when
   * `appGadgets` is absent AND the
   * `createUiGenerator({ gadgetCatalog })` option was supplied. The
   * generator calls `gadgetCatalog.list(appId)` to resolve the
   * descriptor list per call.
   *
   * Optional. Callers that pre-fetch `appGadgets` themselves
   * can ignore this field.
   */
  appId?: string;
  /**
   * `package → .d.ts content` map for the non-stdlib
   * gadgets this contract uses. The push handler parallel-fetches
   * each registered descriptor's `typesUrl` (SRI-verified) via
   * `fetchGadgetTypes` and threads the result here.
   *
   * The code-gen sandbox loads each entry into the type-checker VFS
   * at `node_modules/<package>/index.d.ts`, so the augmentation's
   * `<hook>: typeof import('<package>').<hook>` resolves against the
   * wrapper's REAL declaration — named types preserved — instead of
   * collapsing to `any`. The same `.d.ts` content also feeds the
   * prompt's per-gadget `Type:` line.
   *
   * Plain `Record` (not `Map`) so the shape survives the cloud
   * pod's serialized `UiGenerateInput` boundary. Stdlib
   * (`@ggui-ai/gadgets`) never appears here — the sandbox VFS
   * carries its types directly.
   *
   * Absent / empty → no third-party gadget types to overlay.
   */
  gadgetTypes?: Readonly<Record<string, string>>;
  /**
   * Optional infra-side hint for the resolved generator. MP.5
   * (2026-05-24): introduced so agent callers can override the
   * server's default model per-render — `infra.model` is the only
   * field at v1; future expansion (temperature, max_tokens, etc.)
   * lands here additively.
   *
   * `model` MUST be a LiteLLM-format id (`provider/model-name`) OR a
   * cloud-specific Bedrock alias (`bedrock/<bedrock-model-id>`). The
   * generator decides routing from the prefix; OSS callers without a
   * cloud pod read `infra.model` only when their bound generator
   * honors it.
   *
   * Cloud pod (`@ggui-cloud/ggui-protocol-pod`): the
   * `generator` override threads `infra.model` into
   * `RunGenerationArgs.model`, which dispatches through
   * `resolvePoolRoute`.
   *
   * Self-hosted OSS callers: typically read `infra.model` inside
   * their `resolveLlm` impl to override the workspace default.
   */
  infra?: {
    readonly model?: string;
  };
  /** Abort cancellation — server may cancel on session close or timeout. */
  signal?: AbortSignal;
}

/**
 * Metadata emitted alongside every result (success or failure) for telemetry.
 */
export interface GenerationMetadata {
  provider: LlmProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** True if served from a blueprint cache hit (Tier 0); no LLM was called. */
  cacheHit: boolean;
  /** Retry / turn count. 0 means single-shot success. */
  attempts?: number;
  /**
   * Optional generator-specific routing tag for finer-grained
   * telemetry. The bound generator decides the value space; consumers
   * treat it as an opaque label they log + group by.
   *
   * Examples — a generator that supports multiple transports for the
   * same provider (direct API vs proxied) may emit
   * `'<provider>-direct'` vs `'<provider>-proxy'` so per-transport
   * spend is queryable without re-deriving from `(provider, model)`.
   * Generators that route through a single path may omit the field.
   */
  routeKind?: string;
}

/**
 * Result of a non-streaming generation. Discriminated on `ok`.
 */
export type UiGenerateResult =
  | { ok: true; response: UIGenerationResponse; metadata: GenerationMetadata }
  | { ok: false; error: GenerationError; metadata?: GenerationMetadata };

/**
 * Events yielded during a streaming generation. The stream always terminates
 * with a `done` event carrying the final `UiGenerateResult`.
 */
export type UiGenerateEvent =
  | { type: 'progress'; progress: ProgressUpdate }
  | { type: 'partial'; chunk: string }
  | { type: 'done'; result: UiGenerateResult };

/**
 * The contract. Implementations:
 *   - `@ggui-ai/ui-gen`       open-source package; real LLM harness
 *   - test doubles / mocks    for unit testing the server
 *   - custom self-hosted fork anyone replacing our harness
 *
 * `generate()` is required. `stream()` is OPTIONAL — servers may call it
 * opportunistically for live progress and fall back to `generate()` when
 * absent.
 *
 * Identity fields — required:
 *
 *   - `slug` is the registry key and the stable handle stored on each
 *     {@link Blueprint} row. Pattern `ui-gen-<tier>-<model>`.
 *   - `tier` + `model` are the slug's parsed components, surfaced
 *     directly so callers don't re-parse on every access.
 *
 * The slug, tier, and model an implementation declares describe its
 * declared identity (which model the operator stood it up for). The
 * actual model used per request still comes from
 * `UiGenerateInput.llm.model` — operators may override via BYOK. The
 * identity is the registry-level handle, not a runtime constraint.
 */
export interface UiGenerator {
  /** Stable registry key, e.g. `ui-gen-default-haiku-4-5`. */
  readonly slug: string;
  /** Quality / cost tier — `'default'` or `'advanced'` at v1. */
  readonly tier: GeneratorTier;
  /** Canonical model identifier this generator was registered for. */
  readonly model: string;
  generate(input: UiGenerateInput): Promise<UiGenerateResult>;
  stream?(input: UiGenerateInput): AsyncIterable<UiGenerateEvent>;
}
