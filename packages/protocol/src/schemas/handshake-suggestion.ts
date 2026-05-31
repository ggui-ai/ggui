/**
 * Zod mirrors for the handshake-suggestion shapes
 * (`packages/protocol/src/types/handshake-suggestion.ts`).
 *
 * Structural-mirror discipline matches `data-contract.ts` /
 * `blueprint.ts`: TS interfaces in `../types/handshake-suggestion.ts`
 * are the declared source of truth; the schemas here are typed
 * `z.ZodType<T>` so any drift fails compile.
 */
import { z } from 'zod';
import type {
  BlueprintDraft,
  BlueprintMeta,
  HandshakeSuggestion,
  JsonPatch,
  JsonPatchOp,
  PushDecision,
  SuggestionAmendments,
  SuggestionFinding,
  SuggestionOrigin,
} from '../types/handshake-suggestion.js';
import { dataContractSchema, jsonValueSchema } from './data-contract.js';
import { blueprintVarianceSchema } from './blueprint.js';

/** Three-mode routing enum on {@link HandshakeSuggestion.origin}. */
export const suggestionOriginSchema: z.ZodType<SuggestionOrigin> = z.enum([
  'cache',
  'agent',
  'synth',
]);

/** Single JSON-Patch op (RFC 6902 subset — add/remove/replace). */
export const jsonPatchOpSchema: z.ZodType<JsonPatchOp> = z.union([
  z.object({
    op: z.literal('add'),
    path: z.string(),
    value: jsonValueSchema,
  }).strict(),
  z.object({
    op: z.literal('remove'),
    path: z.string(),
  }).strict(),
  z.object({
    op: z.literal('replace'),
    path: z.string(),
    value: jsonValueSchema,
  }).strict(),
]) as z.ZodType<JsonPatchOp>;

/** `JsonPatch` — array of ops; subset support per the doc. */
export const jsonPatchSchema: z.ZodType<JsonPatch> = z.array(jsonPatchOpSchema) as z.ZodType<JsonPatch>;

/**
 * Inner zod-object form of {@link blueprintDraftSchema}. Exposed so
 * the sync-check script can reflect `.shape` to enumerate fields;
 * normal consumers should prefer {@link blueprintDraftSchema} (typed
 * `z.ZodType<BlueprintDraft>`).
 */
export const blueprintDraftObjectSchema = z
  .object({
    contract: dataContractSchema,
    variance: z
      .object({
        persona: z.string().optional(),
        aesthetic: z.string().optional(),
        context: z.record(z.string(), jsonValueSchema).optional(),
        seedPrompt: z.string().optional(),
      })
      .strict()
      .optional(),
    generator: z.string().optional(),
  })
  .strict();

/** `BlueprintDraft` — input shape on handshake + override push. */
export const blueprintDraftSchema: z.ZodType<BlueprintDraft> = blueprintDraftObjectSchema as z.ZodType<BlueprintDraft>;

/** `BlueprintMeta` — projected onto the handshake response. */
export const blueprintMetaSchema: z.ZodType<BlueprintMeta> = z
  .object({
    blueprintId: z.string().min(1).optional(),
    contractHash: z.string().min(1),
    codeHash: z.string().optional(),
    generator: z.string().min(1),
    variance: blueprintVarianceSchema,
    selectedReason: z.string().optional(),
  })
  .strict() as z.ZodType<BlueprintMeta>;

/** `SuggestionFinding` — validator finding surfaced on the suggestion. */
export const suggestionFindingSchema: z.ZodType<SuggestionFinding> = z
  .object({
    code: z.string().min(1),
    severity: z.enum(['error', 'warn']),
    path: z.string(),
    message: z.string(),
  })
  .strict() as z.ZodType<SuggestionFinding>;

/** Synth amendment — JSON-Patch diff + reasoning. */
export const suggestionAmendmentsSchema: z.ZodType<SuggestionAmendments> = z
  .object({
    contractDiff: jsonPatchSchema,
    reasoning: z.string(),
  })
  .strict() as z.ZodType<SuggestionAmendments>;

/** The full handshake suggestion — produced in step-2 of the handshake. */
export const handshakeSuggestionSchema: z.ZodType<HandshakeSuggestion> = z
  .object({
    origin: suggestionOriginSchema,
    rationale: z.string(),
    blueprintMeta: blueprintMetaSchema,
    amendments: suggestionAmendmentsSchema.optional(),
    validationFindings: z.array(suggestionFindingSchema).optional(),
  })
  .strict() as z.ZodType<HandshakeSuggestion>;

/** Push decision discriminator — accept vs override. */
export const pushDecisionSchema: z.ZodType<PushDecision> = z.union([
  z.object({ kind: z.literal('accept') }).strict(),
  z
    .object({
      kind: z.literal('override'),
      blueprintDraft: blueprintDraftSchema,
    })
    .strict(),
]) as z.ZodType<PushDecision>;
