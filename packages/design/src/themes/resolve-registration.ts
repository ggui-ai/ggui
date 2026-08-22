/**
 * resolveRegistrationVariables — the delivery resolver (ggui#598-C,
 * design leg of the pod seam): a validated registration document pair
 * in, emit-ready per-mode CSS variable maps out.
 *
 * Parser-grounded: the maps are extracted from `parseTheme`'s own
 * emission, so a DELIVERED ladder (wire `theme.base`) can never drift
 * from what the same document would paint if it were compiled in —
 * one derivation, two transports. The pod wraps this in its
 * documentHash-keyed LRU; nothing derived is ever persisted (the
 * store holds document bytes only — recompute-from-bytes is the rule).
 */
import type { DtcgTheme } from './types.js';
import { parseTheme } from './parser.js';
import type { ThemeRegistrationDocs } from './validate-coverage.js';

/** Emit-ready variable maps, one per mode. */
export interface ResolvedRegistrationVariables {
  readonly light: Readonly<Record<string, string>>;
  readonly dark: Readonly<Record<string, string>>;
}

const DECLARATION_RE = /(--ggui-[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;

function extract(doc: DtcgTheme): Record<string, string> {
  const parsed = parseTheme('registration-delivery', doc);
  const out: Record<string, string> = {};
  for (const match of parsed.cssVariables.matchAll(DECLARATION_RE)) {
    out[match[1]!] = match[2]!.trim();
  }
  return out;
}

/**
 * Resolve a registration to its emit-ready variable maps. Pure and
 * deterministic — safe to memoize on the registration's documentHash.
 */
export function resolveRegistrationVariables(
  docs: ThemeRegistrationDocs,
): ResolvedRegistrationVariables {
  return { light: extract(docs.light), dark: extract(docs.dark) };
}
