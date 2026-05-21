/**
 * Zod input + output schemas for the operator-class blueprint tools.
 * Four tools, all `audience: 'ops'`, all served on `/ops`:
 *
 *   - `ggui_ops_generate_blueprint` — author a new blueprint by
 *     dispatching through the registry's selected generator and
 *     persisting the result. Optionally pins as the operator default
 *     for its `(appId, contractHash)` group.
 *   - `ggui_ops_list_blueprints` — enumerate blueprint metadata
 *     (no code body) under tenancy + optional filters. Sorted by
 *     `createdAt desc`.
 *   - `ggui_ops_update_blueprint` — toggle the operator-default flag
 *     and/or patch variance tags. Immutable fields (contractHash,
 *     appId, codeS3Url, codeHash, generator, createdAt, createdBy)
 *     never mutate; the tool MUST refuse them on input.
 *   - `ggui_ops_delete_blueprint` — idempotent removal. Second delete
 *     for the same id returns `{deleted: true}` — never throws.
 *
 * The schemas live in `@ggui-ai/protocol` (not the handler package)
 * for the same reason all wire-shape schemas do: the protocol package
 * is the source of truth for every MCP wire surface, and consumers
 * (cloud pod handlers, console UI, fixture authors) can import from
 * one place. Handler package wraps these into `SharedHandler`
 * factories.
 */
import { z } from 'zod';
import {
  dataContractSchema,
  jsonValueSchema,
} from './data-contract.js';
import { blueprintSchema, blueprintVarianceSchema } from './blueprint.js';

/**
 * `ggui_ops_generate_blueprint` input. Operator picks the contract +
 * optional generator override + variance tags. `setAsOperatorDefault`
 * pins the newly-minted blueprint as the default for its
 * `(appId, contractHash)` group (the store clears any prior default
 * in the same group, mirroring `BlueprintStore.setOperatorDefault`).
 *
 * `persona` is a top-level convenience field — handlers fold it into
 * the `variance.persona` slot after normalization (lowercase + trim
 * + Levenshtein near-dup warning).
 *
 * `appId` is NOT on the input shape — the handler reads it off
 * `ctx.appId` resolved by the upstream auth adapter. Cross-tenant
 * authorship would be a security-boundary violation.
 */
export const opsGenerateBlueprintInputSchema = z
  .object({
    contract: dataContractSchema,
    generator: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Generator slug (e.g. `ui-gen-default-haiku-4-5`). When omitted, dispatches through `GeneratorRegistry.defaultGenerator()`.',
      ),
    persona: z
      .string()
      .optional()
      .describe(
        "Free-form persona tag (e.g. 'minimalist', 'data-dense'). Normalized via lowercase+trim before persistence; logged as a warning when within Levenshtein distance < 2 of an existing tag for the same appId.",
      ),
    aesthetic: z
      .string()
      .optional()
      .describe(
        "Free-form aesthetic tag (e.g. 'glassmorphic', 'brutalist', 'editorial'). Persisted on `Blueprint.variance.aesthetic`. Distinct from persona — persona names the user mental model; aesthetic names the visual treatment.",
      ),
    context: z
      .record(z.string(), jsonValueSchema)
      .optional()
      .describe(
        'Small structured signal carried alongside the persona. Persisted on `Blueprint.variance.context`.',
      ),
    seedPrompt: z
      .string()
      .optional()
      .describe(
        "The raw operator prompt that produced this variant. Round-trip input for the variant-selector + audit trail.",
      ),
    setAsOperatorDefault: z
      .boolean()
      .optional()
      .describe(
        'When true, pins the new blueprint as the operator default for its `(appId, contractHash)` group, clearing any prior default in the same group.',
      ),
  })
  .strict();

/**
 * `ggui_ops_generate_blueprint` output. Metadata-only — the code body
 * lives in S3 (cloud) or the in-memory code map (OSS) and is fetched
 * via the existing push fast-path on cache hit.
 */
export const opsGenerateBlueprintOutputSchema = z
  .object({
    blueprintId: z.string().min(1),
    codeHash: z
      .string()
      .optional()
      .describe(
        'Content hash of the generated code body. Absent when the generator returned a non-`ok` result and persistence skipped — the failure mode is surfaced through generator-level error reporting elsewhere.',
      ),
    validatorScore: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Advanced generator's iterative-loop validator score (0-1). Absent for default-generator output.",
      ),
    generator: z
      .string()
      .min(1)
      .describe('Slug of the generator the dispatch resolved to.'),
  })
  .strict();

/**
 * `ggui_ops_register_blueprint` input. Sibling of `*_generate_*` — no
 * LLM dispatch, no generator. The operator supplies the COMPONENT
 * CODE BYTES directly and the handler persists them under the same
 * `(appId, contractHash)` slot. Use cases:
 *
 *   - Seeding pre-vetted blueprints at deploy time (fixture corpus,
 *     migration imports).
 *   - Round-tripping export+reimport — operator exports a blueprint
 *     from one tenant and re-registers it in another.
 *   - Reapplying a fixed version of a blueprint after live edits
 *     (manual recovery from a bad generate run).
 *
 * Same tenancy + variance + default-pin semantics as
 * `*_generate_*`; the only difference is the LLM/generator dispatch
 * is replaced with a verbatim accept of the operator's
 * `componentCode` string.
 *
 * `generator` is OPTIONAL here too — when omitted, the handler stamps
 * the registry default's slug onto the persisted Blueprint so
 * downstream `*_list_blueprints` consumers see a stable provenance
 * field. `validatorScore` is never populated (no validator ran);
 * operators wanting validator metadata should round-trip through
 * `*_generate_*` instead.
 */
export const opsRegisterBlueprintInputSchema = z
  .object({
    contract: dataContractSchema,
    componentCode: z
      .string()
      .min(1)
      .describe(
        'Verbatim component-code body to persist. Stored as-is — no LLM call, no validator pass. Operator owns correctness; the handler computes the canonical sha256 codeHash and routes the bytes through the same persistence seams as `*_generate_*`.',
      ),
    generator: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional generator slug to stamp on the persisted Blueprint.generator field — purely an audit/provenance hint for downstream `*_list_blueprints` consumers. Defaults to the registry default slug.',
      ),
    persona: z
      .string()
      .optional()
      .describe(
        "Free-form persona tag (e.g. 'minimalist', 'data-dense'). Normalized via lowercase+trim before persistence; logged as a warning when within Levenshtein distance < 2 of an existing tag for the same appId.",
      ),
    aesthetic: z
      .string()
      .optional()
      .describe(
        "Free-form aesthetic tag. Persisted on `Blueprint.variance.aesthetic`.",
      ),
    context: z
      .record(z.string(), jsonValueSchema)
      .optional()
      .describe(
        'Small structured signal carried alongside the persona. Persisted on `Blueprint.variance.context`.',
      ),
    seedPrompt: z
      .string()
      .optional()
      .describe(
        'Optional originating prompt for audit + round-tripping (e.g. the prose the operator originally fed into `*_generate_*` before exporting).',
      ),
    setAsOperatorDefault: z
      .boolean()
      .optional()
      .describe(
        'When true, pins the new blueprint as the operator default for its `(appId, contractHash)` group, clearing any prior default in the same group.',
      ),
  })
  .strict();

/**
 * `ggui_ops_register_blueprint` output. Same shape as
 * `*_generate_*` minus `validatorScore` (no validator runs on the
 * register path).
 */
export const opsRegisterBlueprintOutputSchema = z
  .object({
    blueprintId: z.string().min(1),
    codeHash: z
      .string()
      .min(1)
      .describe(
        'Content hash of the persisted code body (full sha256 hex).',
      ),
    generator: z
      .string()
      .min(1)
      .describe(
        'Resolved generator slug stamped on the Blueprint.generator field — either the supplied input or the registry default.',
      ),
  })
  .strict();

/**
 * `ggui_ops_list_blueprints` input. `appId` is NOT carried on the
 * wire — handlers scope from `ctx.appId`. The filters below are AND-
 * composed against the matching `(appId, *)` view of the store.
 *
 * Behavior split:
 *   - When `contractHash` is the ONLY filter (no semantic keywords
 *     or persona), handlers dispatch through
 *     `BlueprintStore.list(appId, contractHash)` for the indexed
 *     fast path.
 *   - When `intentKeywords` or `persona` carry semantic intent,
 *     handlers dispatch through `BlueprintSearch.search()` and
 *     return the matching rows (sorted by score desc, then
 *     `createdAt desc`).
 *   - When no filter is supplied, handlers enumerate every blueprint
 *     under `appId` via the search seam (which scopes by appId
 *     internally), sorted `createdAt desc`.
 */
export const opsListBlueprintsInputSchema = z
  .object({
    contractHash: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Filter to a single `(appId, contractHash)` group. Combine with `generator` / `persona` to narrow within the group.',
      ),
    generator: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Filter to blueprints produced by a specific generator slug.',
      ),
    persona: z
      .string()
      .optional()
      .describe(
        'Filter on `variance.persona`. Normalized to match persisted form (lowercase+trim).',
      ),
    intentKeywords: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Semantic-search tokens. When set, dispatches through `BlueprintSearch.search()` rather than indexed `list()`.',
      ),
  })
  .strict();

export const opsListBlueprintsOutputSchema = z
  .object({
    blueprints: z.array(blueprintSchema),
  })
  .strict();

/**
 * `ggui_ops_update_blueprint` input. Only mutable fields are present
 * here — `contractHash`, `appId`, `codeS3Url`, `codeHash`,
 * `generator`, `createdAt`, `createdBy` are immutable invariants
 * and the schema does NOT accept them. Operators who want to
 * "replace" a row delete + re-generate.
 */
export const opsUpdateBlueprintInputSchema = z
  .object({
    blueprintId: z.string().min(1),
    isOperatorDefault: z
      .literal(true)
      .optional()
      .describe(
        'When `true`, pins this blueprint as the operator default for its `(appId, contractHash)` group. Clears any prior default. Cannot set to `false` — to unpin, set another blueprint in the same group as default, or delete this one.',
      ),
    variance: blueprintVarianceSchema
      .optional()
      .describe(
        'Partial-merge into the existing variance. Supplied keys overwrite; omitted keys preserve. Pass `{persona: ""}` to clear a persona (handler treats empty string as removal).',
      ),
  })
  .strict();

export const opsUpdateBlueprintOutputSchema = z
  .object({
    blueprintId: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

/**
 * `ggui_ops_delete_blueprint` input + output. Idempotent: the handler
 * returns `{deleted: true}` regardless of whether the row existed,
 * matching `BlueprintStore.delete`'s no-throw contract.
 */
export const opsDeleteBlueprintInputSchema = z
  .object({
    blueprintId: z.string().min(1),
  })
  .strict();

export const opsDeleteBlueprintOutputSchema = z
  .object({
    deleted: z.literal(true),
  })
  .strict();

/**
 * Inferred TS types — exposed so handler factories and tests share
 * one source of truth with the wire shape. Pre-launch posture: no
 * `@deprecated` aliases — these are the canonical names.
 */
export type OpsGenerateBlueprintInput = z.infer<
  typeof opsGenerateBlueprintInputSchema
>;
export type OpsGenerateBlueprintOutput = z.infer<
  typeof opsGenerateBlueprintOutputSchema
>;
export type OpsRegisterBlueprintInput = z.infer<
  typeof opsRegisterBlueprintInputSchema
>;
export type OpsRegisterBlueprintOutput = z.infer<
  typeof opsRegisterBlueprintOutputSchema
>;
export type OpsListBlueprintsInput = z.infer<
  typeof opsListBlueprintsInputSchema
>;
export type OpsListBlueprintsOutput = z.infer<
  typeof opsListBlueprintsOutputSchema
>;
export type OpsUpdateBlueprintInput = z.infer<
  typeof opsUpdateBlueprintInputSchema
>;
export type OpsUpdateBlueprintOutput = z.infer<
  typeof opsUpdateBlueprintOutputSchema
>;
export type OpsDeleteBlueprintInput = z.infer<
  typeof opsDeleteBlueprintInputSchema
>;
export type OpsDeleteBlueprintOutput = z.infer<
  typeof opsDeleteBlueprintOutputSchema
>;
