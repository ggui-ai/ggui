/**
 * `manifestToRegistryEntry` — project a parsed `ggui.gadget.json`
 * manifest into a `GadgetDescriptor` suitable for `ggui.json#app.gadgets`.
 *
 * The translation lives next to the manifest schema so the CLI's
 * install path and any future programmatic consumer both call one
 * function, keeping the field-by-field projection in sync with the
 * manifest schema as fields are added or removed.
 *
 * Output is shape-equivalent to `strictGadgetDescriptorSchema`'s
 * accepted input — round-trip is validated in the companion test
 * file (`manifest-to-registry-entry.test.ts`).
 *
 * @param manifest — parsed gadget manifest (kind: 'gadget'). The
 *   parser already validated `description` / `usage` / `example` are
 *   present, so the helper passes them through verbatim.
 * @param computedFields — fields the registry/CLI computes at install
 *   time and stamps onto the entry: `version` from the registry
 *   metadata row, optionally `bundleUrl` (full URL escape hatch) and
 *   `bundleSri` (SRI emitted by the publish Lambda). Absent =
 *   bundleHost/package-driven resolution.
 */
import type { GadgetDescriptor, GadgetExport } from '@ggui-ai/protocol';
import type { GadgetManifest } from './gadget-manifest.js';

export interface ManifestToRegistryEntryFields {
  /** Version stamped on the entry. Comes from the registry-side
   *  `ArtifactVersionRow.version` for installed gadgets; the install
   *  CLI propagates it down. */
  readonly version: string;
  /** Full bundle URL. Present when the publish Lambda has stamped a
   *  reachable URL on the version row (the common case). Absent when
   *  the operator wants to compose from `bundleHost` at push time. */
  readonly bundleUrl?: string;
  /** SRI hash emitted by the publish Lambda. Threaded through to the
   *  iframe-runtime's `<script integrity>` attribute. */
  readonly bundleSri?: string;
  /** Operator-facing bundleHost override. When set, the server's
   *  `resolveGadgetUrls` resolver composes the URL at push time
   *  instead of using `bundleUrl` directly. */
  readonly bundleHost?: string;
}

export function manifestToRegistryEntry(
  manifest: GadgetManifest,
  computedFields: ManifestToRegistryEntryFields,
): GadgetDescriptor {
  // Project each manifest export into its descriptor export. Exports
  // are discriminated by field presence (`hook` vs `component`) — no
  // `kind` field. The manifest's per-export teaching text
  // (`description` / `usage` / `example` / `gotchas`) passes through
  // verbatim — the manifest parser already validated the required
  // trio is present.
  const exportEntries: GadgetExport[] = manifest.exports.map((entry) => {
    const teaching = {
      description: entry.description,
      usage: entry.usage,
      example: entry.example,
      ...(entry.gotchas !== undefined ? { gotchas: entry.gotchas } : {}),
    };
    return 'hook' in entry
      ? { hook: entry.hook, ...teaching }
      : { component: entry.component, ...teaching };
  });

  return {
    exports: exportEntries,
    // Assemble the npm-style `package` from the manifest's separate
    // `scope` + `name` fields. The descriptor surface is
    // registry-agnostic (only the bare package name lives here;
    // registry hostname rides on `bundleHost` / `bundleUrl`).
    package: `${manifest.scope}/${manifest.name}`,
    version: computedFields.version,
    ...(computedFields.bundleUrl !== undefined
      ? { bundleUrl: computedFields.bundleUrl }
      : {}),
    ...(computedFields.bundleSri !== undefined
      ? { bundleSri: computedFields.bundleSri }
      : {}),
    ...(computedFields.bundleHost !== undefined
      ? { bundleHost: computedFields.bundleHost }
      : {}),
    ...(manifest.connect !== undefined ? { connect: manifest.connect } : {}),
    ...(manifest.requires !== undefined ? { requires: manifest.requires } : {}),
  };
}
