/**
 * The visual criteria bank — ggui#1436 (step 1 of the founder's visual-assessment steer).
 *
 * The bank is DATA, never code (#1437 authors it; #1060's bar-and-judge policy): a versioned set of
 * criteria the judge, an instrument or a person answers off the frame, split as the founder ruled —
 * `severity` is importance, `evaluation` the method, `status` the method's readiness (the only source
 * of an `n/a`), `scope` where a row applies ({} = every card; {kind} / {canvas} / {preset} = one). The
 * general rows are `criteria`; a preset's own expression is a `recipes` row carrying `scope.preset`.
 * This module is the ONE loader: a malformed bank refuses at launch with the offending path named,
 * never mid-run. Fields the loader does not read (`examples`, `fields`, `groups`, `seed`) are page
 * matter and are dropped here; an additive field tomorrow does not break today's loader.
 */
import { z } from 'zod';

/** `family.property[.facet]` — `read.contrast`, `hello.field`. */
const CRITERION_ID = /^[a-z][a-z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/;

/** Where a row applies; every key named must match the card's context. */
export const criteriaScopeSchema = z.object({
  kind: z.string().min(1).optional(),
  canvas: z.string().min(1).optional(),
  preset: z.string().min(1).optional(),
});

export const bankRowSchema = z.object({
  id: z.string().regex(CRITERION_ID, 'a criterion id is family.property[.facet], lower-case family'),
  group: z.string().optional(),
  scope: criteriaScopeSchema.default({}),
  /** Importance, independent of whether anything automated checks it yet. */
  severity: z.enum(['must', 'should']),
  /** The method that produces the verdict. */
  evaluation: z.enum(['instrument', 'judge', 'human']),
  /** The method's readiness — the only source of an `n/a`. */
  status: z.enum(['live', 'reference', 'planned', 'manual']),
  /** The question, answerable yes/no from the frame. */
  text: z.string().min(1),
  /** The evidence rule: what the one-sentence evidence must name (a region or element). */
  evidence: z.string().min(1),
  /** The templated fix line a feedback channel may consume later; never read in v1. */
  fix: z.string().optional(),
});

export const criteriaBankSchema = z
  .object({
    version: z.string().min(1),
    applies: z
      .object({
        /** `["*"]` = every kind. */
        kind: z.array(z.string().min(1)).optional(),
        canvases: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    criteria: z.array(bankRowSchema).min(1),
    recipes: z.array(bankRowSchema).optional(),
  })
  .superRefine((bank, ctx) => {
    const seen = new Set<string>();
    const check = (rows: readonly { id: string }[], key: 'criteria' | 'recipes'): void => {
      rows.forEach((c, i) => {
        if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: [key, i, 'id'], message: `duplicate criterion id ${c.id}` });
        seen.add(c.id);
      });
    };
    check(bank.criteria, 'criteria');
    check(bank.recipes ?? [], 'recipes');
  });

export type CriteriaBank = z.infer<typeof criteriaBankSchema>;
export type BankRow = z.infer<typeof bankRowSchema>;
export type CriteriaScope = z.infer<typeof criteriaScopeSchema>;

/** Every row of the bank — the general criteria, then the recipes. */
export function bankRows(bank: CriteriaBank): readonly BankRow[] {
  return [...bank.criteria, ...(bank.recipes ?? [])];
}

/** The one door for bank data: refuses loudly, naming the path, before anything is judged. */
export function parseCriteriaBank(raw: unknown): CriteriaBank {
  const parsed = criteriaBankSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`criteria bank invalid — ${issues}`);
  }
  return parsed.data;
}
