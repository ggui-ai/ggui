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
 * ## cssVariables pre-rendering
 *
 * The loader pre-renders the `:root { --ggui-*: value; }` CSS block
 * via either `@ggui-ai/design/themes` (preset path, full DTCG with
 * canvas + motion tokens) or `@ggui-ai/design/themes/dtcg#generateCssVariables`
 * (file path, plain DTCG). Downstream consumers (console, render
 * endpoint, MCP apps iframe) inject the pre-rendered string without
 * re-walking the token tree.
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
  generateCssVariables,
  lightTheme,
} from '@ggui-ai/design/themes/dtcg';
import { getRawTheme, getTheme, parseTheme } from '@ggui-ai/design/themes';
import type {
  DTCGTheme,
  DtcgTheme,
  ThemeMode,
} from '@ggui-ai/design/themes';
import type { GguiJsonV1, ThemeConfig } from './schema.js';
import { parseThemeDocument, type ThemeDocument } from './theme.js';

/**
 * One loaded theme — discriminated on `source`. Every variant carries
 * the resolved `mode`, the parsed token document, and the pre-rendered
 * `--ggui-*` CSS variable block.
 *
 * **`document` is shape-discriminated by `source`** (no casts, three
 * genuinely-distinct underlying types):
 *
 *   - `default` → `DTCGTheme` (base DTCG layout used by the shipped
 *     `lightTheme` / `darkTheme` literals in `@ggui-ai/design`).
 *   - `preset`  → `DtcgTheme` (the extended-DTCG registry layout — adds
 *     `$name`/`$description`/`$metadata` + `motion` + `canvas` over the
 *     base; what `getRawTheme()`/`parseTheme()` produce).
 *   - `file`    → `ThemeDocument` (the flat strict-Zod schema validated
 *     by `parseThemeDocument()` — top-level `typography`/`radius`/`shadow`,
 *     no DTCG metadata keys).
 *
 * Consumers narrow on `source` if they ever need the shape. CSS-variable
 * emission happens upstream into `cssVariables`, so most downstream code
 * only reads that string.
 */
export type LoadedTheme =
  | {
      readonly source: 'default';
      readonly mode: ThemeMode;
      readonly document: DTCGTheme;
      readonly cssVariables: string;
    }
  | {
      readonly source: 'preset';
      /** Registry id (`'claudic'`, `'ggui'`, …). */
      readonly preset: string;
      readonly mode: ThemeMode;
      /** Flat dot-path token overrides applied on top of the preset. */
      readonly overrides?: Record<string, string>;
      readonly document: DtcgTheme;
      readonly cssVariables: string;
    }
  | {
      readonly source: 'file';
      /** Absolute filesystem path of the loaded theme file. */
      readonly path: string;
      readonly mode: ThemeMode;
      readonly document: ThemeDocument;
      readonly cssVariables: string;
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
        cssVariables: generateCssVariables(lightTheme),
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
  // Resolve the raw token tree first so we can layer overrides
  // before parseTheme walks the leaves.
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

  // No overrides: hand off to the registry's parser directly so we
  // share its cache.
  if (!overrides || Object.keys(overrides).length === 0) {
    const parsed = getTheme(preset, mode);
    if (!parsed) {
      // Should not happen — getRawTheme succeeded above. Defensive.
      return {
        ok: false,
        issue: {
          path: preset,
          message: `Theme preset "${preset}" parsed unexpectedly empty.`,
        },
      };
    }
    return {
      ok: true,
      theme: {
        source: 'preset',
        preset,
        mode,
        document: raw,
        cssVariables: parsed.cssVariables,
      },
    };
  }

  // With overrides: clone the raw tree, deep-set each leaf's $value,
  // then re-parse. We bypass the registry's cache because the
  // override set is per-call and would pollute it.
  const mutated = applyOverrides(raw, overrides);
  const parsed = parseTheme(preset, mutated);
  return {
    ok: true,
    theme: {
      source: 'preset',
      preset,
      mode,
      overrides,
      document: mutated,
      cssVariables: parsed.cssVariables,
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

  return {
    ok: true,
    theme: {
      source: 'file',
      path: absolutePath,
      mode,
      document,
      cssVariables: generateCssVariables(document),
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
