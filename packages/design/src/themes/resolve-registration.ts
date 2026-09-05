/**
 * resolveRegistrationVariables — the delivery resolver (ggui#598-C,
 * design leg of the server seam): a validated registration document pair
 * in, emit-ready per-mode CSS variable maps out.
 *
 * Parser-grounded: the maps are extracted from `parseTheme`'s own
 * emission, so a DELIVERED ladder (wire `theme.base`) can never drift
 * from what the same document would paint if it were compiled in —
 * one derivation, two transports. A `themeBaseProvider` typically memoizes
 * this in a documentHash-keyed LRU; nothing derived is ever persisted (the
 * store holds document bytes only — recompute-from-bytes is the rule).
 */
import type { DtcgTheme } from './types.js';
import { parseTheme } from './parser.js';
import type { ThemeRegistrationDocs } from './validate-coverage.js';

/**
 * Emit-ready variable maps, one per mode — plus the two non-variable
 * carriages (ggui#613 residual 2): per-mode `@keyframes` blocks (a
 * mode key is absent when its document declares none) and the
 * `frameless` flag (the OR of both modes' `$metadata.frameless` —
 * suppression is the safe direction: a frameless declaration on
 * either mode means the host owns the silhouette).
 */
export interface ResolvedRegistrationVariables {
  readonly light: Readonly<Record<string, string>>;
  readonly dark: Readonly<Record<string, string>>;
  readonly keyframes: { readonly light?: string; readonly dark?: string };
  readonly frameless: boolean;
}

const DECLARATION_RE = /(--ggui-[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;

interface ExtractedMode {
  readonly variables: Record<string, string>;
  readonly keyframes: string;
  readonly frameless: boolean;
}

function extract(doc: DtcgTheme): ExtractedMode {
  const parsed = parseTheme('registration-delivery', doc);
  const variables: Record<string, string> = {};
  for (const match of parsed.cssVariables.matchAll(DECLARATION_RE)) {
    variables[match[1]!] = match[2]!.trim();
  }
  return {
    variables,
    keyframes: parsed.cssKeyframes,
    frameless: parsed.metadata?.frameless === true,
  };
}

/**
 * Resolve a registration to its emit-ready variable maps. Pure and
 * deterministic — safe to memoize on the registration's documentHash.
 */
export function resolveRegistrationVariables(
  docs: ThemeRegistrationDocs,
): ResolvedRegistrationVariables {
  const light = extract(docs.light);
  const dark = extract(docs.dark);
  return {
    light: light.variables,
    dark: dark.variables,
    keyframes: {
      ...(light.keyframes !== '' ? { light: light.keyframes } : {}),
      ...(dark.keyframes !== '' ? { dark: dark.keyframes } : {}),
    },
    frameless: light.frameless || dark.frameless,
  };
}
