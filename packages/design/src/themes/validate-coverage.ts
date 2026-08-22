/**
 * Coverage-conformance validator (ggui#598 slice 2) — THE registration
 * gate for the runtime theme-registration arc (#598-C).
 *
 * A theme registration `{light, dark}` MUST cover the consumed-token
 * manifest, or carry EXPLICIT group-inherit declarations — silence is
 * no longer a legal way to inherit platform defaults (the round-3
 * mechanism: sparse coverage silently painting another brand's
 * values). The validator is pure and grounded in the PARSER: coverage
 * is judged on the variable names `parseTheme` actually emits for the
 * document, never on the document's key structure — a token the parser
 * would not emit is not covered, whatever the JSON says.
 *
 * ## Inherit vocabulary (DTCG-sanctioned)
 *
 * `$extensions['ai.ggui.coverage'].inherit: string[]` on either mode's
 * document — prefix-glob patterns over EMITTED variable names
 * (`'--ggui-spacing-*'`, or the full wildcard `'--ggui-*'`). Matched
 * tokens count as covered AND are reported in `inheritMatched`: the
 * grade shows what a theme chose to inherit; nothing inherits quietly.
 *
 * ## The non-definable exclusion (receipted, pinned by test)
 *
 * A small set of CONSUMED tokens cannot be defined by any registration
 * because their values do not come from the theme parser at all. Each
 * entry carries its receipt; the test pins that every entry is in the
 * manifest and none is emitted by the default pair — if the platform
 * ever makes one definable, the pin breaks and the list shrinks.
 */
import type { DtcgTheme } from './types.js';
import { parseTheme } from './parser.js';

/**
 * Consumed tokens no theme registration can define — excluded from the
 * coverage obligation, each with its receipt:
 *
 * - `--ggui-color-primary` (flat): settable only by the per-app
 *   overlay / host-palette bridge; `color.primary` is a ramp Record,
 *   so no parser path emits the flat name.
 * - `--ggui-color-surface-gradient`: a derived `color-mix()` formula
 *   composed in `css-tokens.ts` from surface + primary-500 — computed,
 *   never registered.
 * - `--ggui-color-surface-subtle` / `--ggui-color-surface-sunken`:
 *   consumption-site fallback-only names (Markdown / preview surfaces);
 *   no emission slot exists.
 * - `--ggui-flash-color`: an element-level opt-in variable set by
 *   component code at runtime (`tokens/motion.ts`), not a ladder token.
 * - `--ggui-radius-sm` / `--ggui-radius-md`: wrong-prefix legacy names
 *   (the emitted family is `--ggui-shape-radius-*`); their consumers
 *   resolve to literal defaults pending a consumer-side rename.
 */
export const NON_THEME_DEFINABLE_TOKENS: readonly string[] = [
  '--ggui-color-primary',
  '--ggui-color-surface-gradient',
  '--ggui-color-surface-subtle',
  '--ggui-color-surface-sunken',
  '--ggui-flash-color',
  '--ggui-radius-sm',
  '--ggui-radius-md',
];

/** One registration under validation — both modes, per the C ruling. */
export interface ThemeRegistrationDocs {
  readonly light: DtcgTheme;
  readonly dark: DtcgTheme;
}

/**
 * The validator's INPUT shape — deliberately wider than
 * {@link ThemeRegistrationDocs}: registration documents arrive
 * UNVALIDATED (a wire payload), and this function's documented
 * contract is may-throw-on-bad-shape — `parseTheme` is the validating
 * narrower. Callers holding loose `Record<string, unknown>` docs pass
 * them directly; a non-DtcgTheme document throws here, and the
 * registration seam maps that to its document-shape refusal.
 */
export interface ThemeRegistrationDocsInput {
  readonly light: DtcgTheme | Record<string, unknown>;
  readonly dark: DtcgTheme | Record<string, unknown>;
}

export interface ThemeCoverageResult {
  /** True iff both modes cover (emit or explicitly inherit) every obligated token. */
  readonly covered: boolean;
  /** Obligated tokens NOT emitted and NOT inherit-matched, per mode, sorted. */
  readonly uncovered: { readonly light: readonly string[]; readonly dark: readonly string[] };
  /** Obligated tokens satisfied via explicit inherit patterns (union over modes), sorted. */
  readonly inheritMatched: readonly string[];
  /** Manifest tokens excluded from the obligation ({@link NON_THEME_DEFINABLE_TOKENS} ∩ manifest), sorted. */
  readonly excluded: readonly string[];
}

const EMITTED_VAR_RE = /(--ggui-[a-zA-Z0-9-]+)\s*:/g;

/** The variable names the parser ACTUALLY emits for a document. */
function emittedNames(doc: DtcgTheme | Record<string, unknown>): ReadonlySet<string> {
  // Union → member narrowing at the validating boundary: parseTheme
  // rejects anything that is not a DtcgTheme (the may-throw contract).
  const parsed = parseTheme('coverage-probe', doc as DtcgTheme);
  const names = new Set<string>();
  for (const match of parsed.cssVariables.matchAll(EMITTED_VAR_RE)) {
    names.add(match[1]!);
  }
  return names;
}

function inheritPatterns(docs: ThemeRegistrationDocsInput): readonly string[] {
  // `$extensions` values are unknown by DTCG design (vendor
  // namespaces); narrow our own namespace structurally.
  const collect = (doc: DtcgTheme | Record<string, unknown>): readonly string[] => {
    // Union → member narrowing (same validating-boundary rule as
    // emittedNames): `$extensions` is read structurally either way and
    // every downstream access is typeof-guarded.
    const ext = (doc as DtcgTheme).$extensions?.['ai.ggui.coverage'];
    if (typeof ext !== 'object' || ext === null) return [];
    const inherit = (ext as { inherit?: unknown }).inherit;
    return Array.isArray(inherit)
      ? inherit.filter((p): p is string => typeof p === 'string')
      : [];
  };
  return [...new Set([...collect(docs.light), ...collect(docs.dark)])];
}

/** Prefix-glob match: pattern is a literal, or `prefix*` matching any suffix. */
function matchesPattern(name: string, pattern: string): boolean {
  return pattern.endsWith('*')
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern;
}

/**
 * Validate one registration against the consumed-token manifest — the
 * #598-C registration gate. Pure; the caller supplies the manifest
 * (`consumed-tokens.manifest.json`'s `tokens`).
 */
export function validateThemeCoverage(
  docs: ThemeRegistrationDocsInput,
  manifestTokens: readonly string[],
): ThemeCoverageResult {
  const excluded = manifestTokens
    .filter((t) => NON_THEME_DEFINABLE_TOKENS.includes(t))
    .sort();
  const obligated = manifestTokens.filter((t) => !excluded.includes(t));
  const patterns = inheritPatterns(docs);

  const inheritMatchedSet = new Set<string>();
  const uncoveredByMode = { light: [] as string[], dark: [] as string[] };
  for (const mode of ['light', 'dark'] as const) {
    const emitted = emittedNames(docs[mode]);
    for (const token of obligated) {
      if (emitted.has(token)) continue;
      if (patterns.some((p) => matchesPattern(token, p))) {
        inheritMatchedSet.add(token);
        continue;
      }
      uncoveredByMode[mode].push(token);
    }
    uncoveredByMode[mode].sort();
  }

  return {
    covered:
      uncoveredByMode.light.length === 0 && uncoveredByMode.dark.length === 0,
    uncovered: { light: uncoveredByMode.light, dark: uncoveredByMode.dark },
    inheritMatched: [...inheritMatchedSet].sort(),
    excluded,
  };
}
