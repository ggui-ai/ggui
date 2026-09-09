/**
 * Theme loader — resolves `ggui.json#theme` into a validated
 * `LoadedTheme` at boot.
 *
 * The flow:
 *
 *   ggui.json.theme (undefined | string | { preset, mode, overrides } | { file, mode })
 *     → undefined → default light theme
 *     → string OR { preset } → registry lookup via @ggui-ai/design
 *     → { file } → readFile → JSON.parse → parseThemeDocument
 *
 * Non-throwing per the blueprint + primitive discovery precedent —
 * one malformed theme should surface as a structured issue, not an
 * exception. `ggui serve` escalates issues to a fatal exit before
 * binding a port.
 *
 * ## Both modes, projected
 *
 * Every `LoadedTheme` carries `overlays` — the `--ggui-*` variable map
 * for BOTH modes, produced by `@ggui-ai/design/themes`'
 * `deriveThemeVariables(document, mode)` (the one producer, ggui#987):
 * a preset's light document and its dark twin, or a file's single
 * document projected for each mode. Downstream consumers (the CLI's
 * deploy PATCH, the console picker) ship the projection as the app's
 * theme; nothing re-walks the token tree.
 *
 * ## Mode handling
 *
 * `mode: 'light' | 'dark'` is propagated on every `LoadedTheme`
 * variant so consumers can emit `color-scheme: dark` and pick the
 * matching variant from the registry. For the file path, `mode`
 * is metadata only — the file's tokens ARE the resolved theme,
 * not a switch.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  ThemeDocumentInvalidError,
  darkTheme,
  deriveThemeVariables,
  getRawTheme,
  lightTheme,
} from '@ggui-ai/design/themes';
import type { DtcgTheme, ThemeMode, ThemeVariableMap } from '@ggui-ai/design/themes';
import type { GguiJsonV1, ThemeConfig } from './schema.js';
import { normalizeThemeDocument, parseThemeDocument, type ThemeDocument } from './theme.js';

/**
 * Both modes' projections of a loaded theme — the `overlays` an app
 * theme carries on the wire (ggui#987 §3), produced by the ONE producer.
 */
export interface ThemeOverlays {
  readonly light: ThemeVariableMap;
  readonly dark: ThemeVariableMap;
}

/** Project a light document (and its dark twin when it has one) for both modes. */
function deriveOverlays(light: DtcgTheme, dark: DtcgTheme | undefined): ThemeOverlays {
  return {
    light: deriveThemeVariables(light, 'light'),
    dark: deriveThemeVariables(dark ?? light, 'dark'),
  };
}

/**
 * One loaded theme — discriminated on `source`. Every variant carries
 * the resolved `mode` (the default the card paints when no host
 * announces one), the producer-ready document, and both modes'
 * projections (`overlays`).
 *
 * **`document` is the producer's `DtcgTheme` on every variant**: the
 * registry's own document for `default` / `preset`, and for `file` the
 * strict-Zod `ThemeDocument` after `normalizeThemeDocument` (the open
 * `ggui.json#theme` format keeps `motion`/`accessibility`/`zIndex`
 * optional so external tools that emit only a subset still parse; the
 * normaliser fills them from the shipped default).
 *
 * Consumers narrow on `source` only for provenance. The projection
 * happens here, once, into `overlays`; downstream code reads the maps.
 */
export type LoadedTheme =
  | {
      readonly source: 'default';
      readonly mode: ThemeMode;
      readonly document: DtcgTheme;
      readonly overlays: ThemeOverlays;
    }
  | {
      readonly source: 'preset';
      /** Registry id (`'claudic'`, `'ggui'`, …). */
      readonly preset: string;
      readonly mode: ThemeMode;
      /** Flat dot-path token overrides applied on top of the preset. */
      readonly overrides?: Record<string, string>;
      readonly document: DtcgTheme;
      readonly overlays: ThemeOverlays;
    }
  | {
      readonly source: 'file';
      /** Absolute filesystem path of the loaded theme file. */
      readonly path: string;
      readonly mode: ThemeMode;
      /** The parsed file, normalised to the producer's document (see `normalizeThemeDocument`). */
      readonly document: DtcgTheme;
      readonly overlays: ThemeOverlays;
    };

/**
 * An error surfaced during theme load. Shape matches the issue
 * streams blueprint + primitive discovery produce so CLI renderers
 * can treat all three identically.
 */
export interface ThemeLoadIssue {
  /**
   * Path of the offending theme source. For file sources this is
   * the resolved absolute path; for preset sources it's the preset
   * id (so the CLI line reads `theme: claudic — not registered`
   * cleanly).
   */
  path: string;
  message: string;
  cause?: unknown;
}

/** Result of {@link loadTheme}. One of two exhaustive branches. */
export type LoadThemeResult =
  | {
      readonly ok: true;
      readonly theme: LoadedTheme;
    }
  | {
      readonly ok: false;
      readonly issue: ThemeLoadIssue;
    };

/**
 * Options accepted by {@link loadTheme}. `projectRoot` is required —
 * relative `manifest.theme.file` paths are resolved from the
 * directory containing `ggui.json` (same rule `storage.*.path` uses).
 */
export interface LoadThemeOptions {
  /** Absolute project root — the directory containing `ggui.json`. */
  projectRoot: string;
  /** Parsed `ggui.json`. Only the optional `theme` field is consumed. */
  manifest: GguiJsonV1;
}

/**
 * Load the theme declared in `ggui.json#theme`, or fall back to the
 * shipped default when the field is absent.
 *
 * Non-throwing — single-issue failure mode returned as a tagged
 * result. Throws only for programmer errors (non-absolute
 * `projectRoot`), matching the other discovery helpers.
 */
export function loadTheme(options: LoadThemeOptions): LoadThemeResult {
  const { projectRoot, manifest } = options;

  if (!isAbsolute(projectRoot)) {
    throw new Error(
      `loadTheme: projectRoot must be absolute, got ${projectRoot}`,
    );
  }

  const themeConfig = manifest.theme;

  // ── Default path (no `theme` declared) ──────────────────────────
  if (themeConfig === undefined) {
    return {
      ok: true,
      theme: {
        source: 'default',
        mode: 'light',
        document: lightTheme,
        overlays: deriveOverlays(lightTheme, darkTheme),
      },
    };
  }

  // ── String shorthand: preset id ─────────────────────────────────
  if (typeof themeConfig === 'string') {
    return loadPreset(themeConfig, 'light', undefined);
  }

  // ── File path ───────────────────────────────────────────────────
  if ('file' in themeConfig) {
    return loadFile(themeConfig.file, themeConfig.mode ?? 'light', projectRoot);
  }

  // ── Preset object ───────────────────────────────────────────────
  return loadPreset(
    themeConfig.preset,
    themeConfig.mode ?? 'light',
    themeConfig.overrides,
  );
}

/**
 * Resolve a registered preset (with optional mode + overrides) into
 * a `LoadedTheme`. Returns an issue when the preset id is
 * unregistered.
 *
 * When `overrides` is supplied, each entry is applied as a deep-set
 * onto the resolved raw `DtcgTheme` BEFORE CSS emission. Unknown
 * dot-paths are silently dropped — the console token editor mints
 * valid keys and an accidentally-stale override should not fail
 * manifest parse.
 */
function loadPreset(
  preset: string,
  mode: ThemeMode,
  overrides: Record<string, string> | undefined,
): LoadThemeResult {
  // Resolve the raw token tree first (also the registration check)
  // before layering overrides and projecting both modes.
  const raw = getRawTheme(preset, mode);
  if (!raw) {
    return {
      ok: false,
      issue: {
        path: preset,
        message:
          `Theme preset "${preset}" is not registered. ` +
          `Use one of the registered ids (e.g. "ggui", "claudic", ` +
          `"premium-zen") or switch to { file: "./..." }.`,
      },
    };
  }

  // Both modes ride the loaded theme (ggui#987 §3): the preset's light
  // document and its dark twin (a single-mode preset projects the one
  // document for both), overrides applied to each before projection.
  // Overrides clone the raw trees so the registry's cache stays clean.
  const rawLight = getRawTheme(preset, 'light') ?? raw;
  const rawDark = getRawTheme(preset, 'dark');
  const hasOverrides = overrides !== undefined && Object.keys(overrides).length > 0;
  const light = hasOverrides ? applyOverrides(rawLight, overrides) : rawLight;
  const dark =
    rawDark === undefined ? undefined : hasOverrides ? applyOverrides(rawDark, overrides) : rawDark;
  const document = mode === 'dark' ? (dark ?? light) : light;
  return {
    ok: true,
    theme: {
      source: 'preset',
      preset,
      mode,
      ...(hasOverrides ? { overrides } : {}),
      document,
      overlays: deriveOverlays(light, dark),
    },
  };
}

/**
 * Load a DTCG JSON file from a project-relative path. Existing
 * file-loading flow, refactored out of `loadTheme` so the entry
 * point stays small.
 */
function loadFile(
  filePath: string,
  mode: ThemeMode,
  projectRoot: string,
): LoadThemeResult {
  const absolutePath = isAbsolute(filePath)
    ? filePath
    : resolve(projectRoot, filePath);

  if (!existsSync(absolutePath)) {
    return {
      ok: false,
      issue: {
        path: filePath,
        message:
          `Declared theme file not found. Resolved to ${absolutePath}; ` +
          `check the path is correct relative to ggui.json.`,
      },
    };
  }

  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf-8');
  } catch (cause) {
    return {
      ok: false,
      issue: {
        path: absolutePath,
        message: `Could not read theme file: ${errorMessage(cause)}`,
        cause,
      },
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      issue: {
        path: absolutePath,
        message: `Theme file is not valid JSON: ${errorMessage(cause)}`,
        cause,
      },
    };
  }

  let document: ThemeDocument;
  try {
    document = parseThemeDocument(decoded);
  } catch (cause) {
    return {
      ok: false,
      issue: {
        path: absolutePath,
        message: `Theme file failed schema validation: ${errorMessage(cause)}`,
        cause,
      },
    };
  }

  // The producer is the validator of what the schema cannot see (a
  // family with no `500` anchor, an unparseable colour): its refusal is
  // the load issue, named by path.
  const normalized = normalizeThemeDocument(document);
  let overlays: ThemeOverlays;
  try {
    overlays = deriveOverlays(normalized, undefined);
  } catch (cause) {
    if (cause instanceof ThemeDocumentInvalidError) {
      return {
        ok: false,
        issue: {
          path: absolutePath,
          message: `Theme file cannot be projected: ${cause.message}`,
          cause,
        },
      };
    }
    throw cause;
  }

  return {
    ok: true,
    theme: {
      source: 'file',
      path: absolutePath,
      mode,
      document: normalized,
      overlays,
    },
  };
}

/**
 * Apply flat dot-path overrides onto a copy of the raw `DtcgTheme`
 * tree. Each override key (`color.primary.500`) walks into the
 * tree; only leaves that already exist as `{ $value, $type }` token
 * objects are mutated — anything else is silently ignored.
 *
 * Returns a deep-cloned tree so the source registry entry is not
 * mutated (the registry's `parsedCache` would otherwise serve stale
 * CSS to subsequent calls).
 */
function applyOverrides(
  source: DtcgTheme,
  overrides: Record<string, string>,
): DtcgTheme {
  // Structured clone covers the nested DTCG token tree cleanly —
  // the tree is plain JSON-shaped data (no functions, no Dates).
  const cloned = structuredClone(source);

  for (const [path, value] of Object.entries(overrides)) {
    const segments = path.split('.');
    let cursor: unknown = cloned;
    for (let i = 0; i < segments.length - 1; i++) {
      if (cursor === null || typeof cursor !== 'object') break;
      cursor = (cursor as Record<string, unknown>)[segments[i]];
    }
    if (cursor === null || typeof cursor !== 'object') continue;

    const leafKey = segments[segments.length - 1];
    const leaf = (cursor as Record<string, unknown>)[leafKey];
    if (
      leaf !== null &&
      typeof leaf === 'object' &&
      '$value' in leaf &&
      '$type' in leaf
    ) {
      // Mutate $value only — keep $type and any $description intact.
      (leaf as { $value: string }).$value = value;
    }
  }

  return cloned;
}

/**
 * Convenience wrapper for the "I have a `ggui.json` path" flow.
 * Resolves the project root from the manifest path.
 */
export function loadThemeFromGguiJsonPath(
  manifestPath: string,
  manifest: GguiJsonV1,
): LoadThemeResult {
  const projectRoot = dirname(resolve(manifestPath));
  return loadTheme({ projectRoot, manifest });
}

/**
 * Re-exported for callers that need to accept any of the parse-time
 * theme shapes (string shorthand, preset object, file object) and
 * dispatch on the discriminator. `ThemeConfig` is the static
 * counterpart of `ggui.json#theme`'s zod union.
 */
export type { ThemeConfig };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
