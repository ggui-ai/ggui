/**
 * Shared identity + metadata building blocks across every artifact-manifest
 * kind. The discriminated union of {@link GadgetManifest} and {@link
 * BlueprintManifest} each extend these — keeping scope/name/version/author
 * regexes in one place so a future widening (e.g. accepting four-segment
 * scopes) lands once and propagates uniformly.
 *
 * No discriminator field lives here — `kind` is intentionally per-variant
 * so zod's `z.discriminatedUnion("kind", […])` can narrow on the literal.
 */
import { z } from 'zod';

/**
 * Artifact scope — an npm-style organizational namespace. MUST start
 * with `@` and contain only lowercase alphanumerics + hyphens after
 * the leading `@`. Examples: `@ggui-ai`, `@my-org`, `@example-org`.
 *
 * The `@` prefix is what disambiguates `scope` from `name` in the
 * `<scope>/<name>` identifier — a scope without `@` is ambiguous
 * with a non-scoped artifact name.
 *
 * Shared between {@link GadgetManifest} and {@link BlueprintManifest};
 * both kinds publish under the same `<scope>/<name>@<version>` install
 * identifier so the marketplace search surface and signing trust chain
 * stay symmetric.
 */
export const ArtifactScopeSchema = z
  .string()
  .regex(/^@[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, {
    message:
      'scope must start with `@` followed by lowercase alphanumerics + hyphens (2-64 chars total, no leading/trailing hyphen after `@`).',
  });

/**
 * Artifact name regex — kebab-case for both gadgets and blueprints.
 * 2-64 chars, starts + ends with `[a-z0-9]`, hyphens allowed in the
 * middle, no underscores, no single-character names.
 *
 * Gadgets and blueprints share this one rule. Underscored blueprint
 * slugs (`weather_card_v2`) must be renamed with hyphens, and
 * single-letter slugs must pick a longer name.
 */
export const GADGET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/**
 * Blueprint-kind name regex — the same kebab-case rule as gadgets.
 * Re-export of {@link GADGET_NAME_RE} kept as a named symbol so
 * callers that read the blueprint-specific name stay self-documenting
 * at the call site.
 */
export const BLUEPRINT_NAME_RE = GADGET_NAME_RE;

/**
 * SemVer with optional pre-release / build metadata. Matches the
 * subset npm + sigstore both accept: `MAJOR.MINOR.PATCH` with
 * optional `-PRE` and `+BUILD` suffixes per semver.org BNF.
 *
 * Mirrors the practical npm-publish regex (loose enough to accept
 * `1.0.0-alpha.1+build.123`, strict enough to reject `1.0`,
 * `v1.0.0`, leading zeros).
 */
export const ArtifactVersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    {
      message:
        'version must be valid semver (MAJOR.MINOR.PATCH with optional `-pre` / `+build`).',
    },
  );

/**
 * Visibility — controls how the artifact is stored + distributed:
 *
 *   - `public`  — sigstore-signed, served from S3 `public/` prefix,
 *                 publicly listable via `/search`.
 *   - `private` — Ed25519-signed, served from `private/<orgId>/`
 *                 with signed CloudFront URLs, only visible to the
 *                 publisher's Cognito org.
 *
 * Both paths land in the same registry stack; the visibility flag
 * picks the signing trust chain + S3 prefix at publish time. No
 * "internal" / "team" third option in MVP.
 */
export const ArtifactVisibilitySchema = z.enum(['public', 'private']);

/**
 * Artifact author metadata — purely informational, surfaced on the
 * registry web UI and `ggui search` output. `name` required so a
 * descriptor that declares an author always has something to render;
 * `email` / `url` optional.
 */
export const ArtifactAuthorSchema = z.strictObject({
  name: z.string().min(1).max(200),
  email: z
    .email({ message: 'author.email must be a valid email address' })
    .optional(),
  url: z
    .url({ message: 'author.url must be a valid http(s) URL' })
    .optional(),
});

/**
 * Optional metadata fields shared by every artifact kind. Lifted out
 * of the per-kind schemas via spread so the variant schemas stay
 * focused on their distinguishing fields.
 */
export const sharedMetadataShape = {
  description: z
    .string()
    .min(1)
    .max(280)
    .optional()
    .describe(
      'One-line artifact description shown on registry UI + `ggui search` output. Required at registry-side once published (the publish CLI promotes it to the registry descriptor where it becomes mandatory).',
    ),
  // Caps protect the index size and the wire payload size. 20 entries
  // × 64 chars covers every realistic tagging vocabulary while
  // bounding worst-case spam. The charset `[a-z0-9-]` keeps the
  // publish CLI's case-folding + URL-encoding round-trips
  // deterministic.
  tags: z
    .array(
      z
        .string()
        .min(1)
        .max(64)
        .regex(
          /^[a-z0-9-]+$/,
          'tag must be lowercase alphanumeric with hyphens only',
        ),
    )
    .max(20, { message: 'at most 20 tags per artifact' })
    .readonly()
    .optional()
    .describe(
      'Free-form tags for `/search?tag=` filtering. Lowercased + deduplicated server-side. Max 20 tags, 64 chars each, charset `[a-z0-9-]`.',
    ),
  author: ArtifactAuthorSchema.optional().describe(
    'Author metadata surfaced on registry UI. All subfields except `name` are optional.',
  ),
  license: z
    .string()
    .min(1)
    .optional()
    .describe(
      'SPDX license identifier (e.g. `Apache-2.0`, `MIT`). Validated as a non-empty string at this layer; SPDX-membership validation is a publish-time concern.',
    ),
  homepage: z
    .url({ message: 'homepage must be a valid http(s) URL' })
    .optional()
    .describe('Project homepage / docs URL. Linkified on registry UI.'),
} as const;
