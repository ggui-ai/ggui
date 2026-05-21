/**
 * BYOK probe helper — boot-time scan + per-request resolver for
 * `ggui serve`.
 *
 * Two layers, both expressed through a single
 * {@link GenerationBinding}:
 *
 *   1. **Boot scan** — walk providers in a fixed priority
 *      (`anthropic` → `openai` → `google` → `openrouter`). First
 *      hit at the operator's `'global'` scope (env or
 *      `~/.ggui/credentials.json`) names the "default provider"
 *      surfaced on the banner. Misses are fine — see (3).
 *   2. **Per-request resolver** — the returned `resolveLlm(ctx)`
 *      re-runs the resolver for the chosen provider with
 *      `userScope: ctx.appId`, so per-end-user keys stored at the
 *      caller's identity scope flip in at request time without a
 *      server restart. Multi-tenant `ggui serve` lives off this
 *      seam: each authenticated user manages their OWN provider
 *      key via `/settings`, the resolver picks it up on the next
 *      `ggui_push`.
 *   3. **No-key default** — when the boot scan finds nothing, we
 *      STILL return a binding (provider=`anthropic`, model=
 *      `claude-haiku-4-5`). Generation stays wired; the
 *      no-credentials path now produces a Connect-Claude card
 *      stack item via {@link GenerationDeps.onNoCredentials}
 *      instead of the broken `codeReady:false` placeholder.
 *      Caller-supplied `onNoCredentials` is threaded through
 *      verbatim.
 *
 * **Overrides:** `probeGenerationBinding({ resolver, blueprints,
 * onNoCredentials? })` takes the resolver + blueprint provider as
 * inputs so tests can supply fakes without mutating `process.env` /
 * touching the home directory.
 *
 * **Explicit non-scope:** provider override via env / config /
 * flag. The fixed priority is fine for current usage; a follow-up
 * can add `GGUI_GENERATION_PROVIDER` / `ggui.json#generation.model`
 * without re-shaping this seam.
 */
import type {
  BlueprintProvider,
  GenerationDeps,
  HandlerContext,
  LlmProvider,
  LlmSelection,
  ProviderKeyRef,
  SessionStackEntry,
} from '@ggui-ai/mcp-server';
import { createUiGenerator } from '@ggui-ai/ui-gen';
import type {
  ByokKeyResolution,
  ByokResolver,
} from './byok-resolver.js';

/**
 * Locked default model per provider for the OSS first-run path.
 *
 * These are the "sensible default for an operator who exported
 * `ANTHROPIC_API_KEY` without thinking about which model" — NOT
 * benchmark-tuned recommendations. A later slice wires
 * `ggui.json#generation.model` so operators can pick explicitly;
 * until then these keep the zero-config path honest.
 *
 * Notably absent: `bedrock`. AWS credentials flow through the SDK
 * chain, which the OSS BYOK resolver doesn't cover — the hosted runtime
 * binds Bedrock through its own `GenerationDeps` at the hosted
 * surface.
 */
export const DEFAULT_MODEL_BY_PROVIDER: Readonly<
  Record<Exclude<LlmProvider, 'bedrock'>, string>
> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o',
  google: 'gemini-2.0-flash',
  openrouter: 'anthropic/claude-haiku-4.5',
};

/**
 * Priority order for BYOK provider probing. The first provider
 * whose credentials resolve wins. Anthropic first is deliberate —
 * the OSS ecosystem defaults to Claude, and most operators export
 * `ANTHROPIC_API_KEY` by default.
 */
export const PROVIDER_PROBE_ORDER: readonly Exclude<LlmProvider, 'bedrock'>[] =
  ['anthropic', 'openai', 'google', 'openrouter'];

export interface ProbeGenerationBindingOptions {
  readonly resolver: ByokResolver;
  readonly blueprints: BlueprintProvider;
  /** Override the probe order. Tests use this to pin the winner. */
  readonly providerOrder?: readonly Exclude<LlmProvider, 'bedrock'>[];
  /**
   * Optional no-credentials fallback hook threaded straight onto
   * {@link GenerationDeps.onNoCredentials}. The CLI builds this
   * from the operator's resolved settings URL so the
   * Connect-Claude card points at THIS server's `/settings`.
   * Tests + programmatic embedders that want the legacy error
   * envelope leave it absent.
   */
  readonly onNoCredentials?: (
    ctx: HandlerContext,
    story: {
      readonly intent: string;
      readonly stackItemId: string;
      readonly nowIso: string;
    },
  ) => SessionStackEntry | null | Promise<SessionStackEntry | null>;
}

/**
 * Outcome of the boot probe. Always returned (no `null` shape) —
 * the per-request `resolveLlm` walks the provider order with
 * `userScope: ctx.appId` so end-user keys can flip in even when
 * the operator's boot scan came up empty.
 *
 * `bootResolved: false` is the operator-facing "no platform key"
 * signal: banner copy + the no-credentials fallback path are
 * conditioned on it.
 */
export interface GenerationBinding {
  readonly generation: GenerationDeps;
  readonly provider: LlmProvider;
  readonly model: string;
  /**
   * `true` when the boot scan resolved a key at the operator's
   * `'global'` scope (env or credentials-file). `false` means
   * generation will fall back to either the per-end-user key
   * (multi-tenant) or the {@link GenerationDeps.onNoCredentials}
   * card on first call.
   */
  readonly bootResolved: boolean;
  /** Boot-scan key source — only meaningful when `bootResolved`. */
  readonly keySource?: ByokKeyResolution['source'];
  /** Env-var name that produced the boot-scan hit, when applicable. */
  readonly keyEnvName?: string;
}

/**
 * Build a `GenerationBinding` whose `resolveLlm` does live BYOK
 * lookup at request time (env + global → user-scope), threading
 * `ctx.appId` into the resolver as `userScope`.
 *
 * Always returns a binding — even when no provider resolved at
 * boot. The caller supplies `onNoCredentials` to render a
 * Connect-Claude card on misses; absent that hook, misses surface
 * the legacy "no-credentials" error envelope.
 */
export async function probeGenerationBinding(
  opts: ProbeGenerationBindingOptions,
): Promise<GenerationBinding> {
  const order = opts.providerOrder ?? PROVIDER_PROBE_ORDER;

  // Boot scan — surfaces the banner-line provider/source. If
  // multiple providers have boot-time keys, the first in priority
  // order wins (matches pre-H2 behavior).
  let bootHit:
    | (ByokKeyResolution & { provider: Exclude<LlmProvider, 'bedrock'> })
    | null = null;
  for (const provider of order) {
    const resolution = await opts.resolver.resolve(provider);
    if (resolution) {
      bootHit = { ...resolution, provider };
      break;
    }
  }

  // Default provider locks to anthropic on boot-miss — matches the
  // OSS "Claude first" posture. The Connect-Claude card flow steers
  // misses toward an Anthropic key (env/file/OAuth); nothing in the
  // contract prevents users from pasting an OpenAI/Google key
  // instead, but the boot-time provider for THIS server stays
  // anthropic until the operator restarts with a different boot
  // hit.
  const defaultProvider: Exclude<LlmProvider, 'bedrock'> =
    bootHit?.provider ?? 'anthropic';
  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[defaultProvider];

  // Full-harness wire-up: `createUiGenerator` runs the same
  // multi-turn coding agent + self-check loop the bench validates;
  // `dispatchGeneration` returns compiled JS on `componentCode`.
  const uiGenerator = createUiGenerator();

  const resolveLlm = async (
    ctx: HandlerContext,
  ): Promise<{ selection: LlmSelection; providerKey: ProviderKeyRef } | null> => {
    // Per-call BYOK with `userScope: ctx.appId` — env + global
    // (operator) checked first, then the caller's identity scope
    // (end-user). Multi-tenant + Anthropic-OAuth flows store
    // user-supplied bundles under `userId` here.
    const resolution = await opts.resolver.resolve(defaultProvider, {
      userScope: ctx.appId,
    });
    if (!resolution) return null;
    return {
      selection: { provider: defaultProvider, model: defaultModel },
      providerKey: { provider: defaultProvider, key: resolution.key },
    };
  };

  const generation: GenerationDeps = {
    uiGenerator,
    resolveLlm,
    blueprints: opts.blueprints,
    ...(opts.onNoCredentials ? { onNoCredentials: opts.onNoCredentials } : {}),
  };
  const result: GenerationBinding = bootHit
    ? {
        generation,
        provider: defaultProvider,
        model: defaultModel,
        bootResolved: true,
        keySource: bootHit.source,
        ...(bootHit.envName !== undefined
          ? { keyEnvName: bootHit.envName }
          : {}),
      }
    : {
        generation,
        provider: defaultProvider,
        model: defaultModel,
        bootResolved: false,
      };
  return result;
}

/**
 * Render a single operator-facing banner line describing the
 * generation binding. Always returns a string — when boot didn't
 * resolve a key, the line still names the default provider/model
 * the per-request resolver will try first, so the operator
 * understands which provider's key the user-facing
 * `/settings` page is steering toward.
 *
 * Format:
 *   `generation: anthropic / claude-haiku-4-5 (env: ANTHROPIC_API_KEY)`
 *   `generation: openai / gpt-4o (credentials-file)`
 *   `generation: anthropic / claude-haiku-4-5 (no boot key — per-user fallback)`
 */
export function describeGenerationBinding(
  binding: GenerationBinding,
): string {
  if (!binding.bootResolved) {
    return `generation: ${binding.provider} / ${binding.model} (no boot key — per-user fallback)`;
  }
  const src =
    binding.keySource === 'env'
      ? binding.keyEnvName
        ? `env: ${binding.keyEnvName}`
        : 'env'
      : 'credentials-file';
  return `generation: ${binding.provider} / ${binding.model} (${src})`;
}
