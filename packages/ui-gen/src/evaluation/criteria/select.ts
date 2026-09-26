/**
 * The selector — ggui#1436's "dynamic" layer, deterministic and recorded: a pure function of the
 * bank and the card's context. Same context → same `criteriaSetId` → same selection, so verdicts
 * pair across arms and replay from the record. A criterion the selector excludes is absent from
 * the block (the selector's decision, its reason in `selection[].reason`); a selected criterion the
 * judge cannot read comes back `n/a` (the judge's answer). The two are different signals.
 */
import { createHash } from 'node:crypto';
import type { CriteriaContext, CriteriaSelection } from '../types-public.js';
import type { BankCriterion, CriteriaBank } from './bank.js';

/** Bump when a selection rule changes: it is hashed into every `criteriaSetId`. */
export const CRITERIA_SELECTOR_VERSION = 'selector@1';

/** The context as one string, keys sorted at every level — what the id hashes and what the record stores. */
export function canonicalCriteriaContext(ctx: CriteriaContext): string {
  const sortKeys = (value: unknown): unknown =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, sortKeys(v)]),
        )
      : value;
  return JSON.stringify(sortKeys(ctx));
}

/** sha256(bank version | selector version | canonical context), 16 hex — a label at this scale, not a security digest. */
export function criteriaSetIdFor(bankVersion: string, ctx: CriteriaContext): string {
  return createHash('sha256')
    .update(`${bankVersion}|${CRITERIA_SELECTOR_VERSION}|${canonicalCriteriaContext(ctx)}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/** The conditions of `appliesWhen` that hold for this context, or `null` when one fails. */
function matchedConditions(c: BankCriterion, ctx: CriteriaContext): string[] | null {
  const w = c.appliesWhen;
  if (w === undefined) return [];
  const matched: string[] = [];
  if (w.canvases !== undefined) {
    if (!w.canvases.includes(ctx.canvas)) return null;
    matched.push(`canvas=${ctx.canvas}`);
  }
  if (w.kinds !== undefined) {
    if (ctx.kind === undefined || !w.kinds.includes(ctx.kind)) return null;
    matched.push(`kind=${ctx.kind}`);
  }
  if (w.hasActions !== undefined) {
    if (w.hasActions !== ctx.hasActions) return null;
    matched.push(`hasActions=${String(ctx.hasActions)}`);
  }
  if (w.chroma !== undefined) {
    if (w.chroma !== ctx.chroma) return null;
    matched.push(`chroma=${ctx.chroma}`);
  }
  if (w.shells !== undefined) {
    if (!w.shells.includes(ctx.shell)) return null;
    matched.push(`shell=${ctx.shell}`);
  }
  return matched;
}

export interface CriteriaSelectionResult {
  readonly criteriaSetId: string;
  readonly selection: CriteriaSelection[];
}

/**
 * Select the bank's criteria for one card. The bank-level `applies` gate is read first (canvases
 * always; kind only when the caller named one — a caller without a kind is not gated by kind);
 * then each criterion's `appliesWhen`. Static criteria carry `source: 'static'`.
 */
export function selectCriteria(bank: CriteriaBank, ctx: CriteriaContext): CriteriaSelectionResult {
  const criteriaSetId = criteriaSetIdFor(bank.version, ctx);
  const applies = bank.applies;
  if (applies?.canvases !== undefined && !applies.canvases.includes(ctx.canvas)) return { criteriaSetId, selection: [] };
  if (applies?.kind !== undefined && ctx.kind !== undefined && !applies.kind.includes(ctx.kind)) return { criteriaSetId, selection: [] };
  const selection: CriteriaSelection[] = [];
  for (const c of bank.criteria) {
    const matched = matchedConditions(c, ctx);
    if (matched === null) continue;
    selection.push(
      c.appliesWhen === undefined
        ? { id: c.id, source: 'static', reason: c.scope !== undefined ? `static (scope ${c.scope})` : 'static' }
        : { id: c.id, source: 'context', reason: `context: ${matched.join(', ')}` },
    );
  }
  return { criteriaSetId, selection };
}
