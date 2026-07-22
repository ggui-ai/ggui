/**
 * `ggui.blueprint.json` — author-side manifest for cached UI
 * blueprints published to the ggui marketplace.
 *
 * Blueprints are the OTHER artifact kind the registry hosts (beside
 * gadgets). A blueprint bundles:
 *
 *   - **TSX source** — the React component body the runtime renders.
 *   - **DataContract** (optional) — the contract shape this blueprint
 *     was designed for. Consumed by the cache-match path.
 *   - **fixtureProps** (optional) — sample props used by the
 *     conformance gate's runtime probe.
 *   - **variance tags** (optional) — persona / aesthetic / context
 *     hints that drive the LLM-driven variant selector when multiple
 *     blueprints share a `(appId, contractHash)` group.
 *
 * ## Relation to `ggui_ops_register_blueprint`
 *
 * The operator registration tool `ggui_ops_register_blueprint`
 * (`@ggui-ai/mcp-server-handlers`) takes `{contract, componentCode,
 * generator?, persona?, aesthetic?, context?, seedPrompt?,
 * setAsOperatorDefault?}`. Mapping a manifest onto that envelope:
 *
 *   - `source`            → `componentCode` (verbatim TSX body).
 *   - `contract`          → `contract` (optional on the manifest,
 *                           REQUIRED by the tool — a contract-less
 *                           manifest cannot be registered as-is).
 *   - `variance`          → the flat `persona` / `aesthetic` /
 *                           `context` / `seedPrompt` fields.
 *   - `fixtureProps`      → no counterpart. Conformance-gate-only:
 *                           consumed by the registry's runtime probe,
 *                           never sent on the register envelope.
 *   - marketplace identity (`scope`, `name`, `version`, `kind`,
 *     `visibility`) → no counterpart; registry-side only.
 *
 * ## Why no `matchers` field
 *
 * The existing `screen-blueprints/match.ts` matcher operates on the
 * runtime-side `MatchableBlueprint` row (carries `blueprintId`,
 * `serverId`, `dataTools`, `status`) — these are runtime registry
 * artifacts, not authoring-time manifest declarations. The selector
 * for cached-blueprint variants reads {@link BlueprintVariance}
 * (persona + aesthetic + context + seedPrompt), which IS authoring-
 * time information and lives on this manifest under `variance`.
 *
 * If a future authoring-time matchers shape lands in
 * `@ggui-ai/protocol`, add it here under `matchers?:
 * BlueprintMatchers` and reuse the protocol type. Don't redefine it.
 *
 * ## Discriminator
 *
 * The top-level `kind: "blueprint"` literal is the discriminator
 * {@link artifactManifestSchema} uses to narrow between gadget and
 * blueprint manifests. Authors MUST set it.
 *
 * ## Strictness
 *
 * Root + nested objects are strict — unknown keys fail parse. Same
 * loud-feedback posture as the gadget manifest.
 */
import { z } from 'zod';
import {
  type BlueprintVariance,
  type DataContract,
  blueprintVarianceSchema,
  dataContractSchema,
} from '@ggui-ai/protocol';
import {
  ArtifactScopeSchema,
  ArtifactVersionSchema,
  ArtifactVisibilitySchema,
  BLUEPRINT_NAME_RE,
  sharedMetadataShape,
} from './base.js';

/**
 * Blueprint name regex — the same kebab-case rule as gadgets. See
 * {@link BLUEPRINT_NAME_RE} for the rationale.
 */
const BlueprintNameSchema = z.string().min(2).max(64).regex(BLUEPRINT_NAME_RE, {
  message:
    'name must be 2-64 chars matching `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$` (lowercase alphanumerics + hyphens, no underscores, no single-character names).',
});

/**
 * `fixtureProps` is intentionally `unknown` — the conformance gate's
 * runtime probe round-trips it through `JSON.stringify` and feeds it
 * as `props` to the rendered TSX. Any JSON-safe shape rides through;
 * the blueprint's own `contract.propsSchema` (when present) is what
 * actually validates the shape at runtime probe time.
 *
 * `z.unknown()` is permitted here (not `Record<string, unknown>`)
 * because the value is genuinely shape-unknown at THIS layer — only
 * the blueprint's own contract knows what shape its props take.
 */
const fixturePropsSchema = z.unknown();

/**
 * Strict zod schema for `ggui.blueprint.json`. Strict root — unknown
 * keys fail parse. Discriminated on `kind: "blueprint"`.
 *
 * Note: `contract` is intentionally NOT made strict here — it
 * delegates to {@link dataContractSchema} from `@ggui-ai/protocol`,
 * which owns its own strictness posture (and `JsonSchema` body fields
 * are deliberately open).
 */
export const blueprintManifestSchema = z.strictObject({
  // ---- Discriminator ----
  kind: z
    .literal('blueprint')
    .describe(
      'Discriminator — picks the blueprint variant of the artifact-manifest union. MUST be the literal string `"blueprint"`.',
    ),

  // ---- Identity (required) ----
  scope: ArtifactScopeSchema.describe(
    'Blueprint scope. Must start with `@` (e.g. `@my-org`). Disambiguates the `<scope>/<name>` install identifier.',
  ),
  name: BlueprintNameSchema.describe(
    'Blueprint slug. 2-64 chars, `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$` — kebab-case, no underscores, no single-character names. Unified with the gadget naming rule under LOCKED-25 (2026-05-18).',
  ),
  version: ArtifactVersionSchema.describe(
    'SemVer. `MAJOR.MINOR.PATCH` with optional `-pre` / `+build` suffixes. Per-version immutable once published.',
  ),

  // ---- Core blueprint shape (required: source) ----
  source: z
    .string()
    .min(1)
    .describe(
      'TSX source body with a default-exported React component. Maps to `ggui_ops_register_blueprint`’s `componentCode` field; the conformance gate compiles + runtime-probes this string before the registry accepts the upload.',
    ),
  visibility: ArtifactVisibilitySchema.describe(
    'Storage + signing posture. `public` = sigstore-signed, listable; `private` = Ed25519-signed, visible only within publisher org.',
  ),

  // ---- Optional core blueprint shape ----
  contract: dataContractSchema
    .optional()
    .describe(
      "The DataContract envelope this blueprint was designed for. Consumed by the cache-match path to short-circuit cold gen when an agent's contract hash matches. Optional — a blueprint can publish without a contract for cases where the matcher relies on variance + tags only.",
    ),
  fixtureProps: fixturePropsSchema
    .optional()
    .describe(
      "Sample props for the conformance gate's runtime probe. Any JSON-safe shape; validated for top-level required-key shape against `contract.propsSpec.properties` at static gate time and used as the input props on the sandboxed React render in the runtime probe.",
    ),
  variance: blueprintVarianceSchema
    .optional()
    .describe(
      "Persona + aesthetic + context + seedPrompt hints that drive the LLM-driven variant selector when multiple blueprints share a `(appId, contractHash)` group. Mirrors `Blueprint.variance` in `@ggui-ai/protocol`.",
    ),
  intent: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Author intent prose for this blueprint. Semantic matchers embed it alongside the contract summary when ranking reuse candidates; the exact-key match path ignores it. Optional — importers that require intent derive a fallback from `description`/`name` when absent.',
    ),

  // ---- Persistence-contract stamps (mirrors `PortableBlueprint`) ----
  generatorProtocolVersion: z
    .string()
    .min(1)
    .optional()
    .describe(
      'PROTOCOL_VERSION of the toolchain that authored + signed this manifest. Import gates compare it against the importing deployment’s era before admitting the blueprint into a reuse pool — an era mismatch (or a missing stamp) drops the row loudly instead of serving code generated against a different protocol shape. Publishing tools stamp this automatically right before signing; deployments that consume installed blueprints into a matcher pool require it.',
    ),
  toolIdentityCatalogHash: z
    .string()
    .min(1)
    .optional()
    .describe(
      'SHA256(16) of the tool-identity catalog used to canonicalize `contract` at authoring time. Importers re-canonicalize against their own catalog and recompute the key; a divergence means the same intent would mis-key and silently cold-gen, so it is rejected. Optional — most marketplace blueprints are authored without a live tool catalog, which leaves the import gate’s re-key check inert.',
    ),

  // ---- Shared metadata ----
  ...sharedMetadataShape,
});

/**
 * Static TypeScript type derived from {@link blueprintManifestSchema}.
 *
 * Authors writing `ggui.blueprint.json` should
 * `import type { BlueprintManifest } from '@ggui-ai/artifact-manifest'`
 * and let inference flow. The `contract` field is typed `DataContract
 * | undefined` (reuses the protocol type); `variance` is typed
 * `BlueprintVariance | undefined` (also reused).
 */
export type BlueprintManifest = z.infer<typeof blueprintManifestSchema>;

// Verify the manifest TS type actually projects the reused protocol
// types — if a future zod-vs-TS drift slips one of these to `any`,
// the parameter-to-return-type assignments below stop compiling.
// Module-private static checks; the bodies are never invoked.
function _blueprintContractTypeCheck(
  c: DataContract | undefined,
): BlueprintManifest['contract'] {
  return c;
}
function _blueprintVarianceTypeCheck(
  v: BlueprintVariance | undefined,
): BlueprintManifest['variance'] {
  return v;
}
void _blueprintContractTypeCheck;
void _blueprintVarianceTypeCheck;

/**
 * Canonical filename — always at the blueprint repo root, always
 * this name. Exported so tooling uses the constant instead of
 * hard-coding the string.
 */
export const GGUI_BLUEPRINT_JSON_FILENAME = 'ggui.blueprint.json';

/**
 * Parse a raw JSON value into a validated {@link BlueprintManifest}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 *
 * Accepts any `unknown` — callers are expected to have already
 * decoded the JSON (`JSON.parse(source)`).
 */
export function parseBlueprintManifest(raw: unknown): BlueprintManifest {
  return blueprintManifestSchema.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result
 * (`{ success: true, data }` vs `{ success: false, error }`).
 */
export function safeParseBlueprintManifest(
  raw: unknown,
): ReturnType<typeof blueprintManifestSchema.safeParse> {
  return blueprintManifestSchema.safeParse(raw);
}
