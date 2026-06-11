/**
 * Compile-on-demand for local `ggui dev` UIs.
 *
 * Resolves the authored TSX entry for a `ggui.ui.json` and runs
 * esbuild against it, producing an ESM bundle an authoring UI can
 * hand to `DynamicComponent`. This replaces the "must pre-compile"
 * state the foundation slice left behind — `ggui dev` now feels
 * like a real dev server: start it, open the authoring UI, see the
 * render.
 *
 * Trust model:
 *
 *   The closed `core/src/validation/ui-compiler.ts` layers in
 *   `validateComponentDetailed` — security patterns (`eval`,
 *   `fetch`), import allowlist enforcement, size caps. Those exist
 *   because the cloud pipeline accepts user-uploaded TSX and runs
 *   it downstream. **Localhost `ggui dev` is NOT that pipeline.**
 *   The developer is compiling their own project's source on their
 *   own machine; a token-gated origin-allowlisted local server has
 *   the same trust as the developer's shell. No security
 *   validation here.
 *
 * Shape chosen for v1:
 *
 *   - esbuild `build` mode with bundle: true, so multi-file UIs
 *     work (import sibling helpers, theme tokens, wire hooks).
 *   - Sandbox externals match the runtime renderer
 *     (`DynamicComponent` in `@ggui-ai/react`). React, the design
 *     system, `@ggui-ai/wire`, and `@ggui-ai/react` stay external
 *     and resolve against the import map the rendering host
 *     provides at render time.
 *   - No caching. Every request recompiles. esbuild TSX transform
 *     is ~50-200ms for a typical single-screen UI — fine for the
 *     dev loop. A watcher-driven cache lands with HMR, not here.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { build, type BuildFailure, type Message } from 'esbuild';
import type { UiManifest } from '@ggui-ai/project-config';

/**
 * Packages the runtime renderer already resolves from its
 * own bundle (via `@ggui-ai/design/module-loader`'s import-map).
 * Keeping them out of the compiled bundle keeps the artifact small
 * and lets the rendering host's in-tree React instance be shared
 * across every rendered UI.
 */
export const SANDBOX_EXTERNALS = [
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  '@ggui-ai/design',
  '@ggui-ai/design/*',
  '@ggui-ai/wire',
  '@ggui-ai/wire/*',
  '@ggui-ai/react',
  '@ggui-ai/react/*',
];

/**
 * Filename candidates for the entry point when the manifest
 * doesn't declare one. Kept narrow so the convention is predictable
 * rather than "anything with a `.tsx` extension."
 */
const ENTRY_CANDIDATES = ['ggui.ui.tsx', 'index.tsx', 'component.tsx'] as const;

/** Content type the compiled bundle is served with. Matches the
 * precompiled path for consistency. */
export const COMPILED_BUNDLE_CONTENT_TYPE = 'application/javascript+react';

export interface CompileInputs {
  /** Absolute project root — directory containing `ggui.json`. */
  projectRoot: string;
  /** Absolute path to the `ggui.ui.json` this compile is for. */
  manifestPath: string;
  /** Parsed manifest — `entryPoint` drives the compile target when present. */
  manifest: UiManifest;
}

export interface CompileOk {
  kind: 'ok';
  /** Raw ESM code. */
  code: string;
  /** Absolute path compiled (the entry point). Useful for logs. */
  entry: string;
  /** esbuild info/warning messages, if any. */
  warnings: Message[];
}

export interface CompileMissingEntry {
  kind: 'missing-entry';
  /**
   * Which places were tried — absolute paths. Either the explicit
   * `manifest.entryPoint` (single element) or the fallback filename
   * candidates (in search order).
   */
  tried: string[];
}

export interface CompileFailure {
  kind: 'failure';
  entry: string;
  errors: Message[];
  warnings: Message[];
}

export type CompileResult = CompileOk | CompileMissingEntry | CompileFailure;

/**
 * Resolve the entry file for a UI manifest.
 *
 * Precedence:
 *   1. `manifest.entryPoint` (relative to `projectRoot`, or
 *      absolute). Single-candidate result.
 *   2. Fallback: the {@link ENTRY_CANDIDATES} filenames beside the
 *      manifest. First hit wins.
 *
 * Returns the resolved absolute path, or `null` with the list of
 * candidates that were tried (for the 404/missing-entry response).
 */
export function resolveEntryFile(inputs: CompileInputs): { entry: string } | { tried: string[] } {
  const { projectRoot, manifestPath, manifest } = inputs;

  if (manifest.entryPoint && manifest.entryPoint.length > 0) {
    const declared = isAbsolute(manifest.entryPoint)
      ? manifest.entryPoint
      : resolve(projectRoot, manifest.entryPoint);
    return existsSync(declared) ? { entry: declared } : { tried: [declared] };
  }

  const manifestDir = dirname(manifestPath);
  const tried: string[] = [];
  for (const filename of ENTRY_CANDIDATES) {
    const candidate = resolve(manifestDir, filename);
    tried.push(candidate);
    if (existsSync(candidate)) return { entry: candidate };
  }
  return { tried };
}

/**
 * Compile a UI's TSX source to an ESM bundle. Returns a discriminated
 * result — consumers branch on `kind` to render the right HTTP
 * response / log.
 *
 * esbuild's programmatic build can throw on catastrophic failures
 * (e.g. native binary missing). Those bubble up to the caller — the
 * HTTP layer surfaces them as 500s since they are environment /
 * install problems, not user-source problems.
 */
export async function compileUiOnDemand(inputs: CompileInputs): Promise<CompileResult> {
  const resolved = resolveEntryFile(inputs);
  if ('tried' in resolved) {
    return { kind: 'missing-entry', tried: resolved.tried };
  }

  const entry = resolved.entry;

  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      target: 'es2020',
      jsx: 'automatic',
      jsxImportSource: 'react',
      minify: false,
      write: false,
      external: SANDBOX_EXTERNALS,
      platform: 'browser',
      absWorkingDir: inputs.projectRoot,
      treeShaking: true,
      logLevel: 'silent',
    });
    const code = result.outputFiles[0]?.text ?? '';
    return { kind: 'ok', code, entry, warnings: result.warnings };
  } catch (err) {
    if (isBuildFailure(err)) {
      return {
        kind: 'failure',
        entry,
        errors: err.errors,
        warnings: err.warnings,
      };
    }
    throw err;
  }
}

function isBuildFailure(err: unknown): err is BuildFailure {
  return (
    err !== null &&
    typeof err === 'object' &&
    Array.isArray((err as { errors?: unknown }).errors) &&
    Array.isArray((err as { warnings?: unknown }).warnings)
  );
}
