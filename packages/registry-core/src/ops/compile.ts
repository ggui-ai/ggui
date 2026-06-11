/**
 * `compileBlueprint` — the TSX → JS compile boundary.
 *
 * Pure transform from a blueprint's `manifest.source` (TSX text) to
 * compiled JS bytes + content digest. Called by the publish op before
 * writing the {@link CompiledBlobRow} + {@link ArtifactVersionRow}.
 * NO I/O — esbuild's synchronous transform API is used so this op
 * stays at the seam where reads and writes are sequenced by the
 * caller's transaction.
 *
 * **Determinism.** The compile config below is a fixed settings
 * matrix. Changing any field is a `compiledDigest` mass-invalidation
 * — every previously-published version produces a different digest.
 * Any change to this matrix requires a migration plan, because the
 * matcher's cross-app cache sharing and federation keys depend on
 * stable digests across all federating registries.
 *
 *   format: 'esm'              — required (the iframe runtime + matcher
 *                                 consume ES modules; no CJS path).
 *   target: 'es2022'           — pinned to the lowest engine the
 *                                 protocol supports; rebumping is a
 *                                 minor protocol version bump.
 *   minify: false              — readability matters more than size at
 *                                 this scale (~10s of KB per blueprint).
 *   loader: 'tsx'              — input is JSX/TSX text.
 *   treeShaking: false         — preserve all imports so the conformance
 *                                gate's import-walk matches what's in
 *                                the compiled output. Imports pass
 *                                through verbatim (transformSync does
 *                                no bundle resolution); consumers
 *                                (iframe runtime, matcher) provide the
 *                                conformance-gate allow-listed modules
 *                                at module-load time.
 *
 * **esbuild version pin.** `packages/registry-core/package.json` pins
 * `esbuild` to a single minor — the digest is sensitive to esbuild's
 * own version bumps. Bumping esbuild is a coordinated re-publish
 * exercise; the policy lives in the migration doc.
 *
 * **Failure mode.** Compile errors surface as a typed result
 * `{ ok: false }` with structured `errors` from esbuild. The publish
 * op projects them onto the conformance-failure wire envelope
 * (`blueprint_compile_error`). The static-gates conformance op
 * already runs a more permissive `esbuild.transformSync` to surface
 * the same code at conformance-check time; this compile op is the
 * load-bearing one (its OUTPUT is what's stored), but the two are
 * deliberately separate so a `POST /conformance/check` dry-run
 * remains cheap (no bundle resolution).
 */
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';

/** Compile output — base64-encoded bytes, hex digest, decoded size. */
export interface CompileBlueprintOk {
  readonly ok: true;
  readonly compiledBytes: string;
  readonly compiledDigest: string;
  readonly compiledSize: number;
}

/** Compile failure — structured esbuild diagnostics for wire surfacing. */
export interface CompileBlueprintErr {
  readonly ok: false;
  readonly errors: ReadonlyArray<{
    readonly message: string;
    readonly location?: { readonly line?: number; readonly column?: number };
  }>;
}

export type CompileBlueprintResult = CompileBlueprintOk | CompileBlueprintErr;

/**
 * Compile a blueprint's TSX `source` into canonical compiled JS bytes.
 *
 * Sync at call site — esbuild's `transformSync` is used to keep the
 * publish op's transaction boundaries clean (one async hop into
 * compile, one async hop into storage). The transform is itself fast
 * (<10ms for typical blueprints).
 *
 * @returns Discriminated-union result. Caller projects errors onto
 *          the conformance-failure wire envelope; success is a
 *          base64 string + hex digest + decoded byte count.
 */
export function compileBlueprint(source: string): CompileBlueprintResult {
  try {
    // esbuild.buildSync would require a virtual-fs layer to handle
    // imports; we use transformSync which compiles a single text input
    // and emits a single text output. Tree-shaking is OFF and externals
    // are not stripped (preserved as ESM import statements). This
    // matches what the runtime + matcher consume.
    const result = esbuild.transformSync(source, {
      loader: 'tsx',
      format: 'esm',
      target: 'es2022',
      minify: false,
      treeShaking: false,
      // `keepNames` keeps function/class names for stack traces — the
      // matcher's source-map-less debug surface depends on these.
      keepNames: true,
      // `sourcemap` off — sourcemaps would inject non-deterministic
      // path strings into the output, breaking digest stability.
      sourcemap: false,
    });

    // With `transformSync` (not `buildSync`) imports are preserved
    // verbatim in the output — tree-shaking off + no bundle resolution
    // means the import statements pass through unmodified. Consumers
    // (iframe runtime, matcher) provide the allow-listed modules at
    // module-load time; the conformance gate's import-walk enforces
    // that allow-list on the source side before publish.

    const bytes = Buffer.from(result.code, 'utf-8');
    const compiledBytes = bytes.toString('base64');
    const compiledDigest = createHash('sha256').update(bytes).digest('hex');
    return {
      ok: true,
      compiledBytes,
      compiledDigest,
      compiledSize: bytes.byteLength,
    };
  } catch (err) {
    // esbuild's BuildFailure shape exposes `errors: Message[]` with
    // text + location. Other throw shapes (TypeError, OOM) surface
    // as a single generic error.
    const errors = extractEsbuildErrors(err);
    return { ok: false, errors };
  }
}

interface EsbuildLikeMessage {
  readonly text?: string;
  readonly location?: { readonly line?: number; readonly column?: number } | null;
}

function extractEsbuildErrors(
  err: unknown,
): ReadonlyArray<{
  readonly message: string;
  readonly location?: { readonly line?: number; readonly column?: number };
}> {
  if (err === null || typeof err !== 'object') {
    return [{ message: err instanceof Error ? err.message : String(err) }];
  }
  const maybeErrors = (err as { errors?: unknown }).errors;
  if (!Array.isArray(maybeErrors) || maybeErrors.length === 0) {
    const message = err instanceof Error ? err.message : String(err);
    return [{ message }];
  }
  const out: Array<{
    message: string;
    location?: { line?: number; column?: number };
  }> = [];
  for (const m of maybeErrors) {
    if (m === null || typeof m !== 'object') continue;
    const msg = m as EsbuildLikeMessage;
    const message =
      typeof msg.text === 'string' && msg.text.length > 0 ? msg.text : 'esbuild error';
    if (
      msg.location !== null &&
      msg.location !== undefined &&
      (typeof msg.location.line === 'number' || typeof msg.location.column === 'number')
    ) {
      const location: { line?: number; column?: number } = {};
      if (typeof msg.location.line === 'number') location.line = msg.location.line;
      if (typeof msg.location.column === 'number') location.column = msg.location.column;
      out.push({ message, location });
    } else {
      out.push({ message });
    }
  }
  return out;
}
