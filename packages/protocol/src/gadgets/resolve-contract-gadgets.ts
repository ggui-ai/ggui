/**
 * Contract → descriptor resolution helpers.
 *
 * The wire side (`contract.clientCapabilities.gadgets`) is
 * PACKAGE-KEYED two-level: `Record<package, Record<exportName, …>>`.
 * It carries identity only — `(package, export name)` — never
 * `version` or transport metadata. The operator's `App.gadgets`
 * catalog owns those; `filterDescriptorsToContract` snapshots the
 * referenced subset onto `SessionStackEntry.gadgetDescriptors` as a
 * sidecar.
 */
import type {
  DataContract,
  GadgetDescriptor,
  GadgetExport,
  GadgetUse,
} from '../types/data-contract.js';

/**
 * The export name a {@link GadgetExport} carries — the `hook` field
 * for a hook export, the `component` field for a component export.
 * Discrimination is by field presence; there is no `kind` field. The
 * single accessor so callers never re-spell the field-presence check.
 *
 * Total over the union: it checks BOTH fields explicitly and throws
 * on a malformed member rather than assuming `component` in the else
 * branch (which silently returned `undefined` for a both-fields-
 * absent object). The `GadgetHookExport.component?: never` /
 * `GadgetComponentExport.hook?: never` exclusivity markers (F1) make
 * `hook` / `component` OPTIONAL keys of the opposite member, so `'k' in
 * x` no longer narrows — discrimination is by VALUE presence
 * (`!== undefined`). A future third union member that carries neither
 * field falls through to the throw rather than silently mistyping.
 *
 * Wire-side use records ({@link GadgetUse}) carry the export name as a
 * plain `name` field — no accessor needed there.
 */
export function gadgetExportName(x: GadgetExport): string {
  if (x.hook !== undefined) return x.hook;
  if (x.component !== undefined) return x.component;
  throw new Error(
    'gadgetExportName: malformed GadgetExport — neither hook nor component field present',
  );
}

/**
 * Canonical string key for a gadget EXPORT's identity —
 * `(name, package)`. Every site that decides "does this wire ref
 * resolve to that registered export?" MUST key through this helper so
 * the resolver and the push-time gates (`assertGadgetsRegistered`,
 * `assertPublicEnvSatisfied`) agree byte-for-byte on what "the same
 * gadget export" means.
 *
 * `version` is NOT part of the key — it is not on the wire. An App's
 * `App.gadgets` catalog registers at most one descriptor per package
 * (enforced by the catalog lint), so `(name, package)` resolves to
 * exactly one registered export.
 *
 * The export name is itself kind-disambiguating: `use`-prefixed hook
 * names (`HOOK_NAME_RE`) and PascalCase component names
 * (`COMPONENT_NAME_RE`) are grammar-disjoint, so a hook and a
 * component can never collide on name.
 *
 * Separator `\t`: the hook / component name grammars and
 * `NPM_PACKAGE_NAME_RE` all exclude tab, so no field value can smuggle
 * a separator.
 */
export function gadgetIdentityKey(use: {
  name: string;
  package: string;
}): string {
  return `${use.name}\t${use.package}`;
}

/**
 * Flatten the package-keyed `contract.clientCapabilities.gadgets` into
 * a list of `(package, name)` use records — one per export the
 * contract references. The single accessor every consumer (push
 * gates, descriptor resolver, code-gen) iterates, so the nested wire
 * shape is walked in exactly one place.
 *
 * Returns an empty array when the contract declares no
 * `clientCapabilities.gadgets`. Pure function. No I/O.
 */
export function listContractGadgets(
  contract: DataContract,
): readonly GadgetUse[] {
  const declared = contract.clientCapabilities?.gadgets;
  if (!declared) return [];
  const out: GadgetUse[] = [];
  for (const [pkg, exports] of Object.entries(declared)) {
    for (const [name, meta] of Object.entries(exports)) {
      out.push({
        package: pkg,
        name,
        ...(meta.description !== undefined
          ? { description: meta.description }
          : {}),
        ...(meta.usage !== undefined ? { usage: meta.usage } : {}),
      });
    }
  }
  return out;
}

/**
 * Given a wire-side {@link DataContract} and the operator's
 * `App.gadgets` catalog, return the subset of package descriptors the
 * contract references via `clientCapabilities.gadgets`.
 *
 * Matching key is the npm PACKAGE name — the wire map's own key. A
 * descriptor IS a package, and `App.gadgets` registers at most one
 * descriptor per package, so a package key resolves to exactly one
 * descriptor. The filtered list lands as a sidecar on
 * `SessionStackEntry.gadgetDescriptors`.
 *
 * Ordering: descriptors appear in the order their package key first
 * appears on `clientCapabilities.gadgets`. A package absent from
 * `appGadgets` is dropped — the push-time `assertGadgetsRegistered`
 * gate rejects the push with a precise registration-mismatch code
 * BEFORE this helper runs, so silent drop here is safe in the happy
 * path.
 *
 * Pure function. No I/O. Returns an empty array when the contract has
 * no `clientCapabilities.gadgets`, `appGadgets` is empty, or no
 * package resolves to a registered descriptor.
 */
export function filterDescriptorsToContract(
  contract: DataContract,
  appGadgets: readonly GadgetDescriptor[],
): readonly GadgetDescriptor[] {
  const declared = contract.clientCapabilities?.gadgets;
  if (!declared || appGadgets.length === 0) {
    return [];
  }

  const byPackage = new Map<string, GadgetDescriptor>();
  for (const descriptor of appGadgets) {
    byPackage.set(descriptor.package, descriptor);
  }

  const out: GadgetDescriptor[] = [];
  for (const pkg of Object.keys(declared)) {
    const descriptor = byPackage.get(pkg);
    if (descriptor) out.push(descriptor);
  }
  return out;
}
