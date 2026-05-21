/**
 * Top-level artifact-manifest discriminated union.
 *
 * The marketplace registry hosts two kinds of artifacts:
 *
 *   - **gadgets** (`ggui.gadget.json`) — wrapper code bundles
 *     (Leaflet, Mapbox, …) published as gadgets.
 *   - **blueprints** (`ggui.blueprint.json`) — cached UI blueprints
 *     (TSX source + DataContract + variance tags).
 *
 * Both ship under the same `<scope>/<name>@<version>` identifier
 * scheme, the same sigstore/Ed25519 dual-signing model, and the
 * same per-env-isolated registry stack. The DIFFERENCE is the per-
 * kind authoring shape, which this module unifies under one
 * `z.discriminatedUnion("kind", […])` so tooling that doesn't care
 * which kind it has (e.g. signature verification, registry upload,
 * search-index ingestion) can parse once and dispatch later.
 *
 * Re-exports the per-kind schemas as well so callers that DO care
 * about a specific kind can use the narrower parsers without dipping
 * into the union.
 */
import { z } from 'zod';
import { gadgetManifestSchema, type GadgetManifest } from './gadget-manifest.js';
import {
  blueprintManifestSchema,
  type BlueprintManifest,
} from './blueprint-manifest.js';

/**
 * Discriminated union over every artifact kind the registry accepts.
 * Narrowing is driven by the `kind` literal (`"gadget"` | `"blueprint"`).
 *
 * Strict-object posture inherited from the per-kind schemas: unknown
 * top-level keys fail parse with a clear path. An unknown `kind`
 * value yields a `discriminator`-issue at `path: ["kind"]`, which is
 * the cleanest possible failure mode for a misspelled manifest.
 */
export const artifactManifestSchema = z.discriminatedUnion('kind', [
  gadgetManifestSchema,
  blueprintManifestSchema,
]);

/**
 * Static TypeScript type derived from {@link artifactManifestSchema}.
 *
 * Authors writing tooling that handles both kinds should
 * `import type { ArtifactManifest } from '@ggui-ai/artifact-manifest'`
 * and narrow via `manifest.kind === 'gadget' | 'blueprint'`.
 */
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

// Sanity: the union TS type IS the union of the two per-kind types.
// If a future refactor smuggles a non-GadgetManifest|BlueprintManifest
// into the schema, the function-parameter assignment below stops
// compiling. Module-private static check; the body is never invoked.
function _artifactUnionTypeCheck(
  union: GadgetManifest | BlueprintManifest,
): ArtifactManifest {
  return union;
}
void _artifactUnionTypeCheck;

/**
 * Parse a raw JSON value into a validated {@link ArtifactManifest}.
 * Throws a `ZodError` with human-readable issues on invalid input,
 * including unknown / missing `kind` discriminator at `path: ["kind"]`.
 */
export function parseArtifactManifest(raw: unknown): ArtifactManifest {
  return artifactManifestSchema.parse(raw);
}

/**
 * Assertion helper — narrows `raw` to {@link ArtifactManifest} on
 * success, throws `ZodError` on failure.
 */
export function assertArtifactManifestValid(
  raw: unknown,
): asserts raw is ArtifactManifest {
  artifactManifestSchema.parse(raw);
}

/**
 * Safe-parse variant — returns a `z.safeParse` result. Prefer this
 * inside CLI tooling where you want to render the issue list without
 * try/catch.
 */
export function safeParseArtifactManifest(
  raw: unknown,
): ReturnType<typeof artifactManifestSchema.safeParse> {
  return artifactManifestSchema.safeParse(raw);
}
