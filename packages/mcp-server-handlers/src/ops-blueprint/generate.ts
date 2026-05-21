/**
 * `ggui_ops_generate_blueprint` — operator-class blueprint authorship.
 *
 * Operator UX entry point. Dispatches through the bound
 * {@link GeneratorRegistry} to mint a blueprint variant with
 * operator-authored variance tags + optional default-pin.
 *
 * ## Behavior
 *
 *   1. Resolve generator slug via `registry.get(slug)` or
 *      `registry.defaultGenerator()`. Throw
 *      {@link GeneratorNotFoundError} on unknown slug.
 *   2. Normalize `persona` (`.toLowerCase().trim()`) and emit a
 *      `near-duplicate-persona` telemetry event when Levenshtein
 *      distance < 2 of an existing persona in the same `appId`.
 *      The new persona is still persisted — the warning is an
 *      early-detection signal, not a gate.
 *   3. Compute `contractHash` via the canonical RFC 8785 (JCS)
 *      helper `blueprintKey(contract)`.
 *   4. Resolve LLM credentials via `deps.resolveLlm(ctx)`. Throw
 *      {@link MissingCredentialsError} when `null`.
 *   5. Dispatch through `generator.generate({...})`.
 *   6. On `result.ok === true`, persist via `BlueprintStore.put({...})`
 *      with `createdBy: 'operator'`. Store the code body via the
 *      adapter's `putCode(codeHash, body)` (in-memory) or the
 *      cloud S3 putObject (handled inside the cloud adapter's
 *      `put`).
 *   7. When `setAsOperatorDefault === true`, call
 *      `BlueprintStore.setOperatorDefault(blueprintId)` to clear any
 *      prior default in the same `(appId, contractHash)` group.
 *
 * ## Audience
 *
 * `['ops']` — registered on `/ops`. NOT visible to agents on `/mcp`.
 * Every handler carries an `audience` tag that decides which route it
 * surfaces on; this is operator UX, not runtime authoring.
 *
 * ## What this handler does NOT do
 *
 *   - Drive a session. No `sessionId`, no `stackItemId`, no commit
 *     into a session stack. Pure registry mutation.
 *   - Pick a generator dynamically. Operator chooses; the LLM-driven
 *     selector layers above the registry, not below.
 *   - Validate the contract beyond Zod parsing. Schema-compat and
 *     hygiene linting run elsewhere; the operator path trusts the
 *     contract the operator paste-tested into the console.
 */

import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  opsGenerateBlueprintInputSchema,
  type Blueprint,
  type GadgetDescriptor,
  type DataContract,
  type OpsGenerateBlueprintInput,
  type OpsGenerateBlueprintOutput,
} from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import type {
  AppMetadataStore,
  BlueprintStore,
  GeneratorRegistry,
  TelemetrySink,
  UiGenerator,
  UiGenerateInput,
  BlueprintProvider,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import {
  GeneratorNotFoundError,
  GenerationFailedError,
  MissingCredentialsError,
} from './errors.js';
import {
  findNearDuplicatePersona,
  normalizePersona,
} from './persona-normalization.js';
import {
  registerBlueprint,
  type BlueprintRegistryDeps,
  type GenerationCredentials,
} from '../session-mutations/index.js';
import { assertGadgetsRegistered } from '../session-mutations/assert-gadgets.js';
import { assertContractNoRetiredFields } from '../session-mutations/assert-contract-no-retired-fields.js';

const opsInputSchema = opsGenerateBlueprintInputSchema.shape;
const opsOutputSchema = z
  .object({
    blueprintId: z.string().min(1),
    codeHash: z.string().optional(),
    validatorScore: z.number().min(0).max(1).optional(),
    generator: z.string().min(1),
  })
  .shape;

/**
 * In-memory `putCode` hook for blueprint stores that hold code bodies
 * inline (OSS `InMemoryBlueprintStore`). Cloud adapters skip this —
 * their `BlueprintStore.put` writes to S3 directly and the handler
 * doesn't need a parallel hook. The hook stays optional so cloud
 * wiring can omit it entirely.
 */
export interface PutCodeHook {
  (codeHash: string, body: string): void | Promise<void>;
}

/**
 * Deps for `ggui_ops_generate_blueprint`.
 */
export interface GguiOpsGenerateBlueprintDeps {
  /**
   * Generator registry — the dispatch table the handler reads to
   * resolve the operator's slug into a concrete `UiGenerator`. The
   * same registry the push path consults.
   */
  readonly registry: GeneratorRegistry;
  /**
   * Multi-variant blueprint persistence seam. The handler writes the
   * authored row through `put()` and optionally `setOperatorDefault()`.
   */
  readonly blueprintStore: BlueprintStore;
  /**
   * Per-app blueprint enumerator — used for the persona near-dup
   * check. Reads every blueprint under `ctx.appId` to gather the
   * existing persona tag set. Optional — when omitted, the
   * near-dup check is skipped (cloud adapters that bind their own
   * AppListableBlueprintStore via the search seam supply this
   * explicitly).
   */
  readonly listAllForApp?: (appId: string) => Promise<readonly Blueprint[]>;
  /**
   * Per-app metadata resolver — when bound, the handler runs
   * `assertGadgetsRegistered` against the supplied contract
   * before dispatching the LLM. Unregistered `(package, export name)`
   * refs fail fast with a precise reject: `GadgetNotRegisteredError` /
   * `GadgetPackageMismatchError`. Deployments that do not bind an
   * `appMetadataStore` skip the check.
   */
  readonly appMetadataStore?: AppMetadataStore;
  /**
   * Per-call credential lookup — typically the same `resolveLlm`
   * that the push handler reads. Returns `null` when no key is
   * available; the handler maps that to
   * {@link MissingCredentialsError}.
   */
  readonly resolveLlm: (
    ctx: HandlerContext,
  ) =>
    | Promise<GenerationCredentials | null>
    | GenerationCredentials
    | null;
  /**
   * Blueprint catalog handed to the generator. Same instance the
   * push handler threads into `GenerationDeps.blueprints`; surfaced
   * here so generate paths get the same blueprint context.
   */
  readonly blueprints: BlueprintProvider;
  /**
   * Optional code-body hook for in-memory stores. When the bound
   * store is `InMemoryBlueprintStore`, the handler calls this with
   * `(codeHash, body)` immediately after `BlueprintStore.put` so the
   * code is reachable via `getCode(codeHash)`. Cloud adapters that
   * persist code inside `put` itself omit this dep.
   */
  readonly putCode?: PutCodeHook;
  /**
   * Optional cache-registry deps for dual-write mirroring. When
   * bound, the handler ALSO calls `registerBlueprint` against the
   * vectorStore-backed cache registry — the SAME registry the push
   * handler reads from via `matchBlueprint` (push.ts:1544) and the
   * handshake negotiator's exact-key fast path
   * (llm-backed-negotiator.ts §matchBlueprint fast path).
   *
   * Without this dep, ops-authored blueprints sit only in the MVB
   * `BlueprintStore` and are invisible to the cache-hit path —
   * agents handshaking with the same contract get `origin: 'agent'`
   * + a fresh cold-gen instead of `origin: 'cache'`. Operator-
   * authored blueprints SHOULD be reachable from the agent flow;
   * mirror them on registration.
   *
   * Optional so deployments without RAG infrastructure (no
   * embedding + vectorStore) keep the single-store posture. Failure
   * during the mirror write is logged + swallowed — the primary
   * BlueprintStore.put already succeeded, so the operator UX call
   * shouldn't fail on a cache-write hiccup.
   */
  readonly cacheRegistry?: BlueprintRegistryDeps;
  /**
   * Optional telemetry sink — receives `near-duplicate-persona`
   * warnings + `blueprint.generated` / `blueprint.generate_failed`
   * events. Lossy by design; the handler never awaits.
   */
  readonly telemetry?: TelemetrySink;
  /**
   * Optional clock injection — defaults to `() => new Date().toISOString()`.
   * Tests override to produce deterministic `createdAt` stamps.
   */
  readonly now?: () => string;
  /**
   * Optional id minter — defaults to `() => 'bp_' + randomUUID()`.
   * Tests override to produce stable blueprint ids.
   */
  readonly mintBlueprintId?: () => string;
}

/**
 * Read the optional `validatorScore` carried on
 * {@link GenerationMetadata} by the advanced generator, which does
 * not yet have an explicit field on the canonical interface. Until
 * that lands the score arrives as a structural pass-through on
 * `metadata` — the read is type-guarded here so the cast is
 * confined to one place and the call sites stay clean.
 */
function readValidatorScore(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const candidate = (metadata as { validatorScore?: unknown })
    .validatorScore;
  if (typeof candidate !== 'number') return undefined;
  if (!Number.isFinite(candidate)) return undefined;
  if (candidate < 0 || candidate > 1) return undefined;
  return candidate;
}

/**
 * Resolve which generator to dispatch. Throws {@link GeneratorNotFoundError}
 * with a clear "did you mean…" payload when the slug is unknown.
 */
function resolveGenerator(
  registry: GeneratorRegistry,
  slug: string | undefined,
): UiGenerator {
  if (slug === undefined) return registry.defaultGenerator();
  const found = registry.get(slug);
  if (found === null) {
    throw new GeneratorNotFoundError(
      slug,
      registry.list().map((g) => g.slug),
    );
  }
  return found;
}

export function createGguiOpsGenerateBlueprintHandler(
  deps: GguiOpsGenerateBlueprintDeps,
): SharedHandler<
  typeof opsInputSchema,
  typeof opsOutputSchema,
  OpsGenerateBlueprintOutput
> {
  const now = deps.now ?? (() => new Date().toISOString());
  const mintBlueprintId =
    deps.mintBlueprintId ?? (() => `bp_${randomUUID()}`);

  return {
    name: 'ggui_ops_generate_blueprint',
    title: 'Generate blueprint',
    audience: ['ops'],
    description:
      "Author a new blueprint variant for the caller's app. Dispatches through the registry's selected generator (defaults to `registry.defaultGenerator()` when the slug is omitted) and persists the resulting code body + metadata against a fresh `blueprintId`. Optionally pins the new blueprint as the operator default for its `(appId, contractHash)` group. Persona tags are normalized (lowercase + trim); near-duplicates surface a warning via telemetry. Returns the new id + content-hash + validator score + resolved generator slug — code body lives in the bound store, fetched via push's fast-path on cache hit.",
    inputSchema: opsInputSchema,
    outputSchema: opsOutputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<OpsGenerateBlueprintOutput> {
      if (!ctx.appId) {
        throw new Error(
          'ggui_ops_generate_blueprint: missing caller identity (appId empty)',
        );
      }
      const parsed: OpsGenerateBlueprintInput =
        opsGenerateBlueprintInputSchema.parse(rawInput);

      // Reject retired top-level contract fields BEFORE any
      // persistence so an operator-supplied row can't smuggle
      // deprecated vocabulary (`terminal`, `consumeSpec`,
      // `interaction`, `commandSpec`, `behaviorSpec`) into the
      // registry. The same gate fires on the push + handshake seams
      // in `session-mutations/`.
      assertContractNoRetiredFields(parsed.contract);

      // 0. Every `contract.clientCapabilities.gadgets[*]` MUST
      // resolve in `App.gadgets` by the full `(hook, package,
      // version)` tuple. Throws a precise reject when an
      // unregistered wrapper is referenced. No-op when
      // `appMetadataStore` is unset.
      //
      // The resolved catalog is also threaded into the generator via
      // `UiGenerateInput.appGadgets` (see below) so the code-gen
      // system prompt's `clientCapabilities — registered catalog`
      // section renders the operator's gadgets (Leaflet, Mapbox, …)
      // instead of just the STDLIB seed.
      let resolvedAppLibraries: readonly GadgetDescriptor[] | undefined;
      if (deps.appMetadataStore) {
        const appRecord = await deps.appMetadataStore.get(ctx.appId);
        assertGadgetsRegistered(
          parsed.contract,
          appRecord?.gadgets,
        );
        resolvedAppLibraries = appRecord?.gadgets;
      }

      // 1. Resolve the generator. Throws on unknown slug.
      const generator = resolveGenerator(deps.registry, parsed.generator);

      // 2. Normalize the persona + run near-dup detection.
      const normalizedPersona = normalizePersona(parsed.persona);
      if (normalizedPersona !== undefined && deps.listAllForApp) {
        try {
          const allForApp = await deps.listAllForApp(ctx.appId);
          const existingPersonas = new Set<string>();
          for (const row of allForApp) {
            if (row.variance.persona) existingPersonas.add(row.variance.persona);
          }
          const check = findNearDuplicatePersona(
            normalizedPersona,
            existingPersonas,
          );
          if (check !== null) {
            // Telemetry is lossy + non-throwing. Don't await — drop
            // the warning into the sink and proceed.
            try {
              deps.telemetry?.emit({
                name: 'blueprint.near_duplicate_persona',
                at: Date.now(),
                attributes: {
                  appId: ctx.appId,
                  requestId: ctx.requestId,
                  newPersona: check.newPersona,
                  nearestExisting: check.nearestExisting ?? '',
                  nearestDistance: check.nearestDistance,
                },
              });
            } catch {
              // Swallow telemetry-side throws — they MUST NOT
              // affect handler correctness.
            }
          }
        } catch {
          // Near-dup is best-effort. A failure in the per-app
          // enumeration doesn't block authorship.
        }
      }

      // 3. Compute the contract hash.
      const contract: DataContract = parsed.contract;
      const contractHash = blueprintKey(contract);

      // 4. Resolve LLM credentials.
      const creds = await deps.resolveLlm(ctx);
      if (creds === null) {
        throw new MissingCredentialsError();
      }

      // 5. Dispatch through the generator.
      const generateInput: UiGenerateInput = {
        request: {
          sessionId: `ops_gen_${randomUUID()}`,
          prompt:
            parsed.seedPrompt ??
            'Operator-authored blueprint variant',
        },
        blueprints: deps.blueprints,
        contract,
        llm: creds.selection,
        providerKey: creds.providerKey,
        ...(resolvedAppLibraries !== undefined
          ? { appGadgets: resolvedAppLibraries }
          : {}),
      };

      let result: Awaited<ReturnType<UiGenerator['generate']>>;
      try {
        result = await generator.generate(generateInput);
      } catch (err) {
        throw new GenerationFailedError(
          err instanceof Error ? err.message : 'generator threw',
          err,
        );
      }

      if (!result.ok) {
        throw new GenerationFailedError(
          result.error.message,
          result.error,
        );
      }

      // 6. Persist the blueprint + code body.
      const componentCode = result.response.componentCode;
      const codeHash = createHash('sha256')
        .update(componentCode)
        .digest('hex')
        .slice(0, 32);

      // The advanced generator tunnels `validatorScore` through
      // `metadata` until the UiGenerator interface widens to carry
      // it explicitly. Read it via the typed helper so the default
      // generator (which never sets it) and the advanced generator
      // (which does) both round-trip cleanly.
      const validatorScore = readValidatorScore(result.metadata);

      const blueprintId = mintBlueprintId();
      const blueprint: Blueprint = {
        blueprintId,
        contractHash,
        appId: ctx.appId,
        codeHash,
        generator: generator.slug,
        variance: {
          ...(normalizedPersona !== undefined
            ? { persona: normalizedPersona }
            : {}),
          ...(parsed.context !== undefined
            ? { context: parsed.context }
            : {}),
          ...(parsed.seedPrompt !== undefined
            ? { seedPrompt: parsed.seedPrompt }
            : {}),
        },
        createdAt: now(),
        createdBy: 'operator',
        contract,
        ...(validatorScore !== undefined ? { validatorScore } : {}),
      };

      await deps.blueprintStore.put(blueprint);
      if (deps.putCode) {
        await deps.putCode(codeHash, componentCode);
      }

      // 6.5 Mirror into the cache vectorStore so the agent-facing
      // matchBlueprint exact-key probe (handshake + push) finds this
      // operator-authored blueprint. Without this write, the row sits
      // only in the MVB BlueprintStore and is invisible to the cache-
      // hit path (parallel registries — see task #358 in the project
      // index). Best-effort: registry write hiccups don't fail the
      // ops call since the primary store.put already succeeded.
      if (deps.cacheRegistry) {
        try {
          const intentForCache =
            parsed.seedPrompt ??
            normalizedPersona ??
            `operator-authored blueprint (${blueprintId})`;
          await registerBlueprint(deps.cacheRegistry, ctx.appId, {
            kind: 'template',
            contract,
            intent: intentForCache,
            componentCode,
            provenance: 'register',
          });
        } catch (err) {
          try {
            deps.telemetry?.emit({
              name: 'blueprint.cache_mirror_failed',
              at: Date.now(),
              attributes: {
                appId: ctx.appId,
                requestId: ctx.requestId,
                blueprintId,
                contractHash,
                errorClass: err instanceof Error ? err.name : 'unknown',
                errorMessage: err instanceof Error ? err.message : String(err),
              },
            });
          } catch {
            // Swallow telemetry-side throws.
          }
        }
      }

      // 7. Pin as operator default when requested.
      if (parsed.setAsOperatorDefault === true) {
        await deps.blueprintStore.setOperatorDefault(blueprintId);
      }

      try {
        deps.telemetry?.emit({
          name: 'blueprint.generated',
          at: Date.now(),
          attributes: {
            appId: ctx.appId,
            requestId: ctx.requestId,
            blueprintId,
            contractHash,
            generator: generator.slug,
            createdBy: 'operator',
            setAsOperatorDefault: parsed.setAsOperatorDefault === true,
          },
        });
      } catch {
        // Swallow telemetry-side throws.
      }

      const output: OpsGenerateBlueprintOutput = {
        blueprintId,
        codeHash,
        generator: generator.slug,
        ...(validatorScore !== undefined ? { validatorScore } : {}),
      };
      return output;
    },
  };
}
