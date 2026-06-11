/**
 * Zod schema mirror of {@link Blueprint}. Structural-mirror discipline
 * matches `data-contract.ts`'s posture: the TS interface in
 * `../types/blueprint.ts` is the declared source of truth; the schema
 * here is `z.ZodType<Blueprint>` so any drift fails compile.
 */
import { z } from 'zod';
import type {
  AppBlueprintSearchConfig,
  Blueprint,
  BlueprintVariance,
} from '../types/blueprint';
import type {
  BlueprintSource,
  CuratedBlueprintSource,
  LlmBlueprintSource,
  UserBlueprintSource,
} from '../types/blueprint-source';
import { dataContractSchema, jsonValueSchema } from './data-contract.js';

/**
 * Zod mirror of {@link LlmBlueprintSource} — the engine-generated arm.
 * Both provenance fields are REQUIRED: every generation mint site has
 * them in scope, and an engine-generated artifact that cannot name its
 * engine + model is not a real state.
 */
export const llmBlueprintSourceSchema: z.ZodType<LlmBlueprintSource> = z
  .object({
    kind: z.literal('llm'),
    generator: z.string().min(1),
    model: z.string().min(1),
  })
  .strict() as z.ZodType<LlmBlueprintSource>;

/** Zod mirror of {@link UserBlueprintSource} — no engine claim exists. */
export const userBlueprintSourceSchema: z.ZodType<UserBlueprintSource> = z
  .object({ kind: z.literal('user') })
  .strict() as z.ZodType<UserBlueprintSource>;

/** Zod mirror of {@link CuratedBlueprintSource}. */
export const curatedBlueprintSourceSchema: z.ZodType<CuratedBlueprintSource> = z
  .object({ kind: z.literal('curated') })
  .strict() as z.ZodType<CuratedBlueprintSource>;

/**
 * Zod mirror of {@link BlueprintSource} — the single provenance
 * vocabulary for blueprints. Mirrors `parseBlueprintSource`'s arms;
 * `.strict()` members so stray keys surface at the wire layer rather
 * than riding through.
 */
export const blueprintSourceSchema: z.ZodType<BlueprintSource> = z.union([
  llmBlueprintSourceSchema,
  userBlueprintSourceSchema,
  curatedBlueprintSourceSchema,
]) as z.ZodType<BlueprintSource>;

/**
 * Zod mirror of {@link BlueprintVariance}. The single shared variance
 * schema: every seam that accepts a variance block (handshake draft,
 * render override, operator blueprint tools) reuses this one
 * rather than re-declaring the shape inline. `.strict()` so an unknown
 * key surfaces as a typo at the wire layer rather than being silently
 * dropped. The per-field `.describe()` strings ship as JSON-Schema
 * metadata via `tools/list`, so they stay mechanism-only and
 * vendor-neutral.
 */
export const blueprintVarianceSchema: z.ZodType<BlueprintVariance> = z
  .object({
    persona: z
      .string()
      .optional()
      .describe('Design persona, e.g. "minimalist" / "data-dense". Part of cache identity.'),
    aesthetic: z
      .string()
      .optional()
      .describe('Visual aesthetic, e.g. "calm" / "ornate". Part of cache identity.'),
    context: z
      .record(z.string(), jsonValueSchema)
      .optional()
      .describe(
        'Deliberate design-shaping signals (e.g. {situation:"sad"}) — part of cache identity. NOT for per-user runtime data; put that in propsSpec/contextSpec.',
      ),
    seedPrompt: z
      .string()
      .optional()
      .describe('Generation seed directive. Part of cache identity.'),
  })
  .strict() as z.ZodType<BlueprintVariance>;

/**
 * Zod mirror of {@link Blueprint}. Required fields are listed first;
 * `passthrough()` is intentionally NOT applied — blueprint rows are
 * a closed shape (every field is enumerated here), and stray fields
 * in persisted rows are a bug worth surfacing rather than tolerating.
 */
export const blueprintSchema: z.ZodType<Blueprint> = z
  .object({
    blueprintId: z.string().min(1),
    contractHash: z.string().min(1),
    appId: z.string().min(1),
    codeS3Url: z.string().optional(),
    codeHash: z.string().optional(),
    source: blueprintSourceSchema,
    validatorScore: z.number().min(0).max(1).optional(),
    variance: blueprintVarianceSchema,
    // `true | undefined` — store-level invariant: at most one row per
    // `(appId, contractHash)` carries the flag. `z.literal(true)` enforces
    // the "never false" half of the type.
    isOperatorDefault: z.literal(true).optional(),
    createdAt: z.string().min(1),
    createdBy: z.enum(['agent', 'operator']),
    contract: dataContractSchema,
    // Optional cached embedding vector. Written by BlueprintStore.put
    // when an EmbeddingProvider is wired; read by BlueprintSearch on
    // the embed axis. `readonly number[]` on the TS side; zod can't
    // express readonly so a plain array survives the assignability
    // check via the outer `as z.ZodType<Blueprint>` cast.
    contractEmbedding: z.array(z.number()).optional(),
  })
  .strict() as z.ZodType<Blueprint>;

/**
 * Zod mirror of the partial-weights shape on
 * {@link AppBlueprintSearchConfig.weights}. Every axis is a
 * non-negative finite number. Per-axis defaults are applied at the
 * impl layer (see `DEFAULT_BLUEPRINT_SEARCH_WEIGHTS` in
 * `@ggui-ai/mcp-server-core`) for any axis the operator omits.
 */
const partialBlueprintSearchWeightsSchema = z
  .object({
    hash: z.number().min(0).optional(),
    embed: z.number().min(0).optional(),
    struct: z.number().min(0).optional(),
    variance: z.number().min(0).optional(),
    intent: z.number().min(0).optional(),
  })
  .strict();

/**
 * Zod mirror of {@link AppBlueprintSearchConfig}. All fields optional;
 * server applies the global default for any axis the operator omits.
 */
export const appBlueprintSearchConfigSchema: z.ZodType<AppBlueprintSearchConfig> = z
  .object({
    weights: partialBlueprintSearchWeightsSchema.optional(),
    threshold: z.number().min(0).max(1).optional(),
    topK: z.number().int().min(1).optional(),
  })
  .strict() as z.ZodType<AppBlueprintSearchConfig>;
