/**
 * `createUiGenerator` — full-harness UI generation factory.
 *
 * Returns a {@link UiGenerator} backed by `dispatchGeneration` — the
 * same multi-turn coding-agent path the benchmark validates. OSS
 * production (`ggui serve`, hosted `ggui_push`) all route through this
 * seam, so bench == prod by construction.
 *
 * Pipeline:
 *
 *   1. `resolveRoute` + `applyRouteToEnv` — install BYOK key into
 *      the process env so dispatch's adapters can read it.
 *   2. `createGeneratorTools` — assemble the coding-agent tool surface
 *      (compile_component, validate_component, self_check,
 *      get_primitives, get_design_system).
 *   3. `injectRenderingContext` + `injectContracts` — enrich the user
 *      prompt with rendering hints + contract docs.
 *   4. `dispatchGeneration` — multi-turn loop with apply_changes,
 *      self-check, evaluate, regenerate. The harness builds its own
 *      rich system prompt with primitives doc + design-system docs +
 *      pitfalls.
 *
 * This factory deliberately keeps a minimal surface — provider
 * routing, compilation, and the system prompt are all internal:
 *
 *   - `adapter` option — provider routing is internal to dispatch
 *   - `compileFn` option — `compile_component` tool runs inline
 *   - `systemPromptBuilder` option — harness builds its own
 *   - `withBrowserCompile` wrapper — dispatch returns compiled JS
 *
 * Callers who want a lightweight single-shot path can build it
 * themselves.
 */
import type {
  GadgetDescriptor,
  GenerationError,
  JsonObject,
} from '@ggui-ai/protocol';
import type { GadgetCatalogAdapter } from '@ggui-ai/gadgets';
import type {
  GenerationMetadata,
  GeneratorTier,
  LlmProvider,
  UiGenerateInput,
  UiGenerateResult,
  UiGenerator,
} from '@ggui-ai/mcp-server-core';
import {
  formatGeneratorSlug,
  isValidGeneratorSlug,
  parseGeneratorSlug,
} from '@ggui-ai/mcp-server-core';
import { createGeneratorTools } from './adapters/index.js';
import { dispatchGeneration } from './adapters/generation-dispatch.js';
import type { ProviderName } from './adapters/types.js';
import {
  injectContracts,
  injectRenderingContext,
  injectVariance,
} from './contract-context.js';
import type { RenderingContext } from './contract-context.js';
import { resolveRoute, applyRouteToEnv } from './adapters/provider-router.js';
import type { QualityConfig } from './evaluation/types-public.js';

const DEFAULT_MAX_TURNS = 10;

/** The slug for the OSS default seed generator. */
const DEFAULT_TIER: GeneratorTier = 'default';
const DEFAULT_MODEL = 'haiku-4-5';

export interface CreateUiGeneratorOptions {
  /**
   * Wire `DEFAULT_RUNTIME_RENDER_CHECK` into the harness's check leg.
   * When `true`, every coding turn ends with a happy-dom runtime-render
   * probe that catches contract-wiring bugs (missing `useAction()`,
   * wrong stream channel name, etc.).
   *
   * Default: `false` for OSS — keeps cold-start light. The probe pulls
   * happy-dom + @testing-library on first use (~700-1500ms cold). Bench
   * enables it via dispatch's own default for stricter quality gating.
   */
  readonly enableRuntimeRender?: boolean;
  /** Maximum coding turns. Default: 10. */
  readonly maxTurns?: number;
  /** Maximum coding attempts per generation pass. */
  readonly maxAttempts?: number;
  /** Maximum evaluation rounds. */
  readonly maxEvalRounds?: number;
  /** Quality config controlling eval tiers + improvement behavior. */
  readonly qualityConfig?: QualityConfig;
  /**
   * Generator identity — registry key + parsed components.
   *
   * The tier + model determine the {@link UiGenerator.slug} the
   * factory bakes onto the returned generator. Defaults to
   * `{tier: 'default', model: 'haiku-4-5'}` → slug
   * `ui-gen-default-haiku-4-5`, the OSS seed.
   *
   * The actual model used per request still comes from
   * `UiGenerateInput.llm.model` (operators may override via BYOK).
   * The identity here is the registry-level handle, not a runtime
   * model constraint.
   *
   * Mutually-exclusive shortcut: pass `slug` instead and the factory
   * parses it for you. The slug + tier/model overloads conflict; the
   * factory throws if both are supplied.
   */
  readonly tier?: GeneratorTier;
  readonly model?: string;
  readonly slug?: string;
  /**
   * Per-deployment gadget descriptor source. Wired once at factory
   * time; the generator resolves descriptors per-call via
   * `gadgetCatalog.list(input.appId)` when `input.appGadgets` is
   * absent. See {@link GadgetCatalogAdapter} (`@ggui-ai/gadgets`) for
   * the port + the two batteries-included implementations.
   *
   * Wiring patterns:
   *
   *   ```ts
   *   // OSS: stdlib seed, no app-specific catalogs.
   *   createUiGenerator({
   *     gadgetCatalog: InMemoryGadgetCatalog.withDefault(STDLIB_GADGETS),
   *   });
   *
   *   // Cloud / prod: TTL cache over a registry-backed adapter.
   *   createUiGenerator({
   *     gadgetCatalog: new CachingGadgetCatalog(
   *       new DynamoGadgetCatalog(appMetadataStore),
   *       { ttlMs: 30_000 },
   *     ),
   *   });
   *   ```
   *
   * Per-call resolution precedence (in {@link UiGenerator.generate}):
   *
   *   1. `input.appGadgets` (pre-fetched by caller — handler-side path)
   *   2. `gadgetCatalog.list(input.appId)` (factory path, this option)
   *   3. empty list (legacy callers — no gadgets resolved)
   *
   * Optional. When omitted, callers MUST pre-fetch and pass
   * `appGadgets` themselves; the legacy handler path stays unchanged.
   */
  readonly gadgetCatalog?: GadgetCatalogAdapter;
}

export function createUiGenerator(
  options: CreateUiGeneratorOptions = {},
): UiGenerator {
  const {
    enableRuntimeRender = false,
    maxTurns = DEFAULT_MAX_TURNS,
    maxAttempts,
    maxEvalRounds,
    qualityConfig,
    gadgetCatalog,
  } = options;

  const identity = resolveIdentity(options);

  return {
    slug: identity.slug,
    tier: identity.tier,
    model: identity.model,
    async generate(input: UiGenerateInput): Promise<UiGenerateResult> {
      const startedAt = Date.now();

      // Map LlmProvider → ProviderName. dispatch uses 'claude' where
      // mcp-server-core uses 'anthropic'; 'bedrock' also routes through
      // the claude adapter (route resolves the model to a bedrock
      // inference profile when needed).
      const provider = mapLlmProviderToDispatchProvider(input.llm.provider);

      // BYOK key injection. resolveRoute reads the typed route +
      // apiKey and returns env mutations (ANTHROPIC_API_KEY=<byok>).
      // dispatch's adapters read keys from process.env, so we
      // install the routed env for the duration of this call and
      // restore on exit. `input.llm` IS structurally an `LlmRoute`
      // (the typed `LlmSelection`), so we pass it as the route input
      // directly — no string threading.
      let route: ReturnType<typeof resolveRoute>;
      try {
        const baseEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined) baseEnv[k] = v;
        }
        route = resolveRoute({
          route: input.llm,
          apiKey: input.providerKey.key,
          env: baseEnv,
        });
      } catch (err) {
        return failWithoutMetadata(input, startedAt, {
          code: 'PRODUCTION_FAILED',
          message: err instanceof Error ? err.message : String(err),
          details: { kind: 'route-resolution-failed' },
        });
      }

      const envBackup: Record<string, string | undefined> = {};
      for (const k of Object.keys(route.env)) envBackup[k] = process.env[k];
      const baseEnvForApply: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) baseEnvForApply[k] = v;
      }
      const routedEnv = applyRouteToEnv(baseEnvForApply, route);
      for (const [k, v] of Object.entries(routedEnv)) process.env[k] = v;
      // Also delete any keys the route asked to clear (route.env values
      // marked undefined).
      for (const [k, v] of Object.entries(route.env)) {
        if (v === undefined) delete process.env[k];
      }

      try {
        const tools = createGeneratorTools({
          ...(input.contract ? { contract: input.contract } : {}),
        });

        // Build the user prompt: prompt → rendering context → variance
        // → contract block. Variance lands BEFORE the contract block so
        // the styling directive frames the structural spec that follows
        // (the LLM treats the last block read as most-authoritative for
        // shape, so contract goes last; variance frames "how" while
        // contract pins "what"). Mirrors what cloud's `generateWithSDK`
        // and the bench runner both produce, so the LLM sees identical
        // input across all three call sites.
        const rendering = mapRendering(input.rendering);
        const promptWithRendering = rendering
          ? injectRenderingContext(input.request.prompt, rendering)
          : input.request.prompt;
        const promptWithVariance = injectVariance(
          promptWithRendering,
          input.variance,
        );

        // Resolve appGadgets by precedence:
        //   1. input.appGadgets (caller pre-fetched, handler path)
        //   2. gadgetCatalog.list(input.appId) (factory wiring)
        //   3. undefined (no catalog)
        // Catalog errors propagate — a silent empty result would mask
        // broken catalogs as "no gadgets registered" and let pushes
        // through with unresolved refs.
        const resolvedAppGadgets: readonly GadgetDescriptor[] | undefined =
          input.appGadgets !== undefined
            ? input.appGadgets
            : gadgetCatalog !== undefined && input.appId !== undefined
            ? await gadgetCatalog.list(input.appId)
            : undefined;

        const userPrompt = injectContracts(
          promptWithVariance,
          input.contract,
          resolvedAppGadgets,
        );

        const result = await dispatchGeneration({
          provider,
          userPrompt,
          model: route.model,
          tools,
          maxTurns,
          ...(input.contract ? { contract: input.contract } : {}),
          originalPrompt: input.request.prompt,
          ...(maxAttempts !== undefined ? { maxAttempts } : {}),
          ...(maxEvalRounds !== undefined ? { maxEvalRounds } : {}),
          ...(qualityConfig !== undefined ? { qualityConfig } : {}),
          ...(resolvedAppGadgets !== undefined
            ? { appGadgets: resolvedAppGadgets }
            : {}),
          // Forward the third-party wrapper `.d.ts` map the push
          // handler pre-fetched. Reaches both the code-gen prompt's
          // `Type:` lines and the coding-agent typecheck overlay via
          // `dispatchGeneration`.
          ...(input.gadgetTypes !== undefined
            ? { gadgetTypes: input.gadgetTypes }
            : {}),
          enableRuntimeRender,
        });

        const metadata: GenerationMetadata = {
          provider: input.llm.provider,
          model: input.llm.model,
          inputTokens: result.tokens.input,
          outputTokens: result.tokens.output,
          latencyMs: Date.now() - startedAt,
          cacheHit: false,
          attempts: result.turnsUsed,
        };

        return {
          ok: true,
          response: {
            stackItemId: `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            componentCode: result.compiledCode,
            ...(result.sourceCode ? { sourceCode: result.sourceCode } : {}),
            ...(input.contract ? { contract: input.contract } : {}),
          },
          metadata,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const details: JsonObject = { kind: 'harness-failed' };
        if (err instanceof Error && err.stack) details['stack'] = err.stack;
        return {
          ok: false,
          error: {
            code: 'PRODUCTION_FAILED',
            message,
            details,
          },
          metadata: {
            provider: input.llm.provider,
            model: input.llm.model,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - startedAt,
            cacheHit: false,
          },
        };
      } finally {
        // Restore env to its pre-call state.
        for (const [k, v] of Object.entries(envBackup)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    },
  };
}

function resolveIdentity(opts: CreateUiGeneratorOptions): {
  slug: string;
  tier: GeneratorTier;
  model: string;
} {
  const hasSlug = typeof opts.slug === 'string' && opts.slug.length > 0;
  const hasTierOrModel = opts.tier !== undefined || opts.model !== undefined;
  if (hasSlug && hasTierOrModel) {
    throw new Error(
      'createUiGenerator: pass either { slug } or { tier, model } — not both.',
    );
  }
  if (hasSlug) {
    const parsed = parseGeneratorSlug(opts.slug!);
    if (!parsed) {
      throw new Error(
        `createUiGenerator: slug ${JSON.stringify(opts.slug)} is not a valid ui-gen-<tier>-<model> identifier.`,
      );
    }
    return { slug: opts.slug!, tier: parsed.tier, model: parsed.model };
  }
  const tier = opts.tier ?? DEFAULT_TIER;
  const model = opts.model ?? DEFAULT_MODEL;
  const slug = formatGeneratorSlug({ tier, model });
  if (!isValidGeneratorSlug(slug)) {
    // Unreachable: formatGeneratorSlug throws on malformed components,
    // so a slug it returns must parse. Defensive check kept to surface
    // any future drift between the two helpers.
    throw new Error(
      `createUiGenerator: formatted slug ${JSON.stringify(slug)} round-trips as invalid — formatGeneratorSlug/isValidGeneratorSlug drift.`,
    );
  }
  return { slug, tier, model };
}

function mapLlmProviderToDispatchProvider(provider: LlmProvider): ProviderName {
  switch (provider) {
    case 'anthropic':
    case 'bedrock':
      return 'claude';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    case 'openrouter':
      return 'openrouter';
  }
}

function mapRendering(
  rendering: UiGenerateInput['rendering'],
): RenderingContext | undefined {
  if (!rendering) return undefined;
  return {
    device: rendering.device,
    shell: rendering.shell,
    ...(rendering.viewport ? { viewport: rendering.viewport } : {}),
  };
}

function failWithoutMetadata(
  input: UiGenerateInput,
  startedAt: number,
  error: GenerationError,
): UiGenerateResult {
  return {
    ok: false,
    error,
    metadata: {
      provider: input.llm.provider,
      model: input.llm.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      cacheHit: false,
    },
  };
}

// ── Utility re-export ────────────────────────────────────────
//
// Callers (console, ad-hoc scripts, third-party integrations) sometimes
// have a raw LLM response that includes ```tsx fences and want to
// extract the code body. The new harness path doesn't use this — it
// gets clean compiled JS back from `compile_component` — but the
// utility is small and useful, so we keep it exported.

const CODE_START_PATTERN = /^(import\s|export\s|const\s|function\s|class\s|\/\*|\/\/)/;

export function extractComponentCode(raw: string): string {
  const fencePattern = /```([a-zA-Z0-9+\-_]*)\s*\n([\s\S]*?)```/g;
  const fences: Array<{ lang: string; body: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(raw)) !== null) {
    const lang = (match[1] ?? '').toLowerCase();
    const body = match[2] ?? '';
    fences.push({ lang, body });
  }

  if (fences.length > 0) {
    const priority = ['tsx', 'jsx', 'typescript', 'ts', 'javascript', 'js', ''];
    for (const preferred of priority) {
      const hit = fences.find((f) => f.lang === preferred);
      if (hit) return hit.body.trim();
    }
    const firstBody = fences[0]?.body ?? '';
    return firstBody.trim();
  }

  const trimmed = raw.trim();
  if (CODE_START_PATTERN.test(trimmed)) return trimmed;
  const codeMarkerIndex = findCodeStart(raw);
  if (codeMarkerIndex > 0) return raw.slice(codeMarkerIndex).trim();
  return trimmed;
}

function findCodeStart(text: string): number {
  const markers = [
    /\n\s*import\s/,
    /\n\s*export\s/,
    /\n\s*\/\*\s/,
    /\n\s*const\s/,
    /\n\s*function\s/,
  ];
  let earliest = -1;
  for (const m of markers) {
    const candidate = m.exec(text);
    if (candidate && (earliest === -1 || candidate.index < earliest)) {
      earliest = candidate.index;
    }
  }
  return earliest;
}
