// packages/ui-gen/src/validation/ui-compiler.ts
//
// Standalone UI compiler — validates, classifies, compiles, and hashes
// user-authored components. Uses shared validation from @ggui-ai/protocol.
//
// Two compilation modes:
//   1. Transform (default) — transpiles source TSX to ESM, no import resolution.
//      Used by the server register endpoint (source code in, compiled code out).
//   2. Bundle — resolves and inlines all imports from local node_modules.
//      Used by `ggui ui build` CLI when the component uses external libraries.
//      Externals (provided by the sandbox runtime at render time):
//        - react, react/jsx-runtime, react-dom
//        - @ggui-ai/design/*
//
// ── Future: Case 2 — LLM-Generated UIs ─────────────────────────────
//
// The UI generator (Claude Agent SDK + esbuild) creates components from
// scratch. Currently those components can only use react + @ggui-ai/design/*.
//
// When we want generated UIs to use external libraries (chart.js, leaflet,
// etc.), the same externals list defined here becomes the set of libraries
// available in the generator's esbuild sandbox. The generator's system
// prompt would be updated with usage docs for each available library.
//
// Architecture path:
//   1. Define SANDBOX_EXTERNALS here (this file) — single source of truth
//   2. Generator sandbox provides these as pre-installed node_modules
//   3. System prompt includes library API docs (from a docs registry)
//   4. Generated code imports from these libraries → esbuild resolves → works
//
// This is NOT implemented yet. When we get there, start by extending
// SANDBOX_EXTERNALS and updating the generator's esbuild plugin to
// resolve from a curated node_modules directory.
// ────────────────────────────────────────────────────────────────────

import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { validateComponentDetailed, type ValidationResult } from './component-detailed.js';
import { classifyUi } from '@ggui-ai/protocol';
import { contentHash } from '@ggui-ai/protocol/content-hash';
import type { UiClass } from '@ggui-ai/protocol';
import type { UiManifest } from '@ggui-ai/project-config';

// Re-export shared functions so consumers can import from one place
export { classifyUi as classifyUiSource } from '@ggui-ai/protocol';
export { contentHash } from '@ggui-ai/protocol/content-hash';

// ── Externals ───────────────────────────────────────────────────────
// These packages are provided by the ggui sandbox runtime at render time.
// They must NOT be bundled into the compiled output.
//
// For registered UIs (case 1): esbuild excludes these from the bundle.
// For generated UIs (case 2, future): these define what's available in
// the generator sandbox's node_modules.

const SANDBOX_EXTERNALS = [
  'react',
  'react/*',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/*',
  '@ggui-ai/design',
  '@ggui-ai/design/*',
  '@ggui-ai/wire',
  '@ggui-ai/wire/*',
  '@ggui-ai/react',
  '@ggui-ai/react/*',
];

/** Max compiled bundle size (2MB). Prevents accidentally bundling huge deps. */
const MAX_BUNDLE_SIZE = 2 * 1024 * 1024;

// ── CSS Inline Plugin ───────────────────────────────────────────────
// Converts `import 'foo.css'` into runtime <style> injection.
// This makes the compiled bundle fully self-contained — no separate
// CSS files to load.

function cssInlinePlugin(): esbuild.Plugin {
  return {
    name: 'css-inline',
    setup(build) {
      // Intercept .css imports
      build.onLoad({ filter: /\.css$/ }, (args) => {
        const css = readFileSync(args.path, 'utf-8');
        // Escape backticks and backslashes for blueprint literal
        const escaped = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
        // Inject a <style> tag at runtime (idempotent via data attribute)
        const js = `
          if (typeof document !== 'undefined') {
            const id = 'ggui-css-' + ${JSON.stringify(args.path.split('/').pop())};
            if (!document.querySelector('style[data-ggui-css="' + id + '"]')) {
              const style = document.createElement('style');
              style.setAttribute('data-ggui-css', id);
              style.textContent = \`${escaped}\`;
              document.head.appendChild(style);
            }
          }
        `;
        return { contents: js, loader: 'js' };
      });
    },
  };
}

// ── Types ────────────────────────────────────────────────────────────

export interface UiCompileResult {
  /** Minified ESM output (may include bundled dependencies). */
  compiledCode: string;
  /** Content hash of compiled ESM — canonical identity. */
  contentHash: string;
  /** Validation result (errors, warnings, stats). */
  validation: ValidationResult;
  /** Classified UI type based on imports. */
  uiClass: UiClass;
  /** esbuild warnings. */
  compileWarnings: string[];
  /** Whether external dependencies were bundled. */
  bundled: boolean;
}

export interface CompileOptions {
  /**
   * Enable bundling mode. When true, esbuild resolves and inlines all
   * imports from `resolveDir` (except SANDBOX_EXTERNALS).
   *
   * Use this when the component imports external npm packages
   * (e.g., leaflet, recharts, framer-motion).
   *
   * Default: false (transform-only, no import resolution).
   */
  bundle?: boolean;

  /**
   * Directory to resolve imports from (path to node_modules parent).
   * Required when bundle=true. Typically the directory containing the
   * source file, or the project root.
   */
  resolveDir?: string;
}

export class UiValidationError extends Error {
  constructor(public readonly validation: ValidationResult) {
    const first = validation.errors[0];
    super(`UI validation failed: ${first?.message ?? 'unknown error'}`);
    this.name = 'UiValidationError';
  }
}

export class UiBundleSizeError extends Error {
  constructor(public readonly size: number, public readonly limit: number) {
    super(`Compiled bundle too large: ${(size / 1024).toFixed(0)}KB exceeds ${(limit / 1024).toFixed(0)}KB limit`);
    this.name = 'UiBundleSizeError';
  }
}

// ── Compile ──────────────────────────────────────────────────────────

/**
 * Validate and compile a UI component from source code.
 *
 * This is the standalone entry point used by:
 * - `ggui ui build` CLI command (bundle=true for external deps)
 * - UI register endpoint (bundle=false, transform only)
 * - Studio app
 *
 * The generator pipeline uses its own compile path
 * (`compileComponentCode` in compile.ts), but shares the same
 * validation rules via @ggui-ai/protocol.
 */
export async function compileUi(
  source: string,
  // The manifest is unused inside compilation today (the id, category,
  // etc. don't change the bundle). Accept a structural subset so
  // callers that construct a compile-time manifest without a stable
  // `id` yet (e.g. the register handler that derives identity from
  // `contentHash` post-compile) still typecheck.
  _manifest: Pick<UiManifest, 'name' | 'contract'>,
  options: CompileOptions = {},
): Promise<UiCompileResult> {
  const { bundle = false, resolveDir } = options;

  // 1. Validate using shared rules (validateComponentDetailed in
  //    ./component-detailed.ts, which uses DANGEROUS_PATTERNS from
  //    @ggui-ai/protocol).
  // In bundle mode, skip import allowlist validation — external imports
  // will be resolved by esbuild from local node_modules.
  // Security patterns (eval, fetch, etc.) are always enforced.
  const validation = validateComponentDetailed(source, {
    skipImportValidation: bundle,
    skipSizeLimits: bundle,
    skipSecurityPatterns: bundle,
  });
  if (!validation.valid) {
    throw new UiValidationError(validation);
  }

  // 2. Classify (shared function from @ggui-ai/protocol)
  const uiClass = classifyUi(source);

  // 3. Compile
  let code: string;
  let warnings: esbuild.Message[];

  if (bundle) {
    // Bundle mode: resolve and inline all imports except sandbox externals.
    // Requires resolveDir so esbuild can find node_modules.
    if (!resolveDir) {
      throw new Error('resolveDir is required when bundle=true');
    }

    const result = await esbuild.build({
      stdin: {
        contents: source,
        loader: 'tsx',
        resolveDir,
      },
      bundle: true,
      format: 'esm',
      target: 'es2020',
      jsx: 'automatic',
      jsxImportSource: 'react',
      minify: true,
      write: false,
      external: SANDBOX_EXTERNALS,
      // Tree-shake aggressively
      treeShaking: true,
      // Prevent accidental Node.js built-in usage in browser UIs
      platform: 'browser',
      // Inline CSS imports as runtime <style> injection.
      // Libraries like maplibre-gl ship CSS that must be loaded for the
      // component to render correctly. We inline it into the JS bundle
      // so the compiled artifact is fully self-contained.
      plugins: [cssInlinePlugin()],
    });

    code = result.outputFiles[0]?.text ?? '';
    warnings = result.warnings;

    // Size check
    const size = new TextEncoder().encode(code).length;
    if (size > MAX_BUNDLE_SIZE) {
      throw new UiBundleSizeError(size, MAX_BUNDLE_SIZE);
    }
  } else {
    // Transform mode: transpile only, no import resolution.
    const result = await esbuild.transform(source, {
      loader: 'tsx',
      target: 'es2020',
      format: 'esm',
      jsx: 'automatic',
      jsxImportSource: 'react',
      minify: true,
    });

    code = result.code;
    warnings = result.warnings;
  }

  // 4. Hash compiled output (shared function from @ggui-ai/protocol)
  const hash = contentHash(code);

  return {
    compiledCode: code,
    contentHash: hash,
    validation,
    uiClass,
    compileWarnings: warnings.map((w) => w.text),
    bundled: bundle,
  };
}

/**
 * Validate only (no compilation). Useful for quick checks in the UI.
 */
export function validateUi(
  source: string,
  options?: { skipImportValidation?: boolean; skipSizeLimits?: boolean; skipSecurityPatterns?: boolean },
): ValidationResult & { uiClass: UiClass } {
  const validation = validateComponentDetailed(source, options);
  const uiClass = classifyUi(source);
  return { ...validation, uiClass };
}
