/**
 * `ggui.primitives.json` v1 — primitive package manifest.
 *
 * Fourth open file-format surface in the ggui manifest model, after
 * `ggui.json` (root) and `ggui.ui.json` (per-UI). One file at the
 * root of each primitive source:
 *
 * ```
 * packages/design/
 * ├── ggui.primitives.json   ← this file
 * ├── package.json
 * └── src/primitives/
 * ```
 *
 * The root `ggui.json#primitives.packages` (npm specifiers) +
 * `primitives.local` (globs) declare *which* primitive sources the
 * app uses; this file declares *what each source exports* + the
 * `import` specifier consumers use + an optional pre-generated LLM
 * docs pointer.
 *
 * Both `primitives.packages` (npm specifiers) and `primitives.local`
 * (globs) follow the same discovery convention: the resolver walks up
 * from the resolved source to the enclosing `package.json` and reads
 * `ggui.primitives.json` next to it.
 *
 * **Ownership boundary:**
 *
 *   - *Which* packages / local paths declare primitives → `ggui.json`.
 *   - *Which* primitives a source exports + import specifier + docs
 *     pointer → this file.
 *   - *What* each primitive renders / its prop interface / its
 *     JSDoc description → TSX source in the declaring package. NOT a
 *     ggui concern.
 *
 * **Extending rules:**
 *
 *   1. Additive only within `schema: '1'`. Optional fields default to
 *      no-op behaviour so older tooling ignores them.
 *   2. Framework-neutral. Nothing Claude-SDK / Vercel-AI-SDK /
 *      LangGraph / framework-specific belongs here.
 *   3. Root and per-primitive objects are strict — unknown keys fail
 *      parse. Same discipline as `ggui.json` + `ggui.ui.json`.
 */
import { z } from 'zod';

/**
 * Primitive component name — must be a valid JavaScript identifier.
 * Stricter than a freeform string because the generator emits literal
 * `import { <name> } from '<import>'` lines, and anything that isn't
 * a valid identifier would break the TSX output.
 *
 * Also rejects reserved words implicitly via the "leading letter"
 * rule — JS identifiers can't start with a digit. A downstream
 * allowlist of reserved words is avoided here on purpose: the list
 * is long, version-dependent, and would add maintenance burden
 * without meaningfully changing what authors actually write.
 */
const PrimitiveNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, {
    message:
      'primitive name must be a valid JavaScript identifier (letters, digits, _, $; not starting with a digit).',
  });

/**
 * Per-primitive entry. v1 only requires `name`; the TSX source +
 * JSDoc is the authoritative prop-surface. Additive fields
 * (description override, deprecation marker, variant hint) land
 * later under `schema: "1"`.
 */
const PrimitiveEntrySchema = z.strictObject({
  name: PrimitiveNameSchema,
});

/**
 * Root manifest. `import` MUST be a non-empty string — either an npm
 * specifier (for `primitives.packages` sources) or a relative path
 * (for `primitives.local` sources). The discovery layer validates
 * that `import` matches the declared `packages` entry when the
 * source was resolved through an npm specifier.
 */
export const PrimitivesManifestV1 = z
  .strictObject({
    /** File-format version — always `"1"` for v1. */
    schema: z.literal('1'),

    /**
     * The specifier consumers import from. For npm-distributed
     * primitive packages this is the same string the app lists in
     * `ggui.json#primitives.packages` (e.g.
     * `@ggui-ai/design/primitives`). For in-project local primitives
     * it is the path consumers import from (e.g.
     * `./src/ui/primitives/index.js`).
     */
    import: z.string().min(1, 'import must not be empty'),

    /**
     * List of primitive components this source exports. At least one
     * entry — a manifest that declares zero primitives is always a
     * mistake.
     */
    primitives: z
      .array(PrimitiveEntrySchema)
      .min(1, 'primitives must declare at least one entry')
      .refine(
        (arr) => new Set(arr.map((p) => p.name)).size === arr.length,
        { message: 'primitive names must be unique within a manifest' },
      ),

    /**
     * Optional path to a pre-generated LLM docs blob the generator
     * can inject into the system prompt. Resolved relative to this
     * manifest's directory at load time (not parse time).
     *
     * Absent → the server falls back to a names-only doc block and
     * emits a boot warning (not fatal). The package's own build
     * pipeline is responsible for emitting the file; ggui tooling
     * never writes it.
     */
    docs: z.string().min(1).optional(),
  });

/** Static TypeScript type derived from the v1 schema. */
export type PrimitivesManifestV1 = z.infer<typeof PrimitivesManifestV1>;

/**
 * Canonical type alias — `PrimitivesManifest` is the term used
 * everywhere else (discovery, docs, mcp-server wiring).
 * `PrimitivesManifestV1` is the version-pinned name.
 */
export type PrimitivesManifest = PrimitivesManifestV1;

/**
 * Canonical filename — always `ggui.primitives.json`, always at the
 * root of the declaring package / local primitive directory.
 */
export const GGUI_PRIMITIVES_JSON_FILENAME = 'ggui.primitives.json';

/**
 * Parse a raw JSON value into a validated {@link PrimitivesManifest}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 */
export function parsePrimitivesManifest(raw: unknown): PrimitivesManifest {
  return PrimitivesManifestV1.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result.
 */
export function safeParsePrimitivesManifest(
  raw: unknown,
): ReturnType<typeof PrimitivesManifestV1.safeParse> {
  return PrimitivesManifestV1.safeParse(raw);
}
