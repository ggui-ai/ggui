/**
 * DTCG (Design Tokens Community Group) Type Definitions
 *
 * Following spec: https://design-tokens.github.io/community-group/format/
 */

/**
 * Supported DTCG token type identifiers.
 *
 * Each type determines how the token `$value` is serialized to CSS.
 */
export type DTCGTokenType =
  | 'color'
  | 'dimension'
  | 'fontFamily'
  | 'fontWeight'
  | 'duration'
  | 'shadow'
  | 'typography'
  | 'transition'
  | 'number';

/**
 * A single design token following the DTCG specification.
 *
 * @typeParam T - The TypeScript type of the token's value
 * @see https://design-tokens.github.io/community-group/format/
 */
export interface DTCGToken<T = unknown> {
  $type: DTCGTokenType;
  $value: T;
  $description?: string;
}

/**
 * A group of design tokens, possibly nested. Each key maps to either
 * a concrete {@link DTCGToken} or another nested group.
 *
 * Per the DTCG spec, `$`-prefixed keys may carry string metadata
 * (`$description`, `$type`, etc.), so the index includes `string | undefined`.
 */
export interface DTCGTokenGroup {
  [key: string]: DTCGToken | DTCGTokenGroup | string | undefined;
}

/**
 * Structured value for `shadow` type tokens.
 */
export interface ShadowValue {
  offsetX: string;
  offsetY: string;
  blur: string;
  spread: string;
  color: string;
}

/**
 * Structured value for `transition` type tokens.
 */
export interface TransitionValue {
  duration: string;
  timingFunction: string;
  property?: string;
}

/**
 * Base DTCG theme definition — the shape the shipped `lightTheme` /
 * `darkTheme` literals use. Layout: `color.{primary,gray,info,success,
 * warning,error,background,surface,text}` + flat `typography` (with
 * `fontFamily`/`fontSize`/`fontWeight`/`lineHeight` sub-records) +
 * `spacing` + `radius` + `shadow` + optional `duration` / `transition` /
 * `accessibility`.
 *
 * Distinct from {@link DtcgTheme} (defined in `themes/types.ts`), which
 * is the EXTENDED layout the registry produces — adds `$name`/
 * `$description`/`$metadata` + `motion` + `canvas` + Material-style
 * semantic color roles (`onSurface`, `surfaceVariant`, `container`,
 * etc.) and groups `radius`/`shadow` under `shape.*` and font tokens
 * under `font.*`. They share the DTCG token primitive but model
 * different design systems; choose by what your data source produces.
 *
 * Extends {@link DTCGTokenGroup} so it can be traversed recursively by
 * {@link generateCssVariables} and other token walkers without type
 * laundering. The `$schema` and `$version` metadata fields are valid
 * because `DTCGTokenGroup` includes `string | undefined` in its index
 * signature (per the DTCG spec, `$`-prefixed keys carry string metadata).
 */
export interface BaseDtcgTheme extends DTCGTokenGroup {
  $schema?: string;
  $version?: string;
  color: {
    primary: Record<string, DTCGToken<string>>;
    gray: Record<string, DTCGToken<string>>;
    info: Record<string, DTCGToken<string>>;
    success: Record<string, DTCGToken<string>>;
    warning: Record<string, DTCGToken<string>>;
    error: Record<string, DTCGToken<string>>;
    background: DTCGToken<string>;
    surface: DTCGToken<string>;
    text: {
      primary: DTCGToken<string>;
      secondary: DTCGToken<string>;
      disabled: DTCGToken<string>;
    };
  };
  spacing: Record<string, DTCGToken<string>>;
  typography: {
    fontFamily: {
      sans: DTCGToken<string[]>;
      mono: DTCGToken<string[]>;
    };
    fontSize: Record<string, DTCGToken<string>>;
    fontWeight: Record<string, DTCGToken<number>>;
    lineHeight: Record<string, DTCGToken<number | string>>;
  };
  radius: Record<string, DTCGToken<string>>;
  shadow: Record<string, DTCGToken<ShadowValue>>;
  duration?: Record<string, DTCGToken<string>>;
  transition?: Record<string, DTCGToken<TransitionValue | string>>;
  zIndex?: Record<string, DTCGToken<number>>;
  accessibility?: {
    focusRing: {
      color: DTCGToken<string>;
      width: DTCGToken<string>;
      offset: DTCGToken<string>;
    };
    reducedMotion: {
      duration: DTCGToken<string>;
    };
    highContrast: {
      borderWidth: DTCGToken<string>;
      textColor: DTCGToken<string>;
      backgroundColor: DTCGToken<string>;
      linkColor: DTCGToken<string>;
    };
  };
}
