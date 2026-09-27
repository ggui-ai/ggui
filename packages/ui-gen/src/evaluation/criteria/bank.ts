/**
 * The visual criteria bank — ggui#1436 (step 1 of the founder's visual-assessment steer).
 *
 * The bank is DATA, never code (#1437 authors it; #1060's bar-and-judge policy): a versioned
 * list of criteria the judge or an instrument answers off the frame. This module is the ONE
 * loader: a malformed bank refuses at launch with the offending path named, never mid-run.
 * Additive fields on a bank entry are kept by the parser (N−1 for data: tomorrow's field does
 * not break today's loader); the fields read here are the contract.
 */
import { z } from 'zod';

/** `family.property[.facet]` — `finish.colour.field`, `floor.fit`. */
const CRITERION_ID = /^[a-z][a-z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/;

/**
 * When a bank criterion applies to a card — the "dynamic" layer as recorded applicability:
 * every condition named must hold; a criterion without `appliesWhen` is static.
 */
export const criteriaAppliesWhenSchema = z.object({
  kinds: z.array(z.string().min(1)).optional(),
  canvases: z.array(z.string().min(1)).optional(),
  hasActions: z.boolean().optional(),
  chroma: z.enum(['achromatic', 'chromatic']).optional(),
  shells: z.array(z.string().min(1)).optional(),
});

export const bankCriterionSchema = z.object({
  id: z.string().regex(CRITERION_ID, 'a criterion id is family.property[.facet], lower-case family'),
  /** The standard's property number (1–5) or a name; informational — `null` where the author left it unset. */
  property: z.union([z.number().int(), z.string()]).nullable().optional(),
  severity: z.enum(['must', 'should']),
  /** Who may answer: the judge off the frame, an instrument the capture runs, or a human reader. */
  checker: z.enum(['instrument', 'judge', 'human']),
  /** The author's scope word (`static` or a binding key); carried into the record, not interpreted by the v1 selector. */
  scope: z.string().optional(),
  /** The question, answerable yes/no from the frame. */
  text: z.string().min(1),
  /** The evidence rule: what the one-sentence evidence must name (a region or element). */
  evidence: z.string().min(1),
  /** The templated fix line a feedback channel may consume later; never read in v1. */
  fix: z.string().optional(),
  appliesWhen: criteriaAppliesWhenSchema.optional(),
});

export const criteriaBankSchema = z
  .object({
    version: z.string().min(1),
    applies: z
      .object({
        kind: z.array(z.string().min(1)).optional(),
        canvases: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    criteria: z.array(bankCriterionSchema).min(1),
  })
  .superRefine((bank, ctx) => {
    const seen = new Set<string>();
    bank.criteria.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: ['criteria', i, 'id'], message: `duplicate criterion id ${c.id}` });
      seen.add(c.id);
    });
  });

export type CriteriaBank = z.infer<typeof criteriaBankSchema>;
export type BankCriterion = z.infer<typeof bankCriterionSchema>;
export type CriteriaAppliesWhen = z.infer<typeof criteriaAppliesWhenSchema>;

/** The one door for bank data: refuses loudly, naming the path, before anything is judged. */
export function parseCriteriaBank(raw: unknown): CriteriaBank {
  const parsed = criteriaBankSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`criteria bank invalid — ${issues}`);
  }
  return parsed.data;
}
