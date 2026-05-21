/**
 * `@ggui-ai/artifact-manifest` — root barrel.
 *
 * Strict zod schemas + helpers for parsing the two ggui marketplace
 * artifact manifests:
 *
 *   - `ggui.gadget.json`    — gadget bundles.
 *   - `ggui.blueprint.json` — cached UI blueprints (TSX + contract).
 *
 * Plus a discriminated union (`artifactManifestSchema`) over both
 * kinds for tooling that handles them generically (signing, registry
 * upload, search-index ingestion).
 *
 * Browser-safe (no Node dependencies) — pure schema + parsers.
 */

// Gadget manifest — narrow surface.
export {
  GGUI_GADGET_JSON_FILENAME,
  assertGadgetManifestValid,
  parseGadgetManifest,
  gadgetManifestSchema,
  gadgetExportSchema,
  safeParseGadgetManifest,
} from './gadget-manifest.js';
export type { GadgetManifest } from './gadget-manifest.js';

// Blueprint manifest — narrow surface.
export {
  GGUI_BLUEPRINT_JSON_FILENAME,
  assertBlueprintManifestValid,
  blueprintManifestSchema,
  parseBlueprintManifest,
  safeParseBlueprintManifest,
} from './blueprint-manifest.js';
export type { BlueprintManifest } from './blueprint-manifest.js';

// Discriminated union — top-level surface.
export {
  artifactManifestSchema,
  assertArtifactManifestValid,
  parseArtifactManifest,
  safeParseArtifactManifest,
} from './artifact-manifest.js';
export type { ArtifactManifest } from './artifact-manifest.js';

// Shared name regexes — a single kebab-case rule unified across
// gadget and blueprint kinds. External callers (registry tooling,
// ops tools) import these instead of re-defining the regex inline so
// the slug rule has a single source of truth. Install/uninstall flows
// import `ArtifactScopeSchema` + `ArtifactVersionSchema` for wire-arg
// validation; reuse keeps the CLI and registry-side validation on a
// single regex source.
export {
  GADGET_NAME_RE,
  BLUEPRINT_NAME_RE,
  ArtifactScopeSchema,
  ArtifactVersionSchema,
} from './base.js';

// Manifest → registry-entry translator. The install CLI, programmatic
// publish flows, and any future register-by-manifest tool all go
// through this one function. Round-trip validated in the companion
// test file.
export {
  manifestToRegistryEntry,
  type ManifestToRegistryEntryFields,
} from './manifest-to-registry-entry.js';
