/**
 * Theme-binding resolution — THE one normative total order for the
 * `ai.ggui/render` slice's `themeId` / `themeMode` facts, and the two
 * projections of it that run on either side of the wire (ggui#598
 * leg 4; one-projection doctrine per MCP Apps Compliance).
 *
 * ## The normative total order
 *
 * ```
 * themeMode:  consolePick  >  staticConfig  >  sessionSidecar  >  hostAnnounced
 * themeId:    consolePick  >  renderOverride  >  staticConfig  >  sidecarName
 * ```
 *
 * - `consolePick`    — the live operator pick (console theme provider).
 * - `renderOverride` — the agent's per-render `ggui_render({ themeId })`.
 * - `staticConfig`   — the app's static `ggui.json#theme` deps.
 * - `sessionSidecar` — the per-app `App.theme` sidecar snapshotted at
 *   render-commit: its `mode` (for `themeMode`) / its `name` (for
 *   `themeId`, the registered-theme base-ladder binding).
 * - `hostAnnounced`  — the embedding host's `hostContext.theme`
 *   (mode only; hosts announce no theme id).
 *
 * An unresolved fact is `undefined` — NEVER defaulted to `'light'`.
 * Absence is load-bearing: it is the signal that lets the next layer
 * down (ultimately the host) fill the fact (ggui#551).
 *
 * ## The two projections and the composition law
 *
 * The server cannot see `hostAnnounced`; the client cannot see the
 * server-only layers except through the stamp. So the order ships as
 * two projections:
 *
 * - {@link stampThemeMode} / {@link stampThemeId} — the SERVER
 *   projection: folds the server-visible layers into the stamped
 *   top-level slice field.
 * - {@link effectiveThemeMode} / {@link effectiveThemeId} — the
 *   CLIENT projection: stamped field first, then the layers the client
 *   can see directly.
 *
 * **Composition law (pinned by the test suite for every input
 * combination):** `effective(stamp(server-layers), client-layers)`
 * MUST equal the normative total order applied to all layers at once.
 * The law is what makes cross-side precedence drift structurally
 * impossible — before this module the two sides ranked the sidecar at
 * different local positions and coherence silently depended on every
 * transport threading every layer (the ggui#595 RCA's "two resolvers,
 * two ranks" finding).
 *
 * The client's direct `sessionSidecar` leg is NOT redundant with the
 * stamp: a transport that fails to thread the sidecar server-side
 * (e.g. an envelope minted outside the render path) still resolves the
 * sidecar at the correct rank client-side, because the law holds
 * per-projection, not per-thread.
 *
 * Pure functions, no I/O — safe for both the node server and the
 * browser runtime bundle.
 */

/** A resolved color-scheme opinion. Absent = no opinion (never 'light'). */
export type ThemeModeOpinion = 'light' | 'dark';

/** Server-visible `themeMode` layers, highest rank first. */
export interface ThemeModeStampSources {
  /** Live operator pick (console theme provider) — highest rank. */
  readonly consolePick?: ThemeModeOpinion | undefined;
  /** Static `ggui.json#theme` deps. */
  readonly staticConfig?: ThemeModeOpinion | undefined;
  /** The session theme sidecar's own `mode` — lowest server rank. */
  readonly sessionSidecar?: ThemeModeOpinion | undefined;
}

/** Client-visible `themeMode` layers, highest rank first. */
export interface ThemeModeEffectiveSources {
  /** The slice's stamped top-level `themeMode` (the server projection's output). */
  readonly stamped?: ThemeModeOpinion | undefined;
  /** The slice theme OBJECT's own `mode` (the sidecar, read directly). */
  readonly sessionSidecar?: ThemeModeOpinion | undefined;
  /** The embedding host's `hostContext.theme` announce — final fallback. */
  readonly hostAnnounced?: ThemeModeOpinion | undefined;
}

/** Server projection of the `themeMode` total order → the stamped field. */
export function stampThemeMode(
  s: ThemeModeStampSources,
): ThemeModeOpinion | undefined {
  return s.consolePick ?? s.staticConfig ?? s.sessionSidecar;
}

/** Client projection of the `themeMode` total order → the effective mode. */
export function effectiveThemeMode(
  s: ThemeModeEffectiveSources,
): ThemeModeOpinion | undefined {
  return s.stamped ?? s.sessionSidecar ?? s.hostAnnounced;
}

/** Server-visible `themeId` layers, highest rank first. */
export interface ThemeIdStampSources {
  /** Live operator pick (console theme provider) — highest rank. */
  readonly consolePick?: string | undefined;
  /** The agent's per-render `ggui_render({ themeId })` override. */
  readonly renderOverride?: string | undefined;
  /** Static `ggui.json#theme` deps. */
  readonly staticConfig?: string | undefined;
}

/** Client-visible `themeId` layers, highest rank first. */
export interface ThemeIdEffectiveSources {
  /** The slice's stamped top-level `themeId`. */
  readonly stamped?: string | undefined;
  /**
   * The slice theme OBJECT's `name` — the registered-theme base-ladder
   * binding (ggui#589 ask 3): an unregistered name is harmless by
   * construction (renderer falls back to the default ladder).
   */
  readonly sidecarName?: string | undefined;
}

/** Server projection of the `themeId` total order → the stamped field. */
export function stampThemeId(s: ThemeIdStampSources): string | undefined {
  return s.consolePick ?? s.renderOverride ?? s.staticConfig;
}

/** Client projection of the `themeId` total order → the effective id. */
export function effectiveThemeId(s: ThemeIdEffectiveSources): string | undefined {
  return s.stamped ?? s.sidecarName;
}
