/**
 * `assertGadgetsRegistered` — push/ops registry-membership gate.
 *
 * Contracts declare `clientCapabilities.gadgets` package-keyed
 * two-level: `{ <package>: { <exportName>: {…} } }`. Each referenced
 * `(package, exportName)` pair MUST resolve to an export registered in
 * `App.gadgets` (the operator-controlled per-app catalog).
 *
 * Why a server-side gate: the contract schema is permissive enough
 * that an LLM-hallucinated `useDoorDashCheckout` export on an app that
 * never registered it would commit a stack item the boilerplate
 * generator can't import — the iframe fails at runtime with an opaque
 * "Cannot find module" instead of a recoverable author-time error.
 *
 * Validator behavior:
 *   - Pure function, no I/O.
 *   - Walks every `(package, exportName)` the contract references.
 *   - Each MUST match a registered export by the `(name, package)`
 *     identity. `version` is NOT on the wire — `App.gadgets` owns the
 *     version pin, and the catalog lint enforces one descriptor per
 *     package, so `(name, package)` resolves to exactly one export.
 *
 * Precise reject codes — a miss is not one opaque
 * `gadget_not_registered`; the gate classifies *why* the reference
 * failed and throws the most fundamental category first:
 *
 *   1. {@link GadgetNotRegisteredError} (`gadget_not_registered`) —
 *      the export name itself is absent from `App.gadgets`. Carries a
 *      did-you-mean suggestion (Levenshtein < 3).
 *   2. {@link GadgetPackageMismatchError} (`gadget_package_mismatch`)
 *      — the export name IS registered, but only under a different
 *      package than the contract requested. Carries every registered
 *      package for that export name.
 *
 * Priority order matters: a contract that gets the export name wrong
 * can't meaningfully be told "wrong package" — the author needs the
 * most upstream cause. Same-category misses aggregate into one error.
 * When a single push spans BOTH categories, the thrown error is the
 * most-fundamental one but also carries (and lists) the lower-priority
 * misses via `secondary` — so the author fixes everything in one round
 * trip instead of discovering each category on a separate re-push.
 *
 * (`version` carried no third category here any more — it is resolved
 * from `App.gadgets`, never authored on the wire, so there is nothing
 * to mismatch.)
 *
 * Call sites:
 *   - `push.ts` — author-time gate; throws before mutating state.
 *   - `ops-blueprint/register.ts` — pre-persist gate.
 *   - `ops-blueprint/generate.ts` — pre-LLM-dispatch gate.
 *
 * Skipped when the bound deps don't supply an `appGadgets` list
 * (e.g., a deployment with no app registry). Graceful degrade — the
 * check only runs when the operator has wired the registry seam.
 */

import {
  filterDescriptorsToContract,
  gadgetExportName,
  gadgetIdentityKey,
  listContractGadgets,
  type DataContract,
  type GadgetDescriptor,
} from '@ggui-ai/protocol';
import { levenshtein } from '../ops-blueprint/persona-normalization.js';

// Re-export the canonical resolver. The previous
// `enrichContractGadgets` (which overlaid descriptors onto the
// contract) is retired — the wire stays the wire; descriptors land
// on `Render.gadgetDescriptors` as a sidecar. Keeps the
// existing `from '../session-mutations/assert-gadgets'` import path
// stable for downstream callers.
export { filterDescriptorsToContract };

/**
 * One contract reference whose export name is absent from
 * `App.gadgets`.
 */
export interface UnregisteredHookEntry {
  /** The unregistered export name (hook or component). */
  readonly hook: string;
  /** The package the contract referenced it under. */
  readonly package: string;
  /** Closest registered export name (Levenshtein < 3), or `null`. */
  readonly suggestion: string | null;
}

/**
 * One contract reference whose export name IS registered, but only
 * under a different package than the contract requested.
 */
export interface PackageMismatchEntry {
  /** The export name (registered — just under another package). */
  readonly hook: string;
  /** The package the contract requested. */
  readonly requestedPackage: string;
  /** Every package registered for this export name. */
  readonly registered: readonly string[];
}

/**
 * Render the "also failing" message tail listing the lower-priority
 * package misses, so a multi-category push surfaces every violation in
 * one rejection. Empty string when there is nothing else to report.
 */
function renderSecondaryTail(
  packageMismatches: readonly PackageMismatchEntry[],
): string {
  if (packageMismatches.length === 0) return '';
  const lines = packageMismatches.map(
    (m) =>
      `  - [gadget_package_mismatch] export \`${m.hook}\` requested under \`${m.requestedPackage}\``,
  );
  return `\n\nThis push ALSO has gadget refs failing other checks — fix these in the same pass to avoid a repeat rejection:\n${lines.join(
    '\n',
  )}`;
}

/**
 * Thrown when {@link assertGadgetsRegistered} finds at least one
 * `clientCapabilities.gadgets` export name that is not present at all
 * in the bound `App.gadgets` catalog.
 *
 * This is the most fundamental miss class — the export name itself is
 * unknown. The error message lists every unregistered export and
 * (when a close match exists) emits a "did you mean…?" suggestion.
 *
 * When the same push also carries package misses, they ride on
 * {@link secondary} (and the message) so the author can fix everything
 * before re-pushing.
 *
 * Recovery for the author: register the missing gadget in
 * `ggui.json#app.gadgets` (or via the operator's registration tool),
 * or drop the reference from the contract.
 */
export class GadgetNotRegisteredError extends Error {
  readonly code = 'gadget_not_registered' as const;
  readonly unregistered: readonly UnregisteredHookEntry[];
  /**
   * Lower-priority misses on the same push. Present only when this
   * push also has package mismatches.
   */
  readonly secondary?: {
    readonly packageMismatches: readonly PackageMismatchEntry[];
  };
  constructor(
    unregistered: readonly UnregisteredHookEntry[],
    secondary?: {
      readonly packageMismatches: readonly PackageMismatchEntry[];
    },
  ) {
    const lines = unregistered.map((u) => {
      const tail =
        u.suggestion !== null ? ` — did you mean \`${u.suggestion}\`?` : '';
      return `  - \`${u.package}\` exports \`${u.hook}\` — not registered in App.gadgets${tail}`;
    });
    const secondaryTail = secondary
      ? renderSecondaryTail(secondary.packageMismatches)
      : '';
    super(
      `gadget_not_registered: contract.clientCapabilities.gadgets references exports not present in App.gadgets:\n${lines.join(
        '\n',
      )}\n\nRegister the missing gadget(s) on this app (ggui.json#app.gadgets or the operator tool), or drop the reference from the contract.${secondaryTail}`,
    );
    this.name = 'GadgetNotRegisteredError';
    this.unregistered = unregistered;
    if (secondary && secondary.packageMismatches.length > 0) {
      this.secondary = secondary;
    }
  }
}

/**
 * Thrown when {@link assertGadgetsRegistered} finds a
 * `clientCapabilities.gadgets` export whose name IS registered in
 * `App.gadgets`, but only under a *different* package than the
 * contract requested.
 *
 * This is a sharper signal than `gadget_not_registered`: the export
 * name is right, so it is almost never a typo — it is a
 * package-identity mismatch (stale ref, or an export squatted under a
 * lookalike package). Each entry carries every package registered for
 * that export name so the author can correct the reference.
 *
 * As the lowest-priority category it has no `secondary` — there is
 * nothing below it.
 *
 * Recovery: point the contract reference at the registered package,
 * or register the requested package on this app.
 */
export class GadgetPackageMismatchError extends Error {
  readonly code = 'gadget_package_mismatch' as const;
  readonly mismatches: readonly PackageMismatchEntry[];
  constructor(mismatches: readonly PackageMismatchEntry[]) {
    const lines = mismatches.map(
      (m) =>
        `  - export \`${m.hook}\` requested under package \`${m.requestedPackage}\`, but the app registered it under: ${m.registered.join(
          ', ',
        )}`,
    );
    super(
      `gadget_package_mismatch: contract.clientCapabilities.gadgets references exports registered under a different package:\n${lines.join(
        '\n',
      )}\n\nPoint the contract reference at the registered package, or register the requested package on this app.`,
    );
    this.name = 'GadgetPackageMismatchError';
    this.mismatches = mismatches;
  }
}

/**
 * Validate every `(package, exportName)` the contract references on
 * `clientCapabilities.gadgets` resolves to a registered descriptor by
 * the `(name, package)` identity. On the first push that references an
 * unregistered pair, classifies the failure and throws the most
 * fundamental category (see the module doc):
 * {@link GadgetNotRegisteredError} ▸ {@link GadgetPackageMismatchError}.
 * Package misses on the same push ride along on the thrown error's
 * `secondary`.
 *
 * No-op when:
 *   - `appGadgets` is undefined (registry seam not wired).
 *   - The contract has no `clientCapabilities.gadgets`.
 *
 * Distance threshold for "did you mean": < 3 Levenshtein on the export
 * name.
 */
export function assertGadgetsRegistered(
  contract: DataContract | undefined,
  appGadgets: readonly GadgetDescriptor[] | undefined,
): void {
  if (!contract || !appGadgets) return;
  const declared = listContractGadgets(contract);
  if (declared.length === 0) return;

  // Index by the `(name, package)` identity — the same helper the
  // resolver (`filterDescriptorsToContract`) and the env-key gate use,
  // so all three agree byte-for-byte on what "the same gadget export"
  // means. `byExportName` carries every registered package per export
  // NAME, so a miss can be classified into the precise reject code
  // instead of one opaque `gadget_not_registered`.
  const registeredKeys = new Set<string>();
  const byExportName = new Map<string, string[]>();
  for (const descriptor of appGadgets) {
    for (const exp of descriptor.exports) {
      const name = gadgetExportName(exp);
      registeredKeys.add(
        gadgetIdentityKey({ name, package: descriptor.package }),
      );
      const list = byExportName.get(name);
      if (list) list.push(descriptor.package);
      else byExportName.set(name, [descriptor.package]);
    }
  }

  const notRegistered: UnregisteredHookEntry[] = [];
  const packageMismatch: PackageMismatchEntry[] = [];

  for (const use of declared) {
    if (registeredKeys.has(gadgetIdentityKey(use))) continue;

    const registeredPackages = byExportName.get(use.name);
    if (!registeredPackages || registeredPackages.length === 0) {
      // Category 1: the export name itself is unknown.
      notRegistered.push({
        hook: use.name,
        package: use.package,
        suggestion: findClosestRegisteredHook(use.name, appGadgets),
      });
      continue;
    }

    // Category 2: the export name IS registered, but only under a
    // different package than the contract requested.
    packageMismatch.push({
      hook: use.name,
      requestedPackage: use.package,
      registered: registeredPackages,
    });
  }

  // Throw the most fundamental category first — a wrong export name
  // can't be acted on as a "wrong package" message. The package misses
  // ride on `secondary` so the author sees every miss in one rejection.
  if (notRegistered.length > 0) {
    throw new GadgetNotRegisteredError(notRegistered, {
      packageMismatches: packageMismatch,
    });
  }
  if (packageMismatch.length > 0) {
    throw new GadgetPackageMismatchError(packageMismatch);
  }
}

/**
 * Return the closest-by-Levenshtein registered export name to
 * `candidate`, or `null` when no registered export is within
 * distance < 3. Pure helper.
 *
 * Exported so callers (push.ts, ops handlers) can surface
 * suggestions in their own error envelopes if they wrap the
 * underlying error.
 */
export function findClosestRegisteredHook(
  candidate: string,
  appGadgets: readonly GadgetDescriptor[],
): string | null {
  let nearest: string | null = null;
  let nearestDistance = Infinity;
  for (const descriptor of appGadgets) {
    for (const exp of descriptor.exports) {
      const exportName = gadgetExportName(exp);
      const d = levenshtein(
        candidate.toLowerCase(),
        exportName.toLowerCase(),
      );
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = exportName;
      }
    }
  }
  return nearestDistance < 3 ? nearest : null;
}
