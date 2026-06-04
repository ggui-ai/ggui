/**
 * Compile raw JSX/TSX component code emitted by `createUiGenerator` into
 * plain ESM that the browser's `ReactComponentRenderer` can mount.
 *
 * The OSS generator (`createUiGenerator`) ships one provider call out →
 * raw source in. The source typically carries JSX syntax, TypeScript
 * annotations, and bare ESM `import` specifiers (`react`,
 * `@ggui-ai/design/primitives`). Modern browsers can execute ESM
 * directly — but NOT JSX, and only with already-resolved specifiers.
 * This module bridges that gap with a single esbuild `transform` pass:
 *
 *   - `loader: 'tsx'` → strips types + desugars JSX to `jsx-runtime`
 *     calls.
 *   - `jsx: 'automatic'` → emits `import { jsx as _jsx } from 'react/jsx-runtime'`
 *     which the viewer's import-rewriting layer (see
 *     `@ggui-ai/design/rendering`) resolves to the host React via a
 *     `data:` URL shim.
 *   - `format: 'esm'` → keeps static `import` declarations at the top
 *     of the module so `loadModule()`'s blob-URL dynamic import sees a
 *     valid ESM module.
 *
 * The dependency on esbuild is loaded lazily via a function-scoped
 * dynamic `import('esbuild')` so consumers who never call the compiler
 * (the hosted runtime, which has its own esbuild-based generator) don't pay
 * the cold-start cost.
 *
 * Browser-side vs server-side compile: there are two ways to land
 * compiled code in the viewer — esbuild-wasm in the browser, OR
 * server-side compile + ship ESM down the render channel. ggui
 * compiles server-side: (a) the CLI already runs in Node, (b) shipping
 * esbuild-wasm into a frontend bundle is prohibitively large, (c) the
 * hosted surface also compiles server-side, so the viewer contract
 * stays identical across deployments. `withBrowserCompile` is the
 * wrapper that takes a raw-source `UiGenerator` and upgrades it to emit
 * browser-ready ESM on the component-code surface.
 */
import type {
  UiGenerateInput,
  UiGenerateResult,
  UiGenerator,
} from '@ggui-ai/mcp-server-core';

/**
 * Minimal structural view of the esbuild `transform` result we need.
 * Defined locally to avoid a hard typings dependency on `esbuild` in
 * `@ggui-ai/ui-gen` — the real esbuild module resolves this shape at
 * runtime, and the structural match is enforced by the dynamic import.
 */
interface EsbuildTransformResult {
  readonly code: string;
}

interface EsbuildModule {
  readonly transform: (
    input: string,
    options: {
      loader: 'tsx';
      format: 'esm';
      jsx: 'automatic';
      target?: string;
      sourcemap?: boolean;
    },
  ) => Promise<EsbuildTransformResult>;
}

/**
 * Lazy-loaded reference to the esbuild module. Populated on first call
 * to `compileComponentCode` and cached for subsequent calls. A bare
 * string specifier ensures bundlers don't try to inline esbuild at
 * build time (it's a runtime-only dep).
 */
let esbuildPromise: Promise<EsbuildModule> | null = null;

async function loadEsbuild(): Promise<EsbuildModule> {
  if (esbuildPromise === null) {
    esbuildPromise = (async () => {
      // String-literal specifier keeps bundlers from pulling esbuild in
      // at analyze time; it's only loaded when a compile is attempted.
      const mod = (await import('esbuild')) as unknown as EsbuildModule;
      return mod;
    })();
  }
  return esbuildPromise;
}

/**
 * Thrown when `compileComponentCode` can't transform the generator's
 * raw source. Carries the underlying esbuild message so upstream
 * consumers can surface a readable failure on the render channel
 * instead of blowing up the whole render RPC.
 */
export class CompileComponentCodeError extends Error {
  constructor(
    message: string,
    /** Original error from esbuild (or the module loader) if any. */
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CompileComponentCodeError';
  }
}

/**
 * Transform raw JSX/TSX source from `createUiGenerator` into plain ESM
 * that `loadModule` (blob-URL dynamic import) can execute in the
 * browser. Bare specifiers (`react`, `@ggui-ai/design/*`) are left as
 * static imports — the renderer's `rewriteImports` step resolves them
 * to `data:`-URL shims that read from `globalThis.__ggui__` at mount
 * time.
 *
 * Pure function: no filesystem, no network, no globals mutated.
 *
 * @throws {CompileComponentCodeError} when esbuild rejects the source.
 */
export async function compileComponentCode(source: string): Promise<string> {
  if (typeof source !== 'string' || source.length === 0) {
    throw new CompileComponentCodeError(
      'compileComponentCode requires a non-empty source string',
    );
  }
  let esbuild: EsbuildModule;
  try {
    esbuild = await loadEsbuild();
  } catch (err) {
    throw new CompileComponentCodeError(
      `esbuild is required to compile generated component code but could not be loaded: ${stringifyError(err)}. Install 'esbuild' in the host process.`,
      err,
    );
  }
  try {
    const result = await esbuild.transform(source, {
      loader: 'tsx',
      format: 'esm',
      jsx: 'automatic',
      target: 'es2020',
      sourcemap: false,
    });
    return result.code;
  } catch (err) {
    throw new CompileComponentCodeError(
      `esbuild failed to transform generator output: ${stringifyError(err)}`,
      err,
    );
  }
}

/**
 * Wrap a `UiGenerator` so that successful outputs carry browser-ready
 * ESM on `response.componentCode` (and the parallel `response.sourceCode`
 * field) — the original JSX/TSX source is preserved on
 * `response.sourceCode` so downstream consumers that want human-readable
 * source (benchmarks, blueprint cache seeding) still have it.
 *
 *   const raw = createUiGenerator({ adapter });
 *   const oss = withBrowserCompile(raw);
 *   const out = await oss.generate({ ... });
 *   // out.response.componentCode → ESM (browser-ready)
 *   // out.response.sourceCode    → original JSX/TSX
 *
 * Compile failures are funnelled into the generator's
 * `PRODUCTION_FAILED` error channel, NOT thrown. Consumers (the OSS
 * render handler) already classify generator failures and commit an
 * error-only render — so a compile failure shows up in the viewer
 * with the same "couldn't render" ergonomics as a provider failure.
 * Throwing out of `generate()` would break the handler's invariant that
 * the generator never rejects.
 *
 * Wrapping is additive on `stream()` — if the underlying generator
 * implements streaming, the wrapper forwards the iterator untouched.
 * Compilation happens only on the terminal `done` envelope / the
 * non-streaming `generate` path.
 */
export function withBrowserCompile(generator: UiGenerator): UiGenerator {
  return {
    // Forward identity from the wrapped generator. Identity is a
    // registry-level handle, not a runtime concern — wrappers don't
    // change the slug.
    slug: generator.slug,
    tier: generator.tier,
    model: generator.model,
    async generate(input: UiGenerateInput): Promise<UiGenerateResult> {
      const raw = await generator.generate(input);
      if (!raw.ok) return raw;
      const sourceCode = raw.response.componentCode;
      let compiled: string;
      try {
        compiled = await compileComponentCode(sourceCode);
      } catch (err) {
        const message =
          err instanceof CompileComponentCodeError
            ? err.message
            : stringifyError(err);
        return {
          ok: false,
          error: {
            code: 'PRODUCTION_FAILED',
            message: `generator output did not compile to browser ESM: ${message}`,
            details: {
              kind: 'compile-failed',
              cause: message,
            },
          },
          metadata: raw.metadata,
        };
      }
      return {
        ok: true,
        response: {
          ...raw.response,
          componentCode: compiled,
          sourceCode,
        },
        metadata: raw.metadata,
      };
    },
    // Forward `stream()` unchanged when present — compilation is a
    // terminal concern, not an incremental one.
    ...(typeof generator.stream === 'function'
      ? { stream: generator.stream.bind(generator) }
      : {}),
  };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
