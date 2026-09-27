/**
 * The selector — ggui#1436's "dynamic" layer, deterministic and recorded: a pure function of the
 * bank and the card's context. Same context → same `criteriaSetId` → same selection, so verdicts
 * pair across arms and replay from the record. A row the selector excludes is absent from the
 * block (the selector's decision); a selected row the judge cannot read comes back `n/a` (the
 * judge's answer). The two are different signals.
 */
import { createHash } from 'node:crypto';
import type { CriteriaContext, CriteriaSelection } from '../types-public.js';
import { bankRows, type BankRow, type CriteriaBank } from './bank.js';

/** Bump when a selection rule changes: it is hashed into every `criteriaSetId`. */
export const CRITERIA_SELECTOR_VERSION = 'selector@2';

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

/** The scope keys that hold for this context, or `null` when one fails; `[]` for an empty scope (static). */
function matchedScope(row: BankRow, ctx: CriteriaContext): string[] | null {
  const s = row.scope;
  const matched: string[] = [];
  if (s.kind !== undefined) {
    if (ctx.kind !== s.kind) return null;
    matched.push(`kind=${s.kind}`);
  }
  if (s.canvas !== undefined) {
    if (ctx.canvas !== s.canvas) return null;
    matched.push(`canvas=${s.canvas}`);
  }
  if (s.preset !== undefined) {
    if (ctx.preset !== s.preset) return null;
    matched.push(`preset=${s.preset}`);
  }
  return matched;
}

export interface CriteriaSelectionResult {
  readonly criteriaSetId: string;
  readonly selection: CriteriaSelection[];
}

/**
 * Select the bank's rows for one card. The bank-level `applies` gate is read first (canvases always;
 * kind only when the caller named one and the bank names kinds other than `*`); then each row's
 * `scope`. An empty scope is `static`; a matched scope is `context` with the keys that matched.
 */
export function selectCriteria(bank: CriteriaBank, ctx: CriteriaContext): CriteriaSelectionResult {
  const criteriaSetId = criteriaSetIdFor(bank.version, ctx);
  const applies = bank.applies;
  if (applies?.canvases !== undefined && !applies.canvases.includes(ctx.canvas)) return { criteriaSetId, selection: [] };
  if (applies?.kind !== undefined && ctx.kind !== undefined && !applies.kind.includes('*') && !applies.kind.includes(ctx.kind)) {
    return { criteriaSetId, selection: [] };
  }
  const selection: CriteriaSelection[] = [];
  for (const row of bankRows(bank)) {
    const matched = matchedScope(row, ctx);
    if (matched === null) continue;
    selection.push(matched.length === 0 ? { id: row.id, source: 'static', reason: 'static' } : { id: row.id, source: 'context', reason: `context: ${matched.join(', ')}` });
  }
  return { criteriaSetId, selection };
}
