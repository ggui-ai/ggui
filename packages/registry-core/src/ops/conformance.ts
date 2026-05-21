/**
 * Conformance check — a pure function shared by the registry server,
 * the hosted registry, and the publish op so they all enforce the
 * same gate.
 *
 * ## Gadget gates
 *
 *   1. **`manifest_invalid`**                 — manifest does not parse against the
 *      strict zod schema in `@ggui-ai/artifact-manifest`.
 *
 *   2. **`bundle_parse_error`**               — submitted `bundle` text does not
 *      parse as ESM via `oxc-parser`'s `parseSync`.
 *
 *   3. **`disallowed_import`**                — AST-walk over the bundle's
 *      `staticImports` + `dynamicImports` rejects any source not in the
 *      allowlist + verifies a matching named or default export exists.
 *      Dynamic imports with a non-literal specifier
 *      (`import(getEvilPkg())`) are rejected outright since the static
 *      gate cannot resolve the target.
 *
 *   4. **`missing_default_export`**           — same walk; for every entry in
 *      the manifest's `exports[]` the bundle must carry either a
 *      `default` export or a named export matching that entry's
 *      `hook` / `component` name.
 *
 * ## Blueprint gates
 *
 * Blueprints carry TSX source instead of a pre-compiled bundle; the
 * gate compiles + AST-walks the source so the registry rejects
 * un-installable blueprints at publish time instead of at iframe load
 * time.
 *
 *   5. **`blueprint_source_too_large`**       — `manifest.source` exceeds
 *      {@link MAX_BLUEPRINT_SOURCE_BYTES}.
 *
 *   6. **`blueprint_compile_error`**          — `oxc-parser` rejects the TSX
 *      source (syntax error, JSX-not-resolved, etc.). `oxc-parser`'s
 *      `lang: 'tsx'` validates JSX + TS syntax on its own, so this
 *      gate is parse-only — no separate compile step is needed here
 *      (the import-walk runs directly against `manifest.source`).
 *
 *   7. **`blueprint_disallowed_import`**      — source imports a module
 *      outside the always-allowlist. Walks both `staticImports` and
 *      `dynamicImports`. Dynamic imports with a non-literal specifier
 *      (`import(getEvilPkg())`) are rejected outright since the static
 *      gate cannot resolve the target. Blueprints have NO `peerDeps`
 *      channel — the only legal imports are `react`, `react-dom`,
 *      `react/jsx-runtime`, `@ggui-ai/gadgets`.
 *
 *   8. **`blueprint_missing_default_export`** — source has no default
 *      export. The iframe runtime mounts the default export as the root
 *      component; a blueprint without one cannot render.
 *
 *   9. **`fixture_props_shape_mismatch`**     — both `manifest.fixtureProps`
 *      and `manifest.contract.propsSpec` are present, and the fixture is
 *      missing a key marked `required: true` on the propsSpec (or the
 *      fixture is not a JSON object).
 *
 * Each gate short-circuits the next. Within the import walk, every
 * disallowed import + the missing-export check are all collected
 * together (one walk, every violation surfaced).
 *
 * The optional runtime-probe gate (`blueprint_runtime_probe_failed`) is
 * defined in this file's {@link ConformanceErrorCode} union but executed
 * by {@link BlueprintProbeRunner}-implementing packages — kept out of
 * registry-core to keep this layer free of DOM-emulation deps.
 */
import {
  safeParseArtifactManifest,
  type ArtifactManifest,
} from '@ggui-ai/artifact-manifest';
import {
  parseSync,
  type DynamicImport,
  type StaticExport,
  type StaticImport,
} from 'oxc-parser';
import type { ZodIssue } from 'zod';

/**
 * Body shape of the conformance request. `bundle` is the UTF-8 text of
 * the compiled gadget entry; required for `kind: "gadget"` manifests,
 * ignored otherwise.
 */
export interface ConformanceRequestPayload {
  readonly manifest: unknown;
  readonly bundle?: string;
}

/**
 * Stable error-code enum. Strings are the wire contract — the publish
 * CLI matches on these for human-readable rendering.
 *
 * Also exported as the `ConformanceFailureCode` alias for callers
 * reading the `conformanceFailureCode` sub-discriminator field on the
 * publish error body. Same union, two names — the `*FailureCode` name
 * reads naturally on the publish/error side; the `*ErrorCode` name
 * reads naturally on the standalone-conformance-check side.
 */
export type ConformanceErrorCode =
  | 'manifest_invalid'
  | 'bundle_parse_error'
  | 'disallowed_import'
  | 'missing_default_export'
  | 'blueprint_source_too_large'
  | 'blueprint_compile_error'
  | 'blueprint_disallowed_import'
  | 'blueprint_missing_default_export'
  | 'fixture_props_shape_mismatch'
  | 'blueprint_runtime_probe_failed';

export type ConformanceFailureCode = ConformanceErrorCode;

export interface ConformanceError {
  readonly code: ConformanceErrorCode;
  readonly message: string;
  /**
   * Zod `path` array for `manifest_invalid`, otherwise omitted. Zod's
   * issue paths are `PropertyKey[]` (string | number | symbol); the
   * symbol case is projected via `String(...)` in {@link zodIssueToError}.
   */
  readonly path?: readonly (string | number)[];
  /**
   * Per-code structured detail — `{ line, column }` for parse errors,
   * `{ source }` for disallowed imports, etc.
   */
  readonly detail?: unknown;
}

export interface ConformanceResponseBody {
  readonly ok: boolean;
  readonly errors: readonly ConformanceError[];
}

/**
 * Always-permitted import sources for gadget bundles. Mirrors the
 * runtime CSP the iframe enforces — these are the only modules the
 * data-URL shim resolves besides the manifest's `peerDeps`.
 *
 * Kept as a `readonly Set` so the walker check is O(1) and the array
 * cannot be mutated by callers. The exact contents are wire-stable;
 * widening requires a follow-up + migration note.
 */
const ALWAYS_ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@ggui-ai/gadgets',
]);

/**
 * Hard upper bound on blueprint TSX source size. Symmetric with the
 * gadget bundle limit ({@link MAX_BUNDLE_BYTES} in `publish.ts`) so an
 * operator with no `MAX_BUNDLE_BYTES` mental model still gets the same
 * order of magnitude. Source size is measured in UTF-8 bytes, not
 * JavaScript string length — multi-byte characters count for their
 * encoded width.
 */
export const MAX_BLUEPRINT_SOURCE_BYTES = 5 * 1024 * 1024;

/**
 * Run the conformance check synchronously. Pure function: no AWS, no
 * network, no env lookups. Returns the locked response body shape.
 * The OSS server, the cloud Lambda, and the publish op all call this.
 *
 * Static gates only — the optional runtime probe lives behind a
 * {@link BlueprintProbeRunner} seam so registry-core stays free of
 * DOM-emulation deps (happy-dom + react-dom/server land in the caller
 * that wants the probe).
 */
export function checkConformance(
  payload: ConformanceRequestPayload,
): ConformanceResponseBody {
  // ── Gate 1: manifest schema ────────────────────────────────────────
  const manifestResult = safeParseArtifactManifest(payload.manifest);
  if (!manifestResult.success) {
    return {
      ok: false,
      errors: manifestResult.error.issues.map(zodIssueToError),
    };
  }
  const manifest: ArtifactManifest = manifestResult.data;

  if (manifest.kind === 'blueprint') {
    return checkBlueprintConformance(manifest);
  }

  return checkGadgetConformance(manifest, payload.bundle);
}

/**
 * Gadget gate sequence — parses + import-walks the submitted bundle.
 * Extracted from {@link checkConformance} so the blueprint branch can
 * stand on its own without nesting.
 */
function checkGadgetConformance(
  manifest: Extract<ArtifactManifest, { kind: 'gadget' }>,
  bundle: string | undefined,
): ConformanceResponseBody {
  // ── Gate 2: bundle is parseable ESM ────────────────────────────────
  if (typeof bundle !== 'string' || bundle.length === 0) {
    return {
      ok: false,
      errors: [
        {
          code: 'bundle_parse_error',
          message:
            'gadget submission is missing the `bundle` field — bundle text is required for kind=gadget conformance.',
        },
      ],
    };
  }

  const parsed = parseSync('bundle.js', bundle, {
    lang: 'js',
    sourceType: 'module',
  });

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    if (!first) {
      return {
        ok: false,
        errors: [{ code: 'bundle_parse_error', message: 'unknown parse error' }],
      };
    }
    const firstLabel = first.labels[0];
    const offset = firstLabel?.start ?? 0;
    const { line, column } = offsetToLineCol(bundle, offset);
    return {
      ok: false,
      errors: [
        {
          code: 'bundle_parse_error',
          message: first.message,
          detail: { line, column, offset },
        },
      ],
    };
  }

  // ── Gate 3: import allowlist + export check (combined walk) ────────
  const peerDepKeys = manifest.peerDeps
    ? new Set(Object.keys(manifest.peerDeps))
    : new Set<string>();

  const errors: ConformanceError[] = [];

  for (const imp of parsed.module.staticImports) {
    const source = imp.moduleRequest.value;
    if (!isImportAllowed(source, peerDepKeys)) {
      const { line, column } = offsetToLineCol(bundle, imp.start);
      errors.push({
        code: 'disallowed_import',
        message: `import source \`${source}\` is not in the conformance allowlist. Allowed: \`react\`, \`react-dom\`, \`react/jsx-runtime\`, \`@ggui-ai/gadgets\`, plus any package declared in \`peerDeps\`.`,
        detail: { source, line, column },
      });
    }
  }

  // Dynamic imports — same allow-list, plus a hard reject on non-literal
  // expressions (`import(getEvilPkg())`) since the static gate cannot
  // know the target. Pre-launch posture: a known bypass path that
  // would otherwise sail through; rejected outright.
  for (const dyn of parsed.module.dynamicImports) {
    const dynError = checkDynamicImport(
      bundle,
      dyn,
      'disallowed_import',
      (source) => isImportAllowed(source, peerDepKeys),
      'Allowed: `react`, `react-dom`, `react/jsx-runtime`, `@ggui-ai/gadgets`, plus any package declared in `peerDeps`.',
    );
    if (dynError) errors.push(dynError);
  }

  // A gadget package declares ≥1 export; the bundle MUST carry a
  // matching named export (or `default`) for every one of them.
  for (const exp of manifest.exports) {
    const isHook = 'hook' in exp;
    const exportName = isHook ? exp.hook : exp.component;
    if (!hasMatchingExport(parsed.module.staticExports, exportName)) {
      errors.push({
        code: 'missing_default_export',
        message: `bundle exports neither \`default\` nor a named export matching the manifest's ${isHook ? 'hook' : 'component'} "${exportName}". The publish CLI fails closed when the LLM cannot resolve the export entry.`,
        detail: { expectedHook: exportName },
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Blueprint gate sequence — compile + import-walk + export + fixture
 * shape. Static-only; the runtime probe lives behind the optional
 * {@link BlueprintProbeRunner} seam.
 */
function checkBlueprintConformance(
  manifest: Extract<ArtifactManifest, { kind: 'blueprint' }>,
): ConformanceResponseBody {
  // ── Gate 5: source size ──────────────────────────────────────────
  const sourceBytes = utf8ByteLength(manifest.source);
  if (sourceBytes > MAX_BLUEPRINT_SOURCE_BYTES) {
    return {
      ok: false,
      errors: [
        {
          code: 'blueprint_source_too_large',
          message: `blueprint source is ${sourceBytes} bytes; maximum is ${MAX_BLUEPRINT_SOURCE_BYTES} bytes (${MAX_BLUEPRINT_SOURCE_BYTES / (1024 * 1024)} MiB).`,
          detail: { sourceBytes, maxBytes: MAX_BLUEPRINT_SOURCE_BYTES },
        },
      ],
    };
  }

  // ── Gate 6: TSX parse + syntax validation ────────────────────────
  // oxc-parser's `lang: 'tsx'` rejects JSX + TS syntax errors directly,
  // so a separate esbuild compile is redundant work. Parsing the SOURCE
  // (not a compiled output) is deliberate — author intent (including
  // unused imports that signal mis-configured deps) is what the
  // allow-list gates, not whatever a bundler would optimize away.
  const parsed = parseSync('blueprint.tsx', manifest.source, {
    lang: 'tsx',
    sourceType: 'module',
  });
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    const offset = first?.labels[0]?.start ?? 0;
    const { line, column } = offsetToLineCol(manifest.source, offset);
    return {
      ok: false,
      errors: [
        {
          code: 'blueprint_compile_error',
          message: first?.message ?? 'syntax error in blueprint source',
          detail: { line, column, offset },
        },
      ],
    };
  }

  const errors: ConformanceError[] = [];

  for (const imp of parsed.module.staticImports) {
    const source = imp.moduleRequest.value;
    if (!ALWAYS_ALLOWED_IMPORTS.has(source)) {
      const { line, column } = offsetToLineCol(manifest.source, imp.start);
      errors.push({
        code: 'blueprint_disallowed_import',
        message: `import source \`${source}\` is not allowed in a blueprint. Blueprints have no \`peerDeps\` channel; the only legal imports are \`react\`, \`react-dom\`, \`react/jsx-runtime\`, \`@ggui-ai/gadgets\`.`,
        detail: { source, line, column },
      });
    }
  }

  // Dynamic imports — same allow-list, plus a hard reject on non-literal
  // expressions (`import(getEvilPkg())`) since the static gate cannot
  // know the target. Pre-launch posture: a known bypass path; rejected
  // outright. Blueprints have no peerDeps channel, so the literal must
  // resolve into ALWAYS_ALLOWED_IMPORTS.
  for (const dyn of parsed.module.dynamicImports) {
    const dynError = checkDynamicImport(
      manifest.source,
      dyn,
      'blueprint_disallowed_import',
      (source) => ALWAYS_ALLOWED_IMPORTS.has(source),
      'Blueprints have no `peerDeps` channel; the only legal imports are `react`, `react-dom`, `react/jsx-runtime`, `@ggui-ai/gadgets`.',
    );
    if (dynError) errors.push(dynError);
  }

  // ── Gate 8: default export ───────────────────────────────────────
  if (!hasDefaultExport(parsed.module.staticExports)) {
    errors.push({
      code: 'blueprint_missing_default_export',
      message:
        'blueprint source has no default export. The iframe runtime mounts the default export as the root component — a blueprint without one cannot render.',
    });
  }

  // ── Gate 9: fixtureProps × contract.propsSpec shape ──────────────
  if (
    manifest.fixtureProps !== undefined &&
    manifest.contract?.propsSpec !== undefined
  ) {
    const shapeError = validateFixturePropsShape(
      manifest.fixtureProps,
      manifest.contract.propsSpec,
    );
    if (shapeError !== null) {
      errors.push(shapeError);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Allowlist check — short-circuits on the implicit four sources, then
 * falls through to the manifest's `peerDeps` keys. Subpath imports of
 * a `peerDeps` root are also allowed (e.g. `mapbox-gl/dist/mapbox-gl.css`
 * when `mapbox-gl` is a peerDep).
 */
function isImportAllowed(
  source: string,
  peerDepKeys: ReadonlySet<string>,
): boolean {
  if (ALWAYS_ALLOWED_IMPORTS.has(source)) return true;
  if (peerDepKeys.has(source)) return true;

  const slashIdx = source.indexOf('/');
  if (slashIdx > 0 && !source.startsWith('@')) {
    const root = source.slice(0, slashIdx);
    if (peerDepKeys.has(root)) return true;
  }
  if (source.startsWith('@')) {
    const firstSlash = source.indexOf('/');
    if (firstSlash > 0) {
      const secondSlash = source.indexOf('/', firstSlash + 1);
      if (secondSlash > 0) {
        const root = source.slice(0, secondSlash);
        if (peerDepKeys.has(root)) return true;
      }
    }
  }
  return false;
}

function hasMatchingExport(
  staticExports: readonly StaticExport[],
  expectedHook: string,
): boolean {
  for (const exp of staticExports) {
    for (const entry of exp.entries) {
      if (entry.exportName.kind === 'Default') return true;
      if (entry.exportName.kind === 'Name' && entry.exportName.name === expectedHook) {
        return true;
      }
    }
  }
  return false;
}

function hasDefaultExport(staticExports: readonly StaticExport[]): boolean {
  for (const exp of staticExports) {
    for (const entry of exp.entries) {
      if (entry.exportName.kind === 'Default') return true;
      // oxc-parser reports the alias form `export { X as default }`
      // as `kind: 'Name'` with `name: 'default'`. Both shapes are
      // semantically default exports — the iframe runtime mounts
      // whichever the bundler emits as `module.exports.default` /
      // `import().default`.
      if (entry.exportName.kind === 'Name' && entry.exportName.name === 'default') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Fixture shape check — verifies that every `properties[key]` marked
 * `required: true` on the contract's propsSpec is present on the
 * fixture, and that the fixture itself is a JSON object (not array,
 * not null, not primitive).
 *
 * Deliberately narrow: full per-prop JSON-Schema validation would
 * require materializing each `properties[k].schema` into a validator
 * (ajv or zod-via-json-schema). At conformance time the goal is to
 * catch "author shipped fixtureProps with the wrong top-level shape";
 * deep type-mismatch within a fixture key is caught by the runtime
 * probe, which actually renders the blueprint with the fixture.
 */
function validateFixturePropsShape(
  fixtureProps: unknown,
  propsSpec: {
    readonly properties: Record<
      string,
      { readonly required?: boolean }
    >;
  },
): ConformanceError | null {
  if (
    fixtureProps === null ||
    typeof fixtureProps !== 'object' ||
    Array.isArray(fixtureProps)
  ) {
    return {
      code: 'fixture_props_shape_mismatch',
      message: `fixtureProps must be a JSON object (got ${describeJsonType(fixtureProps)}). The runtime probe renders the blueprint with \`<Component {...fixtureProps} />\`; a non-object fixture cannot spread.`,
      detail: { received: describeJsonType(fixtureProps) },
    };
  }
  // After the `typeof === 'object' && !null && !Array.isArray` narrowing
  // above, `fixtureProps` is `object`. `in` works on `object` — no
  // `Record<string, unknown>` cast needed.
  const missing: string[] = [];
  for (const [key, entry] of Object.entries(propsSpec.properties)) {
    if (entry.required === true && !(key in fixtureProps)) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    return {
      code: 'fixture_props_shape_mismatch',
      message: `fixtureProps is missing required ${missing.length === 1 ? 'key' : 'keys'} \`${missing.join('`, `')}\` declared on contract.propsSpec.properties. Either add the ${missing.length === 1 ? 'key' : 'keys'} to fixtureProps or relax \`required\` on the propsSpec.`,
      detail: { missingKeys: missing },
    };
  }
  return null;
}

function describeJsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Walk a single dynamic-import expression. The oxc-parser AST gives
 * us only `start`/`end` byte offsets for the `moduleRequest`, so we
 * extract the raw source slice and detect a literal string ourselves.
 *
 * Pre-launch posture: non-literal expressions (`import(getEvilPkg())`)
 * are rejected outright. The static gate cannot know the resolved
 * target and ignoring them would create a silent bypass of the
 * allow-list. Symmetric across gadgets (allow-list = ALWAYS_ALLOWED +
 * peerDeps) and blueprints (allow-list = ALWAYS_ALLOWED only).
 */
function checkDynamicImport(
  source: string,
  dyn: DynamicImport,
  code: 'disallowed_import' | 'blueprint_disallowed_import',
  isAllowed: (specifier: string) => boolean,
  allowedSuffix: string,
): ConformanceError | null {
  const raw = source.slice(dyn.moduleRequest.start, dyn.moduleRequest.end);
  const literal = parseStringLiteral(raw);
  const { line, column } = offsetToLineCol(source, dyn.start);

  if (literal === null) {
    return {
      code,
      message: `dynamic import with a non-literal expression (\`import(${raw.length > 40 ? raw.slice(0, 37) + '...' : raw})\`) is not allowed — the static gate cannot verify the target against the allow-list. Inline the specifier as a string literal.`,
      detail: { source: '<dynamic-expression>', expression: raw, line, column },
    };
  }
  if (!isAllowed(literal)) {
    return {
      code,
      message: `dynamic import source \`${literal}\` is not in the conformance allowlist. ${allowedSuffix}`,
      detail: { source: literal, line, column },
    };
  }
  return null;
}

/**
 * Parse a JS string literal from its raw source slice. Returns the
 * decoded value for single-quoted, double-quoted, or template-literal
 * specifiers with NO interpolation (e.g. `` `react` ``). Returns
 * `null` for any non-literal expression (identifier, call, template
 * with `${...}`, etc.) — callers treat null as "non-literal, reject".
 *
 * Deliberately conservative: we do not decode escape sequences in the
 * specifier because import specifiers in practice are bare package
 * names. A specifier that requires escape decoding (`'react'`)
 * is rare enough that surfacing it as "non-literal, reject" is the
 * safer pre-launch default than risking a half-correct decoder.
 */
function parseStringLiteral(raw: string): string | null {
  if (raw.length < 2) return null;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (first !== last) return null;
  if (first !== "'" && first !== '"' && first !== '`') return null;
  const inner = raw.slice(1, -1);
  if (first === '`' && inner.includes('${')) return null;
  // Reject any escape sequence — bare package names don't need them,
  // and a half-correct unescape would be a contract surface we'd have
  // to maintain forever.
  if (inner.includes('\\')) return null;
  // Reject unescaped quote of the matching kind (would mean we
  // mis-identified the boundaries — defensive).
  if (inner.includes(first)) return null;
  return inner;
}

function zodIssueToError(issue: ZodIssue): ConformanceError {
  const path: (string | number)[] = issue.path.map((seg) =>
    typeof seg === 'symbol' ? String(seg) : seg,
  );
  return {
    code: 'manifest_invalid',
    message: issue.message,
    path,
    detail: { zodCode: issue.code },
  };
}

function offsetToLineCol(
  source: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

function utf8ByteLength(s: string): number {
  // `TextEncoder` is universally available in Node 18+ and edge runtimes.
  // Avoids the `Buffer.byteLength` Node-only dep that registry-core would
  // otherwise inherit.
  return new TextEncoder().encode(s).length;
}

/**
 * Runtime-probe seam. Implemented by callers that opt into the
 * sandboxed render check. registry-core does not provide a default
 * impl because the canonical happy-dom-based runner pulls in
 * `happy-dom` + `react-dom/server` — deps the lean conformance HTTP
 * endpoint should not pay for.
 *
 * Publish flow wires this through `PublishArtifactDeps.blueprintProbe`
 * (optional). When absent, the probe is skipped and only the static
 * gates run.
 */
export interface BlueprintProbeRunner {
  /**
   * Render the compiled blueprint with the manifest's fixtureProps in
   * a sandboxed DOM. Resolve to `ok: true` on a clean render; resolve
   * to `ok: false` with a single error carrying code
   * `'blueprint_runtime_probe_failed'` on any thrown error during
   * compile / mount / render.
   */
  probe(
    manifest: Extract<ArtifactManifest, { kind: 'blueprint' }>,
  ): Promise<ConformanceResponseBody>;
}

export type { StaticImport, StaticExport };
