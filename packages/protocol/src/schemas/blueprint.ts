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
  BlueprintSearchWeights,
  BlueprintVariance,
} from '../types/blueprint';
import { dataContractSchema, jsonValueSchema } from './data-contract.js';

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
    generator: z.string().min(1),
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
 * Zod mirror of {@link BlueprintSearchWeights}. Every axis is a
 * non-negative finite number. Per-axis defaults are applied at the
 * impl layer (see `DEFAULT_BLUEPRINT_SEARCH_WEIGHTS` in
 * `@ggui-ai/mcp-server-core`); this schema only validates the shape
 * an operator passes through `App.blueprintSearchConfig.weights`
 * when the operator provides EVERY axis.
 */
export const blueprintSearchWeightsSchema: z.ZodType<BlueprintSearchWeights> = z
  .object({
    hash: z.number().min(0),
    embed: z.number().min(0),
    struct: z.number().min(0),
    variance: z.number().min(0),
    intent: z.number().min(0),
  })
  .strict() as z.ZodType<BlueprintSearchWeights>;

/**
 * Zod mirror of the partial-weights shape on
 * {@link AppBlueprintSearchConfig.weights}. Built directly rather
 * than as `.partial()` on `blueprintSearchWeightsSchema` because
 * that schema is typed `z.ZodType<...>` for cross-zod-version
 * compatibility — `.partial()` only exists on `z.ZodObject`.
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
