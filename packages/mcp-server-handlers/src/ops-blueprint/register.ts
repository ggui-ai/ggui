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
 *      tenant A and registers it into tenant B without re-running the
 *      LLM.
 *   3. Manual recovery — after a bad generate run, reapply a known-good
 *      version from version control.
 *
 * ## Audience
 *
 * `['ops']` — registered on `/ops`. NOT visible to agents on `/mcp`.
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
  GeneratorRegistry,
  TelemetrySink,
} from "@ggui-ai/mcp-server-core";
import {
  opsRegisterBlueprintInputSchema,
  type Blueprint,
  type DataContract,
  type OpsRegisterBlueprintInput,
  type OpsRegisterBlueprintOutput,
} from "@ggui-ai/protocol";
import { blueprintKey } from "@ggui-ai/protocol/blueprint-key";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { assertContractNoRetiredFields } from "../renders/assert-contract-no-retired-fields.js";
import { assertGadgetsRegistered } from "../renders/assert-gadgets.js";
import { registerBlueprint, type BlueprintRegistryDeps } from "../renders/index.js";
import type { HandlerContext, SharedHandler } from "../types.js";
import type { PutCodeHook } from "./generate.js";
import { findNearDuplicatePersona, normalizePersona } from "./persona-normalization.js";

const opsInputSchema = opsRegisterBlueprintInputSchema.shape;
const opsOutputSchema = z.object({
  blueprintId: z.string().min(1),
  codeHash: z.string().min(1),
  generator: z.string().min(1),
}).shape;

/**
 * Deps for `ggui_ops_register_blueprint`. Mirrors `*_generate_*`'s
 * deps minus `resolveLlm` and `blueprints` (no generator dispatch).
 */
export interface GguiOpsRegisterBlueprintDeps {
  /**
   * Generator registry — read for the default slug to stamp on the
   * persisted Blueprint when the input omits `generator`. Same
   * registry the `*_generate_*` handler dispatches through; reusing
   * it here keeps the provenance field consistent across registration
   * paths.
   */
  readonly registry: GeneratorRegistry;
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
}

export function createGguiOpsRegisterBlueprintHandler(
  deps: GguiOpsRegisterBlueprintDeps
): SharedHandler<typeof opsInputSchema, typeof opsOutputSchema, OpsRegisterBlueprintOutput> {
  const now = deps.now ?? (() => new Date().toISOString());
  const mintBlueprintId = deps.mintBlueprintId ?? (() => `bp_${randomUUID()}`);

  return {
    name: "ggui_ops_register_blueprint",
    title: "Register blueprint",
    audience: ["ops"],
    description:
      "Register a pre-built blueprint variant (operator-supplied componentCode bytes, no LLM dispatch). Sibling of `ggui_ops_generate_blueprint` — same persistence + dual-write semantics, same variance + default-pin behavior. Use for fixture seeding, export/reimport round-trips, and manual recovery. Returns `{blueprintId, codeHash, generator}` where `generator` is the resolved registry-default slug or the supplied override (audit/provenance only — no code is generated).",
    inputSchema: opsInputSchema,
    outputSchema: opsOutputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext
    ): Promise<OpsRegisterBlueprintOutput> {
      if (!ctx.appId) {
        throw new Error("ggui_ops_register_blueprint: missing caller identity (appId empty)");
      }
      const parsed: OpsRegisterBlueprintInput = opsRegisterBlueprintInputSchema.parse(rawInput);

      // Reject retired top-level contract fields BEFORE any
      // persistence so an operator-supplied row can't smuggle
      // deprecated vocabulary (`terminal`, `consumeSpec`,
      // `interaction`, `commandSpec`, `behaviorSpec`) into the
      // registry. The same gate fires on the push + handshake seams
      // in `renders/`.
      assertContractNoRetiredFields(parsed.contract);

      // Every `contract.clientCapabilities.gadgets[*]` MUST resolve
      // in `App.gadgets` by the full `(hook, package, version)`
      // tuple. Fails fast with a precise reject before any state
      // mutation. No-op when no `appMetadataStore` is bound.
      if (deps.appMetadataStore) {
        const appRecord = await deps.appMetadataStore.get(ctx.appId);
        assertGadgetsRegistered(parsed.contract, appRecord?.gadgets);
      }

      // 1. Normalize the persona + run near-dup detection. Same
      // posture as ops_generate.
      const normalizedPersona = normalizePersona(parsed.persona);
      if (normalizedPersona !== undefined && deps.listAllForApp) {
        try {
          const allForApp = await deps.listAllForApp(ctx.appId);
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
                  appId: ctx.appId,
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

      // 2. Resolve generator slug to stamp on Blueprint.generator —
      // provenance hint only, NOT dispatched. When the operator
      // supplied `generator`, validate against the registry just like
      // ops_generate would (so downstream consumers can trust the
      // slug); when absent, use the registry default.
      const resolvedGeneratorSlug: string = parsed.generator
        ? (deps.registry.get(parsed.generator)?.slug ?? parsed.generator)
        : deps.registry.defaultGenerator().slug;

      // 3. Compute canonical hashes.
      const contract: DataContract = parsed.contract;
      const contractHash = blueprintKey(contract);
      const componentCode = parsed.componentCode;
      const codeHash = createHash("sha256").update(componentCode).digest("hex");

      const blueprintId = mintBlueprintId();
      const blueprint: Blueprint = {
        blueprintId,
        contractHash,
        appId: ctx.appId,
        codeHash,
        generator: resolvedGeneratorSlug,
        variance: {
          ...(normalizedPersona !== undefined ? { persona: normalizedPersona } : {}),
          ...(parsed.aesthetic !== undefined ? { aesthetic: parsed.aesthetic } : {}),
          ...(parsed.context !== undefined ? { context: parsed.context } : {}),
          ...(parsed.seedPrompt !== undefined ? { seedPrompt: parsed.seedPrompt } : {}),
        },
        createdAt: now(),
        createdBy: "operator",
        contract,
      };

      // 4. Persist the blueprint + code body.
      await deps.blueprintStore.put(blueprint);
      if (deps.putCode) {
        await deps.putCode(codeHash, componentCode);
      }

      // 4.5 Mirror into the cache vectorStore so the agent-facing
      // matchBlueprint exact-key probe (handshake + push) finds this
      // operator-registered blueprint. Symmetric with ops_generate's
      // dual-write — see #358.
      if (deps.cacheRegistry) {
        try {
          const intentForCache =
            parsed.seedPrompt ??
            normalizedPersona ??
            `operator-registered blueprint (${blueprintId})`;
          await registerBlueprint(deps.cacheRegistry, ctx.appId, {
            kind: "template",
            contract,
            intent: intentForCache,
            componentCode,
            provenance: "register",
          });
        } catch (err) {
          try {
            deps.telemetry?.emit({
              name: "blueprint.cache_mirror_failed",
              at: Date.now(),
              attributes: {
                appId: ctx.appId,
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

      // 5. Pin as operator default when requested.
      if (parsed.setAsOperatorDefault === true) {
        await deps.blueprintStore.setOperatorDefault(blueprintId);
      }

      try {
        deps.telemetry?.emit({
          name: "blueprint.registered",
          at: Date.now(),
          attributes: {
            appId: ctx.appId,
            requestId: ctx.requestId,
            blueprintId,
            contractHash,
            generator: resolvedGeneratorSlug,
            createdBy: "operator",
            setAsOperatorDefault: parsed.setAsOperatorDefault === true,
          },
        });
      } catch {
        // Swallow telemetry-side throws.
      }

      return {
        blueprintId,
        codeHash,
        generator: resolvedGeneratorSlug,
      };
    },
  };
}
