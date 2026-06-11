/**
 * `ggui.gadget.json` — author-side manifest for ggui gadgets
 * published to the marketplace.
 *
 * Lives at the root of a gadget author's repo (one repo = one gadget).
 * `ggui publish` reads this file, builds the bundle, runs the local
 * conformance gate, then uploads bundle + sig + descriptor to the
 * resolved registry. End-users install via `ggui install
 * <scope/name@version>` which appends to their app's
 * `ggui.json#app.gadgets`.
 *
 * ## Relationship to `strictGadgetDescriptorSchema`
 *
 * The registry-side `strictGadgetDescriptorSchema` (in
 * `@ggui-ai/protocol`) describes what a wrapper looks like *after* it
 * has been registered (it carries `package` / `bundleUrl` / etc — the
 * fetchable shape). This author-side manifest describes what a wrapper
 * looks like *before* publish (build-config + identity + signing
 * posture). Field semantics agree where they overlap:
 *
 *   | Field         | author manifest        | registry entry           |
 *   |---------------|------------------------|--------------------------|
 *   | `scope`       | required (`@org`)      | implicit in entry key    |
 *   | `name`        | required (kebab-case)  | implicit in entry key    |
 *   | `version`     | required (semver)      | required                 |
 *   | `exports[]`   | required (≥1)          | required (`exports[]`)   |
 *   | `description` | required (pkg summary) | REQUIRED at registry     |
 *   | `requires[]`  | `GGUI_PUBLIC_APP_*`    | same regex (locked)      |
 *   | `connect[]`   | URL allowlist          | same shape (`string[]`)  |
 *   | `bundle`      | source entry path      | replaced by `bundleUrl`  |
 *   | `style`       | source entry path      | replaced by `styleUrl`   |
 *   | `visibility`  | required (pub/priv)    | not on registry entry    |
 *   | `peerDeps`    | conformance allowlist  | not on registry entry    |
 *
 * The schemas are deliberately separate — manifest carries build
 * config, registry entry carries fetch URLs. The publish flow
 * translates one into the other. Don't import `registryGadget
 * EntrySchema` and extend it; the shapes overlap but are not subset/
 * superset.
 *
 * ## Discriminator
 *
 * The top-level `kind: "gadget"` literal is the discriminator that
 * lets {@link artifactManifestSchema} narrow between gadget and
 * blueprint manifests. Authors MUST set it; the schema rejects
 * absent or misspelled `kind` with a clear path-`["kind"]` issue.
 *
 * ## Strictness
 *
 * Root + nested objects are strict — unknown keys fail parse. This is
 * the gadget author's first feedback surface; typos in
 * `ggui.gadget.json` should fail loud, not silently get ignored at
 * publish time.
 */
import { z } from 'zod';
import {
  BUNDLE_HOST_RE,
  gadgetRequiresSchema,
  jsonValueSchema,
} from '@ggui-ai/protocol';
import {
  ArtifactScopeSchema,
  ArtifactVersionSchema,
  ArtifactVisibilitySchema,
  GADGET_NAME_RE,
  sharedMetadataShape,
} from './base.js';

/**
 * Gadget name — kebab-case identifier without scope prefix. The
 * scope lives on its own field. Examples: `weather-card`, `leaflet`,
 * `mapbox`. A leading `@` is rejected to catch scope/name conflation
 * at parse time.
 */
const GadgetNameSchema = z.string().regex(GADGET_NAME_RE, {
  message:
    'name must be kebab-case (lowercase alphanumerics + hyphens, 2-64 chars, no leading/trailing hyphen, no `@` prefix — scope is a separate field).',
});

/**
 * `connect[]` — wire-time URL allowlist a wrapper hook may speak to.
 * Mirrors the existing `gadgetDescriptorSchema.connect` shape
 * (`string[]`, optional, readonly). Surfaced into the iframe CSP
 * `connect-src` at runtime so a Leaflet/Mapbox wrapper's `fetch()`
 * to its tile server is permitted while everything else is denied.
 *
 * Kept as a free-form `string[]` (not a discriminated `ConnectSpec`
 * union) for parity with the protocol-side schema — the protocol
 * doesn't carry per-entry metadata today, so the manifest doesn't
 * either. Future additive: widen to
 * `string | { url, methods?, headers? }` under the same field name.
 */
const GadgetConnectSchema = z.array(z.string().min(1)).readonly();

/**
 * Hook-name grammar — `use`-prefixed camelCase. Mirrors the protocol's
 * `HOOK_NAME_RE`; kept local so the manifest layer stays free of an
 * import dependency on a protocol regex that could drift silently.
 */
const MANIFEST_HOOK_NAME_RE = /^use[A-Z][A-Za-z0-9]*$/;

/**
 * Component-name grammar — PascalCase. Mirrors the protocol's
 * `COMPONENT_NAME_RE`. Same local-copy rationale as the hook regex.
 */
const MANIFEST_COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Per-export teaching fields shared by every {@link gadgetExportSchema}
 * variant. These four mirror `strictGadgetExportSchema` in
 * `@ggui-ai/protocol`: `description` / `usage` / `example` are
 * REQUIRED at the registry side because the LLM uses them at code-gen
 * time; `gotchas` is optional. Authoring them in the manifest means
 * the gadget author owns the prose the LLM sees.
 */
const exportTeachingShape = {
  description: z
    .string()
    .min(1)
    .max(280)
    .describe(
      'One-line summary of this export, surfaced on registry UI + `ggui search`. Required (the registry-side parser rejects exports without it).',
    ),
  usage: z
    .string()
    .min(1)
    .describe(
      'Free-form LLM-targeted prose — the "context-of-use" hint that bare `description` lacks. Tells the code-gen model when + why to reach for this export.',
    ),
  example: jsonValueSchema.describe(
    'Concrete usage example for boilerplate generation and prompt priming. Free-form `JsonValue` (typically an object describing call/render shape + expected return).',
  ),
  gotchas: z
    .string()
    .optional()
    .describe(
      'Anti-patterns + known traps surfaced in code-gen prompts so the LLM dodges the same issues every time.',
    ),
} as const;

/**
 * One export of a gadget package — a hook or a component. Mirrors the
 * protocol's `GadgetExport` shape: a gadget package bundles ≥1 of
 * these behind a single npm identity. There is no `kind` field —
 * discrimination is by field presence: a `hook` key (`use`-prefixed
 * name) marks a hook, a `component` key (PascalCase name) marks a
 * component.
 */
export const gadgetExportSchema = z.union([
  z.strictObject({
    hook: z
      .string()
      .regex(MANIFEST_HOOK_NAME_RE, {
        message:
          'hook must be `use`-prefixed camelCase (e.g. `useLeafletMap`).',
      })
      .describe(
        'Exported hook name (e.g. `useLeafletMap`). The conformance gate at publish time AST-walks the bundle and verifies a matching named export exists.',
      ),
    ...exportTeachingShape,
  }),
  z.strictObject({
    component: z
      .string()
      .regex(MANIFEST_COMPONENT_NAME_RE, {
        message: 'component must be PascalCase (e.g. `MapView`).',
      })
      .describe(
        'Exported component name (e.g. `MapView`). The conformance gate at publish time AST-walks the bundle and verifies a matching named export exists.',
      ),
    ...exportTeachingShape,
  }),
]);

/**
 * Strict zod schema for `ggui.gadget.json`. Strict root + nested
 * objects — unknown keys fail parse. Discriminated on `kind:
 * "gadget"`.
 */
export const gadgetManifestSchema = z.strictObject({
  // ---- Discriminator ----
  kind: z
    .literal('gadget')
    .describe(
      'Discriminator — picks the gadget variant of the artifact-manifest union. MUST be the literal string `"gadget"`.',
    ),

  // ---- Identity (required) ----
  scope: ArtifactScopeSchema.describe(
    'Gadget scope. Must start with `@` (e.g. `@my-org`). Disambiguates the `<scope>/<name>` install identifier.',
  ),
  name: GadgetNameSchema.describe(
    'Gadget name (kebab-case, no `@` prefix — scope is a separate field). Combined with `scope` to form the install identifier `@scope/name@version`.',
  ),
  version: ArtifactVersionSchema.describe(
    'SemVer. `MAJOR.MINOR.PATCH` with optional `-pre` / `+build` suffixes. Per-version immutable once published.',
  ),

  // ---- Compatibility (required) ----
  // GG.8.1 — a gadget manifest describes a PACKAGE: ≥1 hook/component
  // exports behind a single npm identity + bundle. The conformance
  // gate at publish time AST-walks the bundle and verifies every
  // declared export name resolves to a matching named export.
  exports: z
    .array(gadgetExportSchema)
    .min(1, { message: 'a gadget package must declare at least one export.' })
    .describe(
      'The exports this gadget package provides — hooks and/or components. At least one. Each carries its own field-presence-discriminated identifier (`hook` for a hook export, `component` for a component export) plus the LLM-targeted teaching text (`description` / `usage` / `example` / `gotchas`) the code-gen model uses.',
    ),
  bundle: z
    .string()
    .min(1)
    .describe(
      'Entry path (relative to the manifest) the build picks up. Typically `src/index.ts`. The publish CLI invokes esbuild against this entry.',
    ),
  visibility: ArtifactVisibilitySchema.describe(
    'Storage + signing posture. `public` = sigstore-signed, listable; `private` = Ed25519-signed, visible only within publisher org.',
  ),

  // ---- Package-level summary (required) ----
  // Distinct from per-export teaching text: this is the one-line
  // PACKAGE summary surfaced on registry UI + `ggui search`. Per-
  // export prose lives on each `exports[*]` entry above.
  description: z
    .string()
    .min(1)
    .max(280)
    .describe(
      'One-line summary of the gadget PACKAGE surfaced on registry UI + `ggui search` output. Required (registry-side parser rejects entries without it). Per-export teaching text lives on `exports[*]`.',
    ),

  // ---- Optional build / runtime config ----
  style: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional CSS entry (relative to the manifest). When present, esbuild emits a sibling stylesheet whose URL becomes the registered wrapper's `styleUrl`.",
    ),
  /**
   * `requires` — App-side public-env keys the wrapper needs to
   * function. Each entry MUST match `GGUI_PUBLIC_APP_*`. The shared
   * `gadgetRequiresSchema` from `@ggui-ai/protocol` is the single
   * source of truth for this constraint.
   */
  requires: gadgetRequiresSchema
    .optional()
    .describe(
      "App-side public-env keys this wrapper reads via `getPublicEnv()`. Each entry MUST match `^GGUI_PUBLIC_APP_[A-Z0-9_]+$`. The install CLI prompts the user for any required key that's not yet set on `ggui.json#app.publicEnv`.",
    ),
  peerDeps: z
    .record(z.string().min(1), z.string().min(1))
    .optional()
    .describe(
      "Gadget's peer-dep allowlist — what the AST conformance gate permits as `import` sources from inside the bundle. Maps package name → semver range (npm-style). `react` + `@ggui-ai/gadgets` are always allowed implicitly; everything else must be declared here or the conformance gate rejects.",
    ),

  // ---- Optional bundle-host default ----
  /**
   * Author-default registry hostname the wrapper publishes to. Forms
   * the third tier of bundleHost resolution at push time:
   *
   *   1. operator's `app.gadgets[*].bundleUrl` (full URL, escape hatch)
   *   2. operator's `app.gadgets[*].bundleHost` (override)
   *   3. THIS field — gadget author's default
   *   4. spec default `registry.ggui.ai`
   *
   * Most wrappers omit this (they publish to the default registry,
   * and the spec default covers them). Set this only when the wrapper ships
   * via a non-default registry (private org registry, sandbox-only
   * fixture, …). The operator override remains the right knob for
   * sandbox-vs-prod swaps.
   *
   * Hostname-only — no scheme, no path. Validated via
   * {@link BUNDLE_HOST_RE} in `@ggui-ai/protocol`.
   */
  bundleHost: z
    .string()
    .regex(BUNDLE_HOST_RE)
    .optional()
    .describe(
      "Optional author-default registry hostname (no scheme, no path). The server prepends `https://` and appends `/bundles/<scope>/<name>/<version>/{bundle.js,style.css}` at push time. Omit to inherit the spec default (`registry.ggui.ai`). Operators can override per-gadget via `ggui.json#app.gadgets[*].bundleHost`.",
    ),

  // ---- Shared metadata ----
  // `description` is intentionally NOT spread from here — gadgets
  // require it (declared above) while blueprints inherit the
  // sharedMetadataShape optional. Spreading the optional would
  // clobber the required redeclaration.
  ...(() => {
    const { description: _drop, ...rest } = sharedMetadataShape;
    void _drop;
    return rest;
  })(),

  // ---- Optional wire allowlist (mirrors gadgetEntry.connect) ----
  connect: GadgetConnectSchema.optional().describe(
    "URLs the wrapper's runtime may speak to. Merged into the iframe CSP `connect-src` at boot. Shape mirrors `gadgetDescriptorSchema.connect` in `@ggui-ai/protocol` — a flat readonly string list.",
  ),
});

/**
 * Static TypeScript type derived from {@link gadgetManifestSchema}.
 *
 * Authors writing `ggui.gadget.json` should `import type {
 * GadgetManifest } from '@ggui-ai/artifact-manifest'` and let the
 * inference flow.
 */
export type GadgetManifest = z.infer<typeof gadgetManifestSchema>;

/**
 * Canonical filename — always at the gadget repo root, always this
 * name. Exported so tooling uses the constant instead of hard-coding
 * the string.
 */
export const GGUI_GADGET_JSON_FILENAME = 'ggui.gadget.json';

/**
 * Parse a raw JSON value into a validated {@link GadgetManifest}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 *
 * Accepts any `unknown` — callers are expected to have already
 * decoded the JSON (`JSON.parse(source)`).
 */
export function parseGadgetManifest(raw: unknown): GadgetManifest {
  return gadgetManifestSchema.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result
 * (`{ success: true, data }` vs `{ success: false, error }`). Prefer
 * this inside CLI tooling where you want to render the issue list
 * without try/catch.
 */
export function safeParseGadgetManifest(
  raw: unknown,
): ReturnType<typeof gadgetManifestSchema.safeParse> {
  return gadgetManifestSchema.safeParse(raw);
}
