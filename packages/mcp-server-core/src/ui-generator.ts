/**
 * UiGenerator — the harness contract.
 *
 * This is what the OSS `@ggui-ai/mcp-server` and the hosted runtime
 * both call to turn an agent's `ggui_render` request into renderable
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
  LlmProvider,
  LlmRoute,
  GeneratorId,
  ModelRef,
  AppGenerationProfile,
  JsonObject,
} from '@ggui-ai/protocol';
import type { RenderingContext } from '@ggui-ai/protocol';
import type { BlueprintProvider } from './blueprint-provider.js';

/**
 * Re-export `LlmProvider` + `LlmRoute` from `@ggui-ai/protocol` so
 * existing `mcp-server-core` consumers keep working without an
 * import-path change. The single source of truth is the `MODELS`
 * registry in `@ggui-ai/protocol/types/llm-route`.
 */
export type { LlmProvider, LlmRoute };

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
 *
 * Composed as `LlmRoute & {inference params}` — the discriminated-union
 * `LlmRoute` enforces that `model` belongs to `provider`'s namespace
 * (per `MODELS` in `@ggui-ai/protocol/types/llm-route`), structurally
 * preventing the #22/#42 bug class. Inference parameters
 * (`temperature`, `maxTokens`) layer on top.
 */
export type LlmSelection = LlmRoute & {
  temperature?: number;
  maxTokens?: number;
};

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
  /** The agent's render request (prompt, schema, context, adapters). */
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
   * Callers (ggui_render handler, self-hosted integrations) populate
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
   * The app's generation profile — operator-declared free text
   * (`styling`, `density`, `layout`) the generator honours as the app's
   * visual brief. Read from the app's `generation.profile`, bounded at
   * the door by `appGenerationProfileSchema`. Absent and empty are
   * byte-identical to today's prompts.
   */
  profile?: AppGenerationProfile;
  /**
   * Props for the in-loop render check and runtime probe; absent ⇒
   * schema-first synthesis. Never part of the prompt text or the cache
   * identity — the generated code is judged against these, not shaped by
   * them.
   */
  fixtureProps?: JsonObject;
  /**
   * Optional rendering hint — device + shell + viewport. When present,
   * the generator surfaces a "Rendering Context" block in the user
   * prompt so the LLM picks an appropriate sizing strategy (e.g., a
   * `chat` shell sized 300-600px vs a `fullscreen` shell at 100vh).
   *
   * The ONE rendering-context vocabulary — `@ggui-ai/protocol`'s
   * `renderingContextSchema` (ggui#1000), derived here, never re-declared.
   * Optional — callers without a hint produce universal-shell components.
   */
  rendering?: RenderingContext;
  /**
   * Operator-registered gadget catalog (`App.gadgets`)
   * to surface in the code-gen system prompt's `clientCapabilities —
   * registered catalog` table. Threaded by the render handler from the
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
   * ALSO the app this generation is attributed to: a deployment whose
   * generator meters or bills per app reads this field to know which
   * app's usage the call belongs to. Callers that pre-fetch
   * `appGadgets` SHOULD still supply it for that reason — a generator
   * that does neither simply ignores it.
   *
   * Optional.
   */
  appId?: string;
  /**
   * `package → .d.ts content` map for the non-stdlib
   * gadgets this contract uses. The render handler parallel-fetches
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
   * Plain `Record` (not `Map`) so the shape survives a hosted
   * deployment's serialized `UiGenerateInput` boundary. Stdlib
   * (`@ggui-ai/gadgets`) never appears here — the sandbox VFS
   * carries its types directly.
   *
   * Absent / empty → no third-party gadget types to overlay.
   */
  gadgetTypes?: Readonly<Record<string, string>>;
  /**
   * Optional infra-side hint for the resolved generator. Introduced
   * 2026-05-24 so agent callers can override the server's default
   * model per-render — `infra.model` is the only field at v1; future
   * expansion (temperature, max_tokens, etc.) lands here additively.
   *
   * `model` MUST be a provider-prefixed id (`provider/model-name`);
   * the active generator decides routing from the prefix. A bound
   * generator may also accept generator-specific prefixes (e.g. a
   * Bedrock-routing generator may accept `bedrock/...` ids); consult
   * the generator's docs.
   *
   * Self-hosted callers typically read `infra.model` inside their
   * generator implementation to override a workspace default.
   */
  infra?: {
    readonly model?: string;
  };
  /** Abort cancellation — server may cancel on render close or timeout. */
  signal?: AbortSignal;
}

/**
 * The engine's BUILD identity: values that change when the engine's code or
 * templates change and never with the request. Carried on
 * {@link GenerationMetadata.build}; absent when the engine does not report one.
 */
export interface GeneratorBuild {
  /** The engine package's version when readable at runtime; absent, never guessed, when not. */
  readonly version?: string;
  /** Engine-defined label for the configuration the digests were computed under. Opaque to consumers, like `routeKind`. */
  readonly mode?: string;
  /**
   * Content digests (lowercase hex sha256) that identify the build. Keys are
   * the engine's own, scoped by `generator`; consumers compare and group by
   * value, and only a consumer that knows the engine reads a key.
   */
  readonly digests: Readonly<Record<string, string>>;
}

/**
 * Execution status of the generation's runtime-render probe, when the engine
 * ran one after the coding turns: `ran` (its verdict is in), `timed-out`
 * (the check crossed its wall-clock bound — no verdict, never a pass, never
 * a crash), `infra-skipped` (the check could not execute in this
 * environment — no verdict), `not-applicable` (nothing to probe: no
 * compiled code or no contract surface). The engine's own status type
 * (`RuntimeProbeStatus` in `@ggui-ai/ui-gen`) is this union under another
 * name — one declaration, here, because the engine depends on this package
 * and not the reverse.
 */
export type GenerationRuntimeProbeStatus = 'ran' | 'infra-skipped' | 'not-applicable' | 'timed-out';

/**
 * The checks the runtime-render probe runs, by name (ggui#1380). Declared
 * ONCE, here, for the same reason as {@link GenerationRuntimeProbeStatus}:
 * the engine depends on this package and not the reverse, so its own
 * check-kind name (`RenderCheckKind` in `@ggui-ai/ui-gen`) is this union
 * under another name. A `fail` verdict lists which of these failed, so a
 * reader can tell a render crash from a contract-wiring finding without a
 * lossy class that would have to lie about five of the seven.
 */
export type GenerationRuntimeProbeCheck =
  | 'render-no-throw'
  | 'prop-sensitivity'
  | 'action-wiring'
  | 'selection-identity'
  | 'prop-coverage'
  | 'optional-props-omitted'
  | 'stream-rerender';

/**
 * ONE probe's outcome (ggui#1380): what a single run of the runtime-render
 * probe produced. Discriminated so the record can only say what happened:
 *
 *   - `ran` + `verdict: 'pass'` — the probe executed and no check failed;
 *   - `ran` + `verdict: 'fail'` — ANY check failed; `failChecks` is the
 *     distinct kinds that did, never empty, in the order
 *     {@link GenerationRuntimeProbeCheck} declares them;
 *   - `timed-out` / `infra-skipped` / `not-applicable` — no verdict, and the
 *     type carries none: a probe that did not finish is never a pass and
 *     never a crash.
 *
 * Two meanings sit side by side and must not be conflated. The VERDICT is
 * `fail` on any failing check. The REPAIR turn (see
 * {@link GenerationRuntimeProbeRepair}) fires on the `render-no-throw`
 * class only — a card that crashes on first render; every other failing
 * check is recorded here and never repaired. `failChecks` is ordered as
 * {@link GenerationRuntimeProbeCheck} declares its members — the constant's
 * order (so `render-no-throw` leads whenever present), not a severity
 * ranking. The rates a reader derives (crash that happened, crash that was
 * served, repair success) are stated on {@link GenerationRuntimeProbeRepair}.
 *
 * The `?: never` members are what make the refusals hold structurally: a
 * `ran` record without a verdict, a no-verdict status carrying one, and a
 * `pass` carrying `failChecks` are not assignable, not merely undocumented.
 */
export type GenerationRuntimeProbeOutcome =
  | {
      readonly status: 'ran';
      readonly verdict: 'pass';
      readonly failChecks?: never;
      /** Wall-clock of the probe, ms. */
      readonly elapsedMs?: number;
      /** Time the check waited for a probe slot before it started, ms; present only when > 0. */
      readonly queuedMs?: number;
    }
  | {
      readonly status: 'ran';
      readonly verdict: 'fail';
      /** The distinct checks that failed — at least one, in declaration order. */
      readonly failChecks: readonly [GenerationRuntimeProbeCheck, ...GenerationRuntimeProbeCheck[]];
      /** Wall-clock of the probe, ms. */
      readonly elapsedMs?: number;
      /** Time the check waited for a probe slot before it started, ms; present only when > 0. */
      readonly queuedMs?: number;
    }
  | {
      readonly status: 'timed-out' | 'infra-skipped' | 'not-applicable';
      readonly verdict?: never;
      readonly failChecks?: never;
      /** Wall-clock of the probe, ms; absent when nothing ran (`not-applicable`). */
      readonly elapsedMs?: number;
      /** Time the check waited for a probe slot before it started, ms; present only when > 0. */
      readonly queuedMs?: number;
    };

/**
 * What came of the one repair turn a render crash buys (ggui#1380). Present
 * on a {@link GenerationRuntimeProbe} only when a repair turn was bought.
 * The record's top-level outcome is ALWAYS the served card's last probe;
 * this record adds what that alone would lose:
 *
 *   - `compiled: false` — the repair did not pass self-check, so no re-probe
 *     ran and the pre-repair card is served: the top-level outcome IS the
 *     probe that bought the turn, so nothing is repeated here;
 *   - `compiled: true` — the repaired card is served and the top-level
 *     outcome is its re-probe; `trigger` is the probe that BOUGHT the turn
 *     (its verdict is `fail` with `render-no-throw` among its checks, plus
 *     whatever else failed alongside), so a crash that HAPPENED and a crash
 *     that was SERVED are each recorded once, never the same probe twice.
 *
 * The two arms are exclusive by type. On a stream of records:
 *   - crash that happened  = `repair !== undefined ||
 *     (verdict === 'fail' && failChecks.includes('render-no-throw'))`;
 *   - crash that was served = `verdict === 'fail' &&
 *     failChecks.includes('render-no-throw')` (the top level);
 *   - repair success        = `repair?.compiled === true && verdict === 'pass'`.
 */
export type GenerationRuntimeProbeRepair =
  | { readonly attempted: true; readonly compiled: false; readonly trigger?: never }
  | { readonly attempted: true; readonly compiled: true; readonly trigger: GenerationRuntimeProbeOutcome };

/**
 * What the runtime-render probe did on this generation, when the engine ran
 * one (ggui#1380). A serving deployment that wires the probe without an
 * in-loop evaluator runs it once after the coding turns; a render crash the
 * engine recognises buys exactly one repair turn and one re-probe. The
 * outcome fields (`status`, `verdict`, `failChecks`, `elapsedMs`) are the
 * LAST probe's — the re-probe's when the repair compiled, else the
 * pre-repair probe's — and `repair` says whether a repair turn was bought
 * and what came of it.
 */
export type GenerationRuntimeProbe = GenerationRuntimeProbeOutcome & {
  readonly repair?: GenerationRuntimeProbeRepair;
};

/**
 * Metadata emitted alongside every result (success or failure) for telemetry.
 */
export interface GenerationMetadata {
  provider: LlmProvider;
  /**
   * Slug of the {@link UiGenerator} that produced this result (the
   * engine's own identity — `slug` on the implementing generator).
   * Wrapper generators that delegate to an inner engine re-stamp
   * their own registered slug on the way out so the result names the
   * engine the operator dispatched. Required: blueprint provenance
   * (`BlueprintSource`'s `llm` arm) is minted from this field, and an
   * engine-generated result that cannot name its engine is not a real
   * state.
   */
  generator: GeneratorId;
  /** The model the LLM call ran on — `provider/model` of the route (`ModelRef`, ggui#924). */
  model: ModelRef;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** True if served from a blueprint cache hit (Tier 0); no LLM was called. */
  cacheHit: boolean;
  /** Retry / turn count. 0 means single-shot success. */
  attempts?: number;
  /** Prompt-cache tokens read on this generation (provider-specific; absent when unsupported). Observability only. */
  readonly cacheReadTokens?: number;
  /** Prompt-cache tokens written on this generation (provider-specific; absent when unsupported). Observability only. */
  readonly cacheCreationTokens?: number;
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
  /**
   * The engine's BUILD identity: values that change when the engine's code
   * or templates change and never with the request. Absent when the engine
   * does not report one.
   */
  readonly build?: GeneratorBuild;
  /**
   * The runtime-render probe's record for this generation — see
   * {@link GenerationRuntimeProbe}. Absent when no probe ran after the
   * coding turns (the engine reports nothing; never a default status).
   */
  readonly runtimeProbe?: GenerationRuntimeProbe;
  /**
   * Wall-clock the engine spent in its post-coding evaluation rounds (the
   * probe round included), ms. Absent when no round ran — never a default 0.
   */
  readonly evalMs?: number;
}

/**
 * Result of a non-streaming generation. Discriminated on `ok`.
 */
export type UiGenerateResult =
  | { ok: true; response: UIGenerationResponse; metadata: GenerationMetadata }
  | { ok: false; error: GenerationError; metadata?: GenerationMetadata };

/**
 * The contract. Implementations:
 *   - `@ggui-ai/ui-gen`       open-source package; real LLM harness
 *   - test doubles / mocks    for unit testing the server
 *   - custom self-hosted fork anyone replacing our harness
 *
 * Identity fields — required:
 *
 *   - `slug` is the registry key and the stable handle stored on each
 *     {@link Blueprint} row. Pattern `ui-gen-<tier>`.
 *   - `tier` is the slug's parsed component, surfaced directly so
 *     callers don't re-parse on every access.
 *   - `model` is the generator's own declared field — it is NOT part of
 *     the slug (ggui#923), so a tier can move to a newer model without
 *     changing the identity stored on any row.
 *
 * The slug, tier, and model an implementation declares describe its
 * declared identity (which model the operator stood it up for). The
 * actual model used per request still comes from
 * `UiGenerateInput.llm.model` — operators may override via BYOK. The
 * identity is the registry-level handle, not a runtime constraint.
 */
export interface UiGenerator {
  /** Stable registry key, e.g. `ui-gen-default` — the protocol's {@link GeneratorId}. */
  readonly slug: GeneratorId;
  /** Quality / cost tier — `'default'` or `'advanced'` at v1. */
  readonly tier: GeneratorTier;
  /** The model this generator was registered for — a registry key (`anthropic/…`), never part of the slug. */
  readonly model: ModelRef;
  generate(input: UiGenerateInput): Promise<UiGenerateResult>;
}
