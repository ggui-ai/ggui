/**
 * `assertNoDuplicateGadgetHooks` — hard-reject gate against the same
 * gadget export NAME appearing twice on
 * `contract.clientCapabilities.gadgets`.
 *
 * The hygiene linter already raises a soft warning for this case
 * (`LINT_GADGET_DUPLICATE_EXPORT`); this gate promotes it to a hard
 * render-time reject so the violation is observable rather than
 * silently tolerated. A duplicate export name causes:
 *
 *   - Double-mount of the same export (the runtime imports the gadget
 *     once but mounts it twice — broken cleanup, double permission
 *     prompts, double network fetch).
 *   - An unresolvable identifier collision in the generated module
 *     scope — the boilerplate emits one `import { <name> }` per export.
 *
 * The wire is package-keyed, so a name cannot repeat WITHIN one
 * package (object-key uniqueness). The hazard this gate catches is
 * cross-package: two packages each exporting the same name — e.g.
 * `useCheckout` from `@stripe/...` and `@paypal/...`. An operator who
 * genuinely needs both registers one under an aliased export name.
 */
import { listContractGadgets, type DataContract } from '@ggui-ai/protocol';

export class DuplicateGadgetHookError extends Error {
  /** SPEC §7.9 Plane-2 slug — the wire literal consumers match on. */
  readonly code = 'duplicate_gadget_hook' as const;
  readonly duplicates: ReadonlyArray<{
    package: string;
    firstSeenPackage: string;
    hook: string;
  }>;
  constructor(
    duplicates: ReadonlyArray<{
      package: string;
      firstSeenPackage: string;
      hook: string;
    }>,
  ) {
    const lines = duplicates.map(
      (d) =>
        `  - export '${d.hook}' from '${d.package}' (already declared by '${d.firstSeenPackage}')`,
    );
    super(
      `duplicate_gadget_hook: contract declares the same gadget export name under multiple packages. Each export name MUST mount once.\n${lines.join('\n')}`,
    );
    this.name = 'DuplicateGadgetHookError';
    this.duplicates = duplicates;
  }
}

/**
 * Throws {@link DuplicateGadgetHookError} when two
 * `contract.clientCapabilities.gadgets` exports — across packages —
 * share the same export name. Pure check; no mutation.
 */
export function assertNoDuplicateGadgetHooks(contract: DataContract): void {
  const seen = new Map<string, string>(); // export name → first-seen package
  const duplicates: Array<{
    package: string;
    firstSeenPackage: string;
    hook: string;
  }> = [];
  for (const use of listContractGadgets(contract)) {
    const prior = seen.get(use.name);
    if (prior !== undefined) {
      duplicates.push({
        package: use.package,
        firstSeenPackage: prior,
        hook: use.name,
      });
      continue;
    }
    seen.set(use.name, use.package);
  }
  if (duplicates.length > 0) {
    throw new DuplicateGadgetHookError(duplicates);
  }
}
