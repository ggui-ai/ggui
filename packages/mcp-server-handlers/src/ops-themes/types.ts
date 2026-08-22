/**
 * ops-themes — runtime theme registration tools (ggui#598-C).
 *
 * Dependency posture: EVERYTHING injected. This package never imports
 * the design package — the composer supplies the coverage validator,
 * the consumed-token manifest, and the static preset-id list; the
 * store arrives behind the frozen `ThemeStore` port. The handlers own
 * orchestration + the refusal taxonomy, nothing else.
 *
 * Refusal taxonomy (one named class per wall — an operator must never
 * guess which wall they hit):
 *   - `theme_coverage` — the document fails coverage conformance; the
 *     uncovered token lists ride verbatim.
 *   - `theme_identity` — the id fails the frozen grammar, or collides
 *     with a statically-compiled theme id.
 *   - `theme_quota` — a deployment-policy seam refused the write (the
 *     store decorator names its own limit in the message).
 * Storage-integrity failures are deliberately NOT mapped: they bubble
 * untouched as server faults.
 */
import type { ThemeCoverageResultLike } from './register-theme.js';

/**
 * Structural seam for the registration gate — shaped after the design
 * package's `validateThemeCoverage` without importing it. The composer
 * binds the real validator; tests bind stubs.
 */
export type ThemeCoverageValidator = (
  docs: { readonly light: Record<string, unknown>; readonly dark: Record<string, unknown> },
  manifestTokens: readonly string[],
) => ThemeCoverageResultLike;

export class ThemeCoverageError extends Error {
  readonly code = 'theme_coverage' as const;
  constructor(
    readonly uncovered: {
      readonly light: readonly string[];
      readonly dark: readonly string[];
    },
  ) {
    super(
      `theme_coverage: the registration document does not cover the consumed-token manifest — ` +
        `uncovered light: [${uncovered.light.join(', ')}], dark: [${uncovered.dark.join(', ')}]. ` +
        `Emit each listed token or claim it via an explicit $extensions["ai.ggui.coverage"].inherit pattern.`,
    );
    this.name = 'ThemeCoverageError';
  }
}

export class ThemeIdentityError extends Error {
  readonly code = 'theme_identity' as const;
  constructor(
    readonly reason: 'grammar' | 'collision',
    themeId: string,
  ) {
    super(
      reason === 'grammar'
        ? `theme_identity: ${JSON.stringify(themeId)} fails the theme-id grammar — lowercase kebab, alphanumeric-bounded, 3-64 chars`
        : `theme_identity: ${JSON.stringify(themeId)} collides with a built-in theme id — pick a distinct id`,
    );
    this.name = 'ThemeIdentityError';
  }
}

export class ThemeDocumentError extends Error {
  readonly code = 'theme_document' as const;
  constructor(underlying: string) {
    super(
      `theme_document: the registration does not parse as a DTCG theme document — ` +
        `fix the document shape and re-submit. Underlying: ${underlying}`,
    );
    this.name = 'ThemeDocumentError';
  }
}

export class ThemeQuotaError extends Error {
  readonly code = 'theme_quota' as const;
  constructor(detail: string) {
    super(`theme_quota: ${detail}`);
    this.name = 'ThemeQuotaError';
  }
}

/**
 * Map a store-thrown deployment-policy refusal onto the wire taxonomy
 * WITHOUT importing the deployment's class: the policy seam is
 * name-structural (any store decorator refusing a write names itself
 * `ThemeQuotaExceededError`). Everything else rethrows untouched —
 * integrity faults must never be dressed as user errors.
 */
export function mapStorePutError(err: unknown): never {
  if (err instanceof Error && err.name === 'ThemeQuotaExceededError') {
    throw new ThemeQuotaError(err.message);
  }
  throw err;
}
