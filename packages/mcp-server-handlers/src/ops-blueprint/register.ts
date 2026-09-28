/**
 * `ggui_ops_register_blueprint` — operator-class blueprint registration
 * WITHOUT an LLM dispatch.
 *
 * Sibling of `ggui_ops_generate_blueprint`. Same persistence seams +
 * dual-write (BlueprintStore + cache vectorStore via registerBlueprint),
 * same variance + default-pin semantics. The only difference is the
 * code body: instead of dispatching through `generator.generate(...)`
 * to produce componentCode, the operator supplies the bytes directly
 * and the handler persists them verbatim.
 *
 * ## Use cases
 *
 *   1. Fixture seeding at deploy time — pre-vetted blueprints for the
 *      app's primary screens land in the registry before any agent
 *      touches the system.
 *   2. Export/reimport round-trip — operator exports a blueprint from
 *      app A and registers it into app B without re-running the
 *      LLM.
 *   3. Manual recovery — after a bad generate run, reapply a known-good
 *      version from version control.
 *
 * ## Audience
 *
 * `['ops']` — served on `/control`. NOT visible to agents on `/mcp`.
 *
 * ## What this handler does NOT do
 *
 *   - Validate or transform the supplied componentCode. Operator owns
 *     correctness — there's no Tier-1 syntax check, no module-shape
 *     check, no compatibility-pass. The same rules ops_generate runs
 *     post-LLM apply here too, but the handler doesn't re-run them.
 *   - Run a UiGenerator. No credentials needed; no model call; no
 *     UiGenerateInput composition.
 *   - Validate the contract beyond Zod parsing. Same posture as
 *     ops_generate — schema-compat + hygiene-3 lint live elsewhere.
 */

import type {
  AppMetadataStore,
  BlueprintStore,
  TelemetrySink,
} from "@ggui-ai/mcp-server-core";
import {
  llmBlueprintSourceSchema,
  opsRegisterBlueprintInputSchema,
  type Blueprint,
  type BlueprintSource,
  type DataContract,
  type LlmBlueprintSource,
  type OpsRegisterBlueprintInput,
  type OpsRegisterBlueprintOutput,
  type UserBlueprintSource,
} from "@ggui-ai/protocol";
import { blueprintKey } from "@ggui-ai/protocol/blueprint-key";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertContractNoRetiredFields } from "../renders/assert-contract-no-retired-fields.js";
import { assertGadgetsRegistered } from "../renders/assert-gadgets.js";
import { registerBlueprint, type BlueprintRegistryDeps } from "../renders/index.js";
import { defineHandler, type HandlerContext } from "../types.js";
import { resolveEffectiveAppId, type OpsBlueprintAppAuthorizer } from "./app-access.js";
import type { PutCodeHook } from "./generate.js";
import { DirectionScopeWithoutDigestError } from "./errors.js";
import { findNearDuplicatePersona, normalizePersona } from "./persona-normalization.js";

const opsInputSchema = opsRegisterBlueprintInputSchema.shape;
const opsOutputSchema = z.object({
  blueprintId: z.string().min(1),
  codeHash: z.string().min(1),
  source: z.object({ kind: z.literal("user") }).strict(),
}).shape;

/**
 * Provenance stamped on every blueprint this handler persists:
 * operator-supplied bytes, no LLM dispatch — the `user` arm carries
 * no engine claim because none exists to record.
 */
const USER_SOURCE: UserBlueprintSource = { kind: "user" };

/**
 * Deps shared by `ggui_ops_register_blueprint` and the in-process
 * {@link createRegisterGeneratedBlueprint}. Mirrors `*_generate_*`'s deps
 * minus `resolveLlm`, `blueprints` and `registry`: neither entry dispatches
 * a generator, so there is no slug to resolve. The operator door stamps
 * `{kind: 'user'}`; the generated entry takes the generation's own `llm`
 * record.
 */
export interface GguiOpsRegisterBlueprintDeps {
  /**
   * Multi-variant blueprint persistence seam — same instance the
   * `*_generate_*` handler writes to.
   */
  readonly blueprintStore: BlueprintStore;
  /**
   * Per-app blueprint enumerator for the persona near-dup check.
   * Optional; when omitted the check is skipped.
   */
  readonly listAllForApp?: (appId: string) => Promise<readonly Blueprint[]>;
  /**
   * Per-app metadata resolver — when bound, the handler runs
   * `assertGadgetsRegistered` against the supplied contract
   * before persisting. Unregistered `(package, export name)` refs
   * fail fast with a precise reject: `GadgetNotRegisteredError` /
   * `GadgetPackageMismatchError`. Deployments that do not bind an
   * `appMetadataStore` skip the check.
   */
  readonly appMetadataStore?: AppMetadataStore;
  /**
   * Optional code-body hook for in-memory stores. When the bound
   * store is `InMemoryBlueprintStore`, the handler calls this with
   * `(codeHash, body)` so the code is reachable via
   * `getCode(codeHash)`. Cloud adapters that persist code inside
   * `put` itself omit this dep.
   */
  readonly putCode?: PutCodeHook;
  /**
   * Cache-registry mirror — same dual-write pattern as
   * `*_generate_*`. When bound, the supplied componentCode bytes are
   * ALSO registered into the vectorStore via `registerBlueprint`
   * so the agent-facing matchBlueprint exact-key probe finds them.
   * Best-effort: a mirror-write failure emits a
   * `blueprint.cache_mirror_failed` telemetry event and is
   * swallowed.
   */
  readonly cacheRegistry?: BlueprintRegistryDeps;
  /**
   * Optional telemetry sink — receives `near-duplicate-persona`
   * warnings + `blueprint.registered` /
   * `blueprint.cache_mirror_failed` events.
   */
  readonly telemetry?: TelemetrySink;
  /**
   * Optional clock injection — defaults to `() => new Date().toISOString()`.
   */
  readonly now?: () => string;
  /**
   * Optional id minter — defaults to `() => 'bp_' + randomUUID()`.
   */
  readonly mintBlueprintId?: () => string;
  /**
   * Optional app-access authorizer — when bound, consulted on EVERY
   * resolution (see {@link resolveEffectiveAppId}) to decide whether
   * the caller may curate the effective `appId`, including cross-app
   * calls that supply an explicit `appId` input different from
   * `ctx.appId`. Unbound: legacy bound-only posture, cross-app input
   * fails closed with `CrossAppCurationUnavailableError`.
   */
  readonly authorizeAppAccess?: OpsBlueprintAppAuthorizer;
}

/**
 * What one registration records about where its bytes came from.
 */
interface RegistrationProvenance {
  readonly source: BlueprintSource;
  /**
   * The authored (pre-compile) form of `componentCode`, when the caller
   * has one — only the in-process generated-bytes path supplies it
   * ({@link createRegisterGeneratedBlueprint}). Never on the wire.
   */
  readonly sourceCode?: string;
}

/**
 * The registration body both entries share: app resolution, the
 * contract gates, the durable row, the cache mirror, the default pin and
 * the event. The two entries differ only in the provenance they pass.
 */
function makeRegisterCore(deps: GguiOpsRegisterBlueprintDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const mintBlueprintId = deps.mintBlueprintId ?? (() => `bp_${randomUUID()}`);

  return async function registerVariant(
    parsed: OpsRegisterBlueprintInput,
    ctx: HandlerContext,
    provenance: RegistrationProvenance
  ): Promise<{ readonly blueprintId: string; readonly codeHash: string }> {

    const appId = await resolveEffectiveAppId({
      toolName: "ggui_ops_register_blueprint",
      inputAppId: parsed.appId,
      ctx,
      ...(deps.authorizeAppAccess ? { authorize: deps.authorizeAppAccess } : {}),
    });

    // Reject retired top-level contract fields BEFORE any
    // persistence so an operator-supplied row can't smuggle
    // deprecated vocabulary (`terminal`, `consumeSpec`,
    // `interaction`, `commandSpec`, `behaviorSpec`) into the
    // registry. The same gate fires on the render + handshake seams
    // in `renders/`.
    assertContractNoRetiredFields(parsed.contract);

    // Every `contract.clientCapabilities.gadgets[*]` MUST resolve
    // in `App.gadgets` by `(package, export name)` — the wire
    // carries no version; the operator's catalog is the version
    // pin. Fails fast with a precise reject before any state
    // mutation. No-op when no `appMetadataStore` is bound.
    if (deps.appMetadataStore) {
      const appRecord = await deps.appMetadataStore.get(appId);
      assertGadgetsRegistered(parsed.contract, appRecord?.gadgets);
    }

    // 1. Normalize the persona + run near-dup detection. Same
    // posture as ops_generate.
    const normalizedPersona = normalizePersona(parsed.persona);
    if (normalizedPersona !== undefined && deps.listAllForApp) {
      try {
        const allForApp = await deps.listAllForApp(appId);
        const existingPersonas: ReadonlyArray<string> = allForApp
          .map((bp) => bp.variance.persona)
          .filter((p): p is string => typeof p === "string");
        const dup = findNearDuplicatePersona(normalizedPersona, existingPersonas);
        if (dup && dup.nearestExisting !== null) {
          try {
            deps.telemetry?.emit({
              name: "near-duplicate-persona",
              at: Date.now(),
              attributes: {
                appId,
                requestId: ctx.requestId,
                candidate: normalizedPersona,
                existing: dup.nearestExisting,
                distance: dup.nearestDistance,
              },
            });
          } catch {
            // Swallow telemetry-side throws.
          }
        }
      } catch {
        // Swallow enumeration failures — the near-dup warning is
        // an early-detection signal, not a gate.
      }
    }

    // 2. Compute canonical hashes.
    const contract: DataContract = parsed.contract;
    const contractHash = blueprintKey(contract);
    const componentCode = parsed.componentCode;
    const codeHash = createHash("sha256").update(componentCode).digest("hex");

    // ggui#1427 — a scope without a digest is a scope for nothing: refused
    // before anything is persisted (see DirectionScopeWithoutDigestError).
    if (parsed.directionScope !== undefined && parsed.directionDigest === undefined) {
      throw new DirectionScopeWithoutDigestError();
    }

    const blueprintId = mintBlueprintId();
    // ONE variance for BOTH stores. The cache row's exact key is
    // `variantKey(variance)`; omitting it on the cache call filed every
    // variant under the default-variant key, where an earlier registration
    // of the same contract already sat — the mirror then returned THAT row
    // and the new variant was never bound (the durable row said one thing,
    // the served index another). Same rule as ops_generate.
    const variance = {
      ...(normalizedPersona !== undefined ? { persona: normalizedPersona } : {}),
      ...(parsed.aesthetic !== undefined ? { aesthetic: parsed.aesthetic } : {}),
      ...(parsed.context !== undefined ? { context: parsed.context } : {}),
      ...(parsed.seedPrompt !== undefined ? { seedPrompt: parsed.seedPrompt } : {}),
    };
    const blueprint: Blueprint = {
      blueprintId,
      contractHash,
      appId,
      codeHash,
      // The caller's provenance, on BOTH stores this call writes (MVB
      // row here, cache mirror below): the user arm for operator-
      // supplied bytes, the llm arm for engine-generated ones.
      source: provenance.source,
      variance,
      createdAt: now(),
      createdBy: "operator",
      contract,
    };

    // 3. Persist the blueprint + code body.
    await deps.blueprintStore.put(blueprint);
    if (deps.putCode) {
      await deps.putCode(codeHash, componentCode);
    }

    // 3.5 Mirror into the cache vectorStore so the agent-facing
    // matchBlueprint exact-key probe (handshake + render) finds this
    // operator-registered blueprint. Symmetric with ops_generate's
    // dual-write — see #358.
    if (deps.cacheRegistry) {
      try {
        // ggui#1427 — the request's own sentence, when the caller has it
        // (symmetric with `*_generate_*`'s `intent`): prompt-only, never
        // part of the cache identity.
        const intentForCache =
          parsed.intent ??
          parsed.seedPrompt ??
          normalizedPersona ??
          `operator-registered blueprint (${blueprintId})`;
        await registerBlueprint(deps.cacheRegistry, appId, {
          kind: "template",
          contract,
          intent: intentForCache,
          // ggui#1275 — an explicit intent or a seed prompt states the
          // UI's task. A persona describes the agent and the placeholder
          // describes nothing: both are stand-ins the matcher's judge
          // never sees.
          intentSource:
            parsed.intent !== undefined || parsed.seedPrompt !== undefined
              ? "authored"
              : "fallback",
          // ggui#1427 — the fit facts `fits()` reads before the judge
          // ranks this row. Absent inputs write nothing (not-evaluated).
          ...(parsed.judgedCanvases !== undefined ? { judgedCanvases: parsed.judgedCanvases } : {}),
          ...(parsed.aestheticPreset !== undefined ? { aestheticPreset: parsed.aestheticPreset } : {}),
          ...(parsed.directionDigest !== undefined ? { directionDigest: parsed.directionDigest } : {}),
          ...(parsed.directionDigest !== undefined && parsed.directionScope !== undefined
            ? { directionScope: parsed.directionScope }
            : {}),
          componentCode,
          // ggui#1493 — the authored form of `componentCode`, when the
          // caller has one (the in-process generated-bytes path only).
          // The registry persists its hash and body only when a code
          // store is bound and the pair is not byte-identical.
          ...(provenance.sourceCode !== undefined ? { sourceCode: provenance.sourceCode } : {}),
          // Same provenance as the MVB row above — one call, one
          // provenance claim across both stores.
          source: provenance.source,
          // The cache row MUST carry the same variance as the MVB row —
          // its exact key is `variantKey(variance)`.
          variance,
          // An operator invoked this tool. Without it the durable
          // record would claim the standard agent flow minted a row
          // that is retained permanently.
          createdBy: "operator",
        });
      } catch (err) {
        try {
          deps.telemetry?.emit({
            name: "blueprint.cache_mirror_failed",
            at: Date.now(),
            attributes: {
              appId,
              requestId: ctx.requestId,
              blueprintId,
              contractHash,
              errorClass: err instanceof Error ? err.name : "unknown",
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          });
        } catch {
          // Swallow telemetry-side throws.
        }
      }
    }

    // 4. Pin as operator default when requested.
    if (parsed.setAsOperatorDefault === true) {
      await deps.blueprintStore.setOperatorDefault(blueprintId);
    }

    try {
      deps.telemetry?.emit({
        name: "blueprint.registered",
        at: Date.now(),
        attributes: {
          appId,
          requestId: ctx.requestId,
          blueprintId,
          contractHash,
          // Flat-codec provenance key — 'user' on the operator door,
          // 'llm' on the generated-bytes path.
          sourceKind: provenance.source.kind,
          createdBy: "operator",
          setAsOperatorDefault: parsed.setAsOperatorDefault === true,
        },
      });
    } catch {
      // Swallow telemetry-side throws.
    }

    return { blueprintId, codeHash };
  };
}

export function createGguiOpsRegisterBlueprintHandler(
  deps: GguiOpsRegisterBlueprintDeps
) {
  const registerVariant = makeRegisterCore(deps);

  return defineHandler({
    name: "ggui_ops_register_blueprint",
    title: "Register blueprint",
    audience: ["ops"],
    description:
      "Register a pre-built blueprint variant (operator-supplied componentCode bytes, no LLM dispatch). Sibling of `ggui_ops_generate_blueprint` — same persistence + dual-write semantics, same variance + default-pin behavior. Use for fixture seeding, export/reimport round-trips, and manual recovery. Returns `{blueprintId, codeHash, source}` where `source` is always `{kind: 'user'}` — hand-supplied bytes carry no engine claim, so none is recorded. App-scoped variant curation for an app you operate — distinct from the personal saved-blueprint library (the _my_ tools).",
    inputSchema: opsInputSchema,
    outputSchema: opsOutputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext
    ): Promise<OpsRegisterBlueprintOutput> {
      const parsed: OpsRegisterBlueprintInput = opsRegisterBlueprintInputSchema.parse(rawInput);
      // Operator-supplied bytes, no LLM dispatch: the user arm, and no
      // authored source (this door never carries one — ggui#1477).
      const { blueprintId, codeHash } = await registerVariant(parsed, ctx, { source: USER_SOURCE });
      return {
        blueprintId,
        codeHash,
        source: USER_SOURCE,
      };
    },
  });
}

/**
 * Engine-generated bytes and the authored source they were compiled
 * from — what {@link createRegisterGeneratedBlueprint} registers.
 */
export interface GeneratedBlueprintBytes {
  /**
   * The authored (pre-compile) source that `componentCode` was compiled
   * from. **Caller obligation:** it MUST be that exact pair, produced by
   * one generation (for example, the authored `.tsx` a generation wrote
   * and the module compiled from it). Nothing here recompiles it to check — that is why
   * this entry is in-process only and the public operator door takes no
   * source. A pair that is byte-identical records no source (the
   * registry's collapse rule), which is the honest answer for a
   * generation that produced no distinct authored form.
   */
  readonly sourceCode: string;
  /**
   * The generation's own provenance, read from what the generation itself
   * reported — never a placeholder or a configured default. An `llm` record with a guessed model is a provenance
   * claim nobody made. Validated against the protocol's schema.
   */
  readonly source: LlmBlueprintSource;
}

/** What {@link createRegisterGeneratedBlueprint}'s entry returns. */
export interface RegisterGeneratedBlueprintOutput {
  readonly blueprintId: string;
  readonly codeHash: string;
  readonly source: LlmBlueprintSource;
}

/**
 * The in-process generated-bytes registration entry. `input` is the same
 * RAW input `ggui_ops_register_blueprint` takes — parsed with its schema
 * on entry, so a value the schema refuses throws, exactly as it would
 * through the operator door.
 */
export type RegisterGeneratedBlueprint = (
  input: Record<string, unknown>,
  generated: GeneratedBlueprintBytes,
  ctx: HandlerContext
) => Promise<RegisterGeneratedBlueprintOutput>;

/**
 * ggui#1493 (ggui#1477's source half) — register ENGINE-GENERATED bytes
 * with the authored source they were compiled from, in-process.
 *
 * Same body as `ggui_ops_register_blueprint` (one durable row, one cache
 * mirror, the same gates and variance), with two differences: provenance
 * is the generation's `llm` arm, and the authored source reaches the
 * cache registry, so a render that reuses the registration serves it
 * (`ggui_get_render_source`, save-to-library). It is NOT an MCP tool and
 * is on no wire: the public operator door stays source-free, because it
 * cannot verify that supplied source compiles to the supplied code.
 *
 * Refuses, before anything is persisted, provenance the protocol's
 * `llmBlueprintSourceSchema` rejects and an empty `sourceCode`.
 */
export function createRegisterGeneratedBlueprint(
  deps: GguiOpsRegisterBlueprintDeps
): RegisterGeneratedBlueprint {
  const registerVariant = makeRegisterCore(deps);
  return async (input, generated, ctx) => {
    const parsed: OpsRegisterBlueprintInput = opsRegisterBlueprintInputSchema.parse(input);
    const source: LlmBlueprintSource = llmBlueprintSourceSchema.parse(generated.source);
    if (generated.sourceCode.length === 0) {
      throw new Error(
        "registerGeneratedBlueprint: sourceCode must be the non-empty authored source componentCode was compiled from"
      );
    }
    const { blueprintId, codeHash } = await registerVariant(parsed, ctx, {
      source,
      sourceCode: generated.sourceCode,
    });
    return { blueprintId, codeHash, source };
  };
}
