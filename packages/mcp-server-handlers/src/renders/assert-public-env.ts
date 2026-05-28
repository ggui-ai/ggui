/**
 * `assertPublicEnvSatisfied` — push-gate validation for public env
 * key requirements.
 *
 * Wrapper authors declare which public env keys their hook consumes
 * via `GadgetDescriptor.requires`. The operator stamps values on
 * `App.publicEnv`. This gate ensures every declared wrapper's
 * `requires` is satisfied by `App.publicEnv` before the iframe boots
 * — otherwise the wrapper would `getPublicEnv()` an undefined key at
 * hook-mount and throw with a confusing in-iframe error.
 *
 * The gate runs at PUSH time (not registration time):
 *   - Only validates wrappers DECLARED in the current contract
 *     (`contract.clientCapabilities.gadgets[*].hook`). Wrappers
 *     registered on App.gadgets but unused by this contract
 *     don't fail the push — they don't affect this iframe's runtime.
 *   - Symmetric with `assertGadgetsRegistered`: both gates validate
 *     the contract against the operator's per-App surface at the
 *     same call site.
 *
 * Validator behavior:
 *   - Pure function, no I/O.
 *   - No-op when:
 *       - `contract` is undefined
 *       - `appGadgets` is undefined (registry seam not wired)
 *       - `appPublicEnv` is undefined (no public env values configured)
 *         AND no declared wrapper has a non-empty `requires`. (If a
 *         declared wrapper requires keys but the App has no
 *         publicEnv at all, the gate STILL throws — that's the
 *         misconfiguration we're catching.)
 *   - Walks every declared wrapper's `requires`; surfaces missing
 *     keys as a `GadgetPublicEnvMissingError` with did-you-mean
 *     suggestions (Levenshtein < 3 — same threshold as the registry
 *     gate's hook-name suggester).
 *
 * Call sites:
 *   - `push.ts` — author-time gate; throws before mutating state.
 *
 * Distance threshold for "did you mean" — `< 3` Levenshtein on
 * lowercase keys. Catches the casing+single-typo pattern
 * (`GGUI_PUBLIC_APP_MABPOX_TOKEN` → suggest `GGUI_PUBLIC_APP_MAPBOX_TOKEN`).
 */

import {
  gadgetExportName,
  gadgetIdentityKey,
  listContractGadgets,
  type GadgetDescriptor,
  type DataContract,
} from '@ggui-ai/protocol';
import { levenshtein } from '../ops-blueprint/persona-normalization.js';

/**
 * One missing public-env-key violation. The error groups these by
 * gadget export so the author can fix one declaration at a time.
 */
export interface PublicEnvViolation {
  /** The declared gadget export whose `requires` includes the key. */
  readonly hook: string;
  /** The package the export was referenced under. */
  readonly package: string;
  /** The unsatisfied required key. */
  readonly missingKey: string;
  /** Closest configured key by Levenshtein, or `null` when nothing's
   * within distance < 3. */
  readonly suggestion: string | null;
}

/**
 * Thrown when {@link assertPublicEnvSatisfied} finds one or more
 * declared wrappers whose `requires` aren't fully present in
 * `App.publicEnv`.
 *
 * Recovery for the author:
 *   - Set the missing key on `ggui.json#app.publicEnv` (OSS) or via
 *     the App-config write path (cloud).
 *   - Or drop the wrapper binding from the contract.
 *
 * The error carries every missing-key tuple so authoring tools can
 * surface one fix per row.
 */
export class GadgetPublicEnvMissingError extends Error {
  readonly code = 'gadget_public_env_missing' as const;
  readonly violations: ReadonlyArray<PublicEnvViolation>;

  constructor(violations: ReadonlyArray<PublicEnvViolation>) {
    const lines = violations.map((v) => {
      const tail =
        v.suggestion !== null ? ` — did you mean \`${v.suggestion}\`?` : '';
      return `  - \`${v.package}\` export \`${v.hook}\` requires public env key \`${v.missingKey}\` which is not set on App.publicEnv${tail}`;
    });
    super(
      `gadget_public_env_missing: contract declares wrappers whose 'requires' keys are not present on App.publicEnv:\n${lines.join(
        '\n',
      )}\n\nSet the missing key(s) on ggui.json#app.publicEnv (OSS) or via the App-config write path (cloud), or drop the wrapper binding from the contract.`,
    );
    this.name = 'GadgetPublicEnvMissingError';
    this.violations = violations;
  }
}

/**
 * Validate that every declared wrapper's `requires` is satisfied by
 * `appPublicEnv`. Throws {@link GadgetPublicEnvMissingError}
 * with one violation per missing key.
 *
 * The validator pairs with {@link assertGadgetsRegistered} — that
 * gate verifies the hook NAME is registered; this gate verifies the
 * hook's REQUIRED env keys are satisfied. Both fire at push time
 * before any state mutation.
 */
export function assertPublicEnvSatisfied(
  contract: DataContract | undefined,
  appGadgets: readonly GadgetDescriptor[] | undefined,
  appPublicEnv: Readonly<Record<string, string>> | undefined,
): void {
  if (!contract || !appGadgets) return;
  const declared = listContractGadgets(contract);
  if (declared.length === 0) return;

  // Index every registered export by its `(name, package)` identity →
  // the package descriptor that owns it (`requires` is package-level).
  // Same `gadgetIdentityKey` helper the registry gate + resolver use,
  // so all three agree on what "the same gadget export" means. The
  // catalog lint enforces one descriptor per package, so the key
  // resolves to exactly one descriptor.
  const byKey = new Map<string, GadgetDescriptor>();
  for (const descriptor of appGadgets) {
    for (const exp of descriptor.exports) {
      byKey.set(
        gadgetIdentityKey({
          name: gadgetExportName(exp),
          package: descriptor.package,
        }),
        descriptor,
      );
    }
  }

  const provided = appPublicEnv ?? {};
  const providedKeys = Object.keys(provided);

  const violations: PublicEnvViolation[] = [];
  for (const use of declared) {
    const descriptor = byKey.get(gadgetIdentityKey(use));
    const requires = descriptor?.requires ?? [];
    for (const required of requires) {
      if (Object.prototype.hasOwnProperty.call(provided, required)) continue;
      violations.push({
        hook: use.name,
        package: use.package,
        missingKey: required,
        suggestion: findClosestPublicEnvKey(required, providedKeys),
      });
    }
  }

  if (violations.length > 0) {
    throw new GadgetPublicEnvMissingError(violations);
  }
}

/**
 * Return the closest-by-Levenshtein configured public env key to
 * `candidate`, or `null` when no key is within distance < 3.
 * Lowercase-normalized so a casing typo (operator wrote
 * `gGui_public_app_token` instead of `GGUI_PUBLIC_APP_TOKEN`) still
 * matches — though the App.publicEnv schema rejects lowercase keys
 * upstream, so the lowercase path is mostly defensive.
 *
 * Exported for unit testing + for handler call sites that want to
 * surface a suggestion in their own error envelope.
 */
export function findClosestPublicEnvKey(
  candidate: string,
  providedKeys: readonly string[],
): string | null {
  let nearest: string | null = null;
  let nearestDistance = Infinity;
  for (const key of providedKeys) {
    const d = levenshtein(candidate.toLowerCase(), key.toLowerCase());
    if (d < nearestDistance) {
      nearestDistance = d;
      nearest = key;
    }
  }
  return nearestDistance < 3 ? nearest : null;
}
