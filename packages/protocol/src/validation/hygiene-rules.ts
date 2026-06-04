/**
 * Authoring-hygiene rules for `DataContract`. Lint rule registry —
 * warnings only, never thrown by {@link validateContract}; surfaced
 * by {@link lintContract} so authoring tools can offer "your contract
 * is technically valid, but here are the polish items" feedback.
 *
 * Ships the most universally applicable subset:
 *
 *   - `LINT_ORPHAN_AGENT_TOOL` — `agentCapabilities.tools[X]` is
 *     declared but never referenced from any `actionSpec[*].nextStep`
 *     or `streamSpec[*].source.tool`. The entry is dead weight — either
 *     wire it up or drop it. (Catches the common "agent dropped a
 *     reference but left the catalog entry behind" drift.)
 *
 *   - `LINT_MISSING_USAGE` — `agentCapabilities.tools[*]` or
 *     `clientCapabilities.gadgets[*]` lacks a `usage` field.
 *     `usage` is the free-form LLM-targeted prose that bare
 *     `description` lacks — when omitted, the agent's reasoning
 *     loop loses important context-of-use information.
 *
 *   - `LINT_MISSING_EXAMPLE` — `agentCapabilities.tools[*]` lacks an
 *     `example`. Examples ground the agent's invocation patterns; a
 *     tool without one is harder to use correctly on the first call.
 *
 *   - `LINT_GADGET_DUPLICATE_EXPORT` — two `clientCapabilities.gadgets[*]`
 *     entries declare the same export name (a `hook` name or a
 *     `component` name). The boilerplate generator emits one import
 *     per export name; a collision is unresolvable in module scope.
 *     Keyed on the export name alone.
 *
 * Gadget lints split by timing into two surfaces:
 *
 *   - **Wire-side** ({@link checkHygiene}, input `DataContract`):
 *     `checkGadgetHookNames` + `checkDuplicateGadgetHooks`.
 *   - **Registry-side** ({@link lintGadgetCatalog}, input
 *     `readonly GadgetDescriptor[]`): permission + immutability +
 *     duplicate-hook + unscoped-package checks, run at registration
 *     time. Some codes are fatal — see {@link FATAL_CATALOG_LINT_CODES}.
 *
 * Pure checks; return violations rather than throwing. The wire-side
 * set is wired into `lintContract` via `phaseHygiene`; consumers that
 * want strict gates layer their own assertions on top.
 */

import type { DataContract, GadgetDescriptor } from '../types/data-contract';
import {
  STDLIB_GADGETS_PACKAGE,
  STDLIB_GADGET_HOOKS,
} from '../gadgets/stdlib-gadgets';
import {
  gadgetExportName,
  listContractGadgets,
} from '../gadgets/resolve-contract-gadgets';
import { HOOK_NAME_RE } from '../schemas/gadget-name-grammar';

/**
 * Stable codes for hygiene rules. Each is a `LINT_*` rather than a
 * `CTR_*` — the convention: errors are `CTR_*`, warnings are `LINT_*`.
 *
 * The gadget lints split into two timing buckets:
 *
 *   - **Wire-side** (run on a `DataContract` by {@link checkHygiene}):
 *     `LINT_GADGET_UNKNOWN_HOOK`, `LINT_GADGET_DUPLICATE_EXPORT`.
 *   - **Registry-side** (run on an `App.gadgets` catalog at
 *     registration time by {@link lintGadgetCatalog}):
 *     `LINT_GADGET_MISSING_PERMISSION`, `LINT_GADGET_UNKNOWN_PERMISSION`,
 *     `LINT_GADGET_UNSCOPED_PACKAGE`, `LINT_GADGET_IMMUTABLE_MUTATION`,
 *     `LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG`.
 */
export const LINT_ORPHAN_AGENT_TOOL = 'LINT_ORPHAN_AGENT_TOOL';
export const LINT_MISSING_USAGE = 'LINT_MISSING_USAGE';
export const LINT_MISSING_EXAMPLE = 'LINT_MISSING_EXAMPLE';
export const LINT_GADGET_UNKNOWN_HOOK = 'LINT_GADGET_UNKNOWN_HOOK';
export const LINT_GADGET_DUPLICATE_EXPORT = 'LINT_GADGET_DUPLICATE_EXPORT';
export const LINT_CONTRACT_RETIRED_FIELD = 'LINT_CONTRACT_RETIRED_FIELD';
// ── Registry-side (lintGadgetCatalog) ──
export const LINT_GADGET_MISSING_PERMISSION = 'LINT_GADGET_MISSING_PERMISSION';
export const LINT_GADGET_UNKNOWN_PERMISSION = 'LINT_GADGET_UNKNOWN_PERMISSION';
export const LINT_GADGET_UNSCOPED_PACKAGE = 'LINT_GADGET_UNSCOPED_PACKAGE';
export const LINT_GADGET_IMMUTABLE_MUTATION = 'LINT_GADGET_IMMUTABLE_MUTATION';
export const LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG =
  'LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG';
export const LINT_GADGET_DUPLICATE_PACKAGE = 'LINT_GADGET_DUPLICATE_PACKAGE';

/**
 * Registry-side lint codes that denote a HARD integrity violation —
 * registration handlers MUST reject the catalog (not just warn) when
 * {@link lintGadgetCatalog} emits one of these. The lint function
 * itself stays pure (returns warnings); severity classification is
 * the caller's, so this set is the single source of truth for "which
 * codes are fatal."
 *
 *   - `LINT_GADGET_IMMUTABLE_MUTATION` — two descriptors share a
 *     `(package, version)` tuple but disagree on `bundleSri`. The
 *     same immutable bundle cannot have two hashes; cached blueprints
 *     keyed on that version would silently break.
 *   - `LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG` — two descriptors
 *     export the same name (a `hook` name or a `component` name). The
 *     boilerplate generator emits one
 *     `import { <name> } from '<package>'` per export; a name
 *     collision in module scope is unresolvable.
 */
export const FATAL_CATALOG_LINT_CODES: ReadonlySet<string> = new Set([
  LINT_GADGET_IMMUTABLE_MUTATION,
  LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG,
  LINT_GADGET_DUPLICATE_PACKAGE,
]);

/**
 * Retired top-level `DataContract` field names. The contract schema
 * is `.passthrough()` at the type system level (forward-compat
 * hedge), but these specific names denote fields that have a known
 * replacement in the current protocol. Carrying one of them is a
 * caller bug — silent pass-through would mask the migration.
 *
 * Replacements (kept here so the lint message can teach the fix):
 *   - `libraries`     → `clientCapabilities.gadgets`
 *   - `dispatch`      → `agentCapabilities.tools` + `actionSpec[*].nextStep`
 *   - `wiredTools`    → `agentCapabilities.tools`
 *   - `clientTools`   → `clientCapabilities.gadgets`
 *   - `broadcast`     → `streamSpec[ch].source`
 *   - `capabilities`  → `agentCapabilities` + `clientCapabilities`
 *
 * Render-gate handlers re-use this list to hard-reject; surfacing it
 * here keeps the wire vocabulary single-sourced.
 */
export const RETIRED_CONTRACT_FIELDS: Readonly<Record<string, string>> = {
  libraries: 'clientCapabilities.gadgets',
  dispatch: 'agentCapabilities.tools + actionSpec[*].nextStep',
  wiredTools: 'agentCapabilities.tools',
  clientTools: 'clientCapabilities.gadgets',
  broadcast: 'streamSpec[ch].source',
  capabilities: 'agentCapabilities + clientCapabilities',
} as const;

/**
 * Sourced from {@link STDLIB_GADGET_HOOKS} — the canonical
 * hook-name set the first-party `@ggui-ai/gadgets` package
 * exports. Local alias keeps existing call sites stable while the
 * source of truth lives in `registries/stdlib-gadgets.ts`.
 */
const KNOWN_STDLIB_HOOKS = STDLIB_GADGET_HOOKS;

/**
 * Default package for gadget hooks. Sourced from the
 * stdlib-libraries registry — when an entry's `package` is omitted,
 * the hygiene linter assumes it resolves to the first-party
 * `@ggui-ai/gadgets` package and runs hook-registry +
 * permission checks against the stdlib catalog. Third-party packages
 * skip those checks.
 */
const DEFAULT_GADGET_PACKAGE = STDLIB_GADGETS_PACKAGE;

/**
 * Permission strings the Web Permissions API ratifies, plus the
 * MCP Apps `_meta.ui.permissions` enum members for host
 * passthrough.
 *
 * Exported as a tuple + literal-union type so
 * `strictGadgetDescriptorSchema.permission` can use
 * `z.enum(KNOWN_PERMISSION_NAMES)` for a hard reject at parse time:
 * typos (`'geolocaiton'`) and unsupported values fail at the wire
 * boundary instead of being demoted to a soft warning. Forward-compat
 * additions land via a protocol version bump.
 */
export const KNOWN_PERMISSION_NAMES = [
  // Web Permissions API names
  'geolocation',
  'notifications',
  'microphone',
  'camera',
  'persistent-storage',
  'midi',
  'clipboard-read',
  'clipboard-write',
  'speaker-selection',
  'storage-access',
  'background-sync',
  'accelerometer',
  'gyroscope',
  'magnetometer',
  'ambient-light-sensor',
  'screen-wake-lock',
  // MCP Apps `_meta.ui.permissions` mirror (matches the Web Permissions
  // API names today; future spec additions go here).
] as const;

export type KnownPermissionName = (typeof KNOWN_PERMISSION_NAMES)[number];

const KNOWN_PERMISSION_NAMES_SET: ReadonlySet<string> = new Set(
  KNOWN_PERMISSION_NAMES,
);

/**
 * Stdlib hooks whose Web Permissions API name is well-known. A
 * registered descriptor for one of these hooks SHOULD declare the
 * matching `permission` so {@link lintGadgetCatalog} can surface the
 * "this UI will prompt for X" context to the agent's reasoning loop.
 * Maps hook name → expected permission.
 */
const KNOWN_PERMISSION_HOOKS: Readonly<Record<string, KnownPermissionName>> = {
  useGeolocation: 'geolocation',
  useNotifications: 'notifications',
  useMicrophone: 'microphone',
  useCamera: 'camera',
  useClipboardPaste: 'clipboard-read',
  useClipboardWrite: 'clipboard-write',
};

/**
 * Hygiene-rule warning. Internal — surfaced through `ContractIssue`
 * via the converters in `lint-contract.ts`. Keep the shape minimal:
 * code + path + message + fixHint cover the rendering needs of the
 * authoring tools that consume `lintContract` warnings.
 */
export interface HygieneWarning {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly fixHint?: string;
}

/**
 * Collect every `agentCapabilities.tools[*]` key that's referenced from
 * `actionSpec[*].nextStep` or `streamSpec[*].source.tool`. Used to
 * detect orphans (declared but unreferenced) and is exported because
 * future rules / tooling may want the same accounting.
 */
function collectReferencedAgentTools(
  contract: DataContract,
): ReadonlySet<string> {
  const referenced = new Set<string>();

  const actionSpec = contract.actionSpec ?? {};
  for (const entry of Object.values(actionSpec)) {
    if (!entry || typeof entry !== 'object') continue;
    const nextStep = entry.nextStep;
    if (typeof nextStep === 'string' && nextStep.length > 0) {
      referenced.add(nextStep);
    }
  }

  const streamSpec = contract.streamSpec ?? {};
  for (const entry of Object.values(streamSpec)) {
    if (!entry || typeof entry !== 'object') continue;
    const source = entry.source;
    if (!source) continue;
    const tool = source.tool;
    if (typeof tool === 'string' && tool.length > 0) {
      referenced.add(tool);
    }
  }

  return referenced;
}

/**
 * Find agentCapabilities.tools entries that are declared but never
 * referenced from actionSpec or streamSpec. Each orphan is dead
 * weight — either wire it up or drop it from the catalog.
 */
export function checkOrphanAgentTools(
  contract: DataContract,
): HygieneWarning[] {
  const tools = contract.agentCapabilities?.tools;
  if (!tools) return [];

  const referenced = collectReferencedAgentTools(contract);
  const warnings: HygieneWarning[] = [];

  for (const name of Object.keys(tools)) {
    if (referenced.has(name)) continue;
    warnings.push({
      code: LINT_ORPHAN_AGENT_TOOL,
      path: `agentCapabilities.tools.${name}`,
      message: `agentCapabilities.tools.${name} is declared but never referenced from actionSpec[*].nextStep or streamSpec[*].source.tool. Dead-weight catalog entry — either wire it up or remove it.`,
      fixHint: `Add a reference like 'actionSpec.<action>.nextStep = "${name}"' or 'streamSpec.<channel>.source.tool = "${name}"', or delete the catalog entry.`,
    });
  }

  return warnings;
}

/**
 * Find `agentCapabilities.tools` entries missing the `usage` field.
 * `usage` is the LLM-targeted "when / why / by-whom" prose; without it
 * the agent's reasoning loop loses context-of-use information.
 *
 * Scope is `agentCapabilities.tools` ONLY. `clientCapabilities.gadgets`
 * is intentionally NOT linted here: `GadgetExportUse.usage` is an
 * OPTIONAL intent-OVERRIDE, and the SPEC-documented canonical wire
 * form is the bare identity reference `gadgets[<pkg>][<export>] = {}`.
 * Render-time resolution inherits the registered descriptor's `usage`,
 * and the registry-side `lintGadgetCatalog` (via
 * `strictGadgetExportSchema`) already enforces real teaching text at
 * registration time. Flagging an empty wire-side use object would
 * false-positive the documented happy path.
 */
export function checkMissingUsage(contract: DataContract): HygieneWarning[] {
  const warnings: HygieneWarning[] = [];

  const tools = contract.agentCapabilities?.tools;
  if (tools) {
    for (const [name, entry] of Object.entries(tools)) {
      if (!entry || typeof entry !== 'object') continue;
      const usage = entry.usage;
      if (typeof usage === 'string' && usage.length > 0) continue;
      warnings.push({
        code: LINT_MISSING_USAGE,
        path: `agentCapabilities.tools.${name}.usage`,
        message: `agentCapabilities.tools.${name} has no 'usage' prose. The agent's reasoning loop reads usage as context-of-use; tools without it tend to get invoked at the wrong time.`,
        fixHint: `Add 'usage: "..."' describing when / why / by whom this tool is invoked.`,
      });
    }
  }

  return warnings;
}

/**
 * Find agentCapabilities.tools entries missing the `example` field.
 * Examples ground the agent's invocation patterns; a tool without
 * one is harder to use correctly on the first call.
 */
export function checkMissingExample(
  contract: DataContract,
): HygieneWarning[] {
  const tools = contract.agentCapabilities?.tools;
  if (!tools) return [];

  const warnings: HygieneWarning[] = [];
  for (const [name, entry] of Object.entries(tools)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.example !== undefined) continue;
    warnings.push({
      code: LINT_MISSING_EXAMPLE,
      path: `agentCapabilities.tools.${name}.example`,
      message: `agentCapabilities.tools.${name} has no 'example'. Examples ground the agent's invocation patterns; tools without one are harder to use correctly on the first call.`,
      fixHint: `Add 'example: { input: {...}, output: ... }' with a representative call shape.`,
    });
  }

  return warnings;
}

/**
 * Wire-side gadget hook-name lint. For every
 * `clientCapabilities.gadgets[*]` whose `package` is the first-party
 * stdlib (`@ggui-ai/gadgets`), the `hook` MUST be one the stdlib
 * actually exports — catches typos (`useGeoLocation`) + stale
 * references against a constant catalog.
 *
 * Third-party packages (any `package !== DEFAULT_GADGET_PACKAGE`) are
 * NOT checked here — the lint can't know an operator's own hook
 * names. The registry-side {@link lintGadgetCatalog} + the render-time
 * {@link assertGadgetsRegistered} gate cover third-party resolution.
 *
 * Permission checks live on the registry-side `lintGadgetCatalog`
 * (the wire gadget reference carries no `permission` field). This
 * function is the pure wire-only residue: a constant-catalog
 * hook-name check.
 */
export function checkGadgetHookNames(
  contract: DataContract,
): HygieneWarning[] {
  const warnings: HygieneWarning[] = [];
  for (const gadget of listContractGadgets(contract)) {
    if (gadget.package !== DEFAULT_GADGET_PACKAGE) continue;
    const path = `clientCapabilities.gadgets.${gadget.package}.exports.${gadget.name}`;

    // The first-party stdlib ships hooks only — a component export
    // pinning `@ggui-ai/gadgets` is a mistake. Kind is read off the
    // export-name grammar (`use`-prefixed hook vs PascalCase component).
    if (!HOOK_NAME_RE.test(gadget.name)) {
      warnings.push({
        code: LINT_GADGET_UNKNOWN_HOOK,
        path,
        message: `clientCapabilities.gadgets declares a component '${gadget.name}' from '${gadget.package}', but the first-party stdlib ships hooks only.`,
        fixHint: `Use a hook from the v1 catalog, or reference a third-party gadget package that exports the component.`,
      });
      continue;
    }

    if (!KNOWN_STDLIB_HOOKS.has(gadget.name)) {
      warnings.push({
        code: LINT_GADGET_UNKNOWN_HOOK,
        path,
        message: `clientCapabilities.gadgets references hook '${gadget.name}' from '${gadget.package}', which doesn't ship that hook. Known: ${[
          ...KNOWN_STDLIB_HOOKS,
        ].join(', ')}.`,
        fixHint: `Pick a hook from the v1 catalog, or reference a third-party hook package the lint doesn't know about.`,
      });
    }
  }

  return warnings;
}

/**
 * Find `clientCapabilities.gadgets` exports that declare the same
 * export NAME from two different packages.
 *
 * The wire is package-keyed, so the same name cannot repeat WITHIN a
 * package (object-key uniqueness). The hazard is cross-package: two
 * packages each exporting `useCheckout`. The boilerplate generator
 * emits one `import { <name> } from '<package>'` per export; two
 * imports of the same name — from different packages — produce an
 * unresolvable identifier collision in the generated module scope.
 *
 * Keys on the export name alone, matching the render-time hard gate
 * `assertNoDuplicateGadgetHooks`. Soft mirror of that gate so
 * authoring tools surface the issue before a render round-trip.
 */
export function checkDuplicateGadgetHooks(
  contract: DataContract,
): HygieneWarning[] {
  const seen = new Map<string, string>(); // export name → first package
  const warnings: HygieneWarning[] = [];

  for (const gadget of listContractGadgets(contract)) {
    const prior = seen.get(gadget.name);
    if (prior !== undefined) {
      warnings.push({
        code: LINT_GADGET_DUPLICATE_EXPORT,
        path: `clientCapabilities.gadgets.${gadget.package}.exports.${gadget.name}`,
        message: `clientCapabilities.gadgets declares export '${gadget.name}' from both '${prior}' and '${gadget.package}'. The boilerplate generator emits one import per export name — two packages exporting the same name collide in module scope.`,
        fixHint: `Drop one of the gadgets, or have the operator register the second under an aliased export name.`,
      });
      continue;
    }
    seen.set(gadget.name, gadget.package);
  }

  return warnings;
}

/**
 * Registry-side catalog lint — runs on an `App.gadgets` descriptor
 * array at registration time (ggui.json load, `ops_register_gadget`,
 * registry install). Pure function; returns warnings. The caller
 * (registration handler) treats any code in
 * {@link FATAL_CATALOG_LINT_CODES} as a hard reject.
 *
 * Checks:
 *
 *   - `LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG` (fatal) — two
 *     descriptors export the same name (a `hook` name or a
 *     `component` name). Each export name is unique per app; the
 *     boilerplate's per-export import would collide.
 *   - `LINT_GADGET_IMMUTABLE_MUTATION` (fatal) — two descriptors
 *     carry the same `(package, version)` tuple but different
 *     `bundleSri`. The same immutable bundle cannot have two hashes;
 *     a cached blueprint pinned to that version would break.
 *   - `LINT_GADGET_MISSING_PERMISSION` — a known-permission stdlib
 *     hook (geolocation, camera, …) registered without a
 *     `permission` field. The agent's reasoning loop reads it to
 *     surface "this UI prompts for X."
 *   - `LINT_GADGET_UNKNOWN_PERMISSION` — `permission` set to a value
 *     outside the Web Permissions API set. (The strict registry
 *     schema enum-checks this too; the lint is defence-in-depth for
 *     permissively-parsed catalogs.)
 *   - `LINT_GADGET_UNSCOPED_PACKAGE` — `package` lacks an `@scope/`
 *     prefix. Soft recommendation: scoped names avoid registry
 *     squatting + name collisions.
 */
export function lintGadgetCatalog(
  descriptors: readonly GadgetDescriptor[],
): HygieneWarning[] {
  const warnings: HygieneWarning[] = [];

  // export name → first occurrence path (catalog-wide uniqueness).
  const seenExportName = new Map<string, string>();
  // package name → first occurrence path (one descriptor per package).
  const seenPackage = new Map<string, string>();
  const sriByVersionTuple = new Map<string, { path: string; sri: string }>();

  descriptors.forEach((descriptor, index) => {
    const path = `gadgets[${index}]`;

    // ── Immutable-bundle mutation (fatal) — package-level ──
    // Two descriptors for the same (package, version) MUST agree on
    // bundleSri — they reference the same immutable artifact.
    if (
      typeof descriptor.bundleSri === 'string' &&
      descriptor.bundleSri.length > 0
    ) {
      const tupleKey = `${descriptor.package}\t${descriptor.version}`;
      const prior = sriByVersionTuple.get(tupleKey);
      if (prior !== undefined && prior.sri !== descriptor.bundleSri) {
        warnings.push({
          code: LINT_GADGET_IMMUTABLE_MUTATION,
          path: `${path}.bundleSri`,
          message: `gadgets[${index}] (${descriptor.package}@${descriptor.version}) declares bundleSri '${descriptor.bundleSri}' but ${prior.path} declares '${prior.sri}' for the same package+version. A published version is immutable — one bundle, one hash.`,
          fixHint: `Bump the version on whichever descriptor ships the changed bundle, or correct the mismatched SRI.`,
        });
      } else if (prior === undefined) {
        sriByVersionTuple.set(tupleKey, { path, sri: descriptor.bundleSri });
      }
    }

    // ── Duplicate package (fatal) — package-level ──
    // `(name, package)` ref resolution requires at most ONE descriptor
    // per package in an app's catalog. Two descriptors sharing a
    // package name make `filterDescriptorsToContract` silently pick
    // one — `version` is no longer on the wire to disambiguate.
    const priorPackagePath = seenPackage.get(descriptor.package);
    if (priorPackagePath !== undefined) {
      warnings.push({
        code: LINT_GADGET_DUPLICATE_PACKAGE,
        path: `${path}.package`,
        message: `gadgets[${index}].package is '${descriptor.package}', already registered by ${priorPackagePath}. An app's catalog MUST hold at most one descriptor per package — the wire references a package by name and the server resolves exactly one descriptor (no version to disambiguate).`,
        fixHint: `Register a single descriptor per package; drop or merge the duplicate.`,
      });
    } else {
      seenPackage.set(descriptor.package, path);
    }

    // ── Unscoped package (soft) — package-level ──
    if (!descriptor.package.startsWith('@')) {
      warnings.push({
        code: LINT_GADGET_UNSCOPED_PACKAGE,
        path: `${path}.package`,
        message: `gadgets[${index}].package is '${descriptor.package}' — an unscoped npm name. Scoped names ('@org/name') avoid registry squatting + cross-publisher collisions.`,
        fixHint: `Publish under an '@scope/' prefix.`,
      });
    }

    // ── Per-export checks ──
    descriptor.exports.forEach((exp, exportIndex) => {
      const exportName = gadgetExportName(exp);
      const exportPath = `${path}.exports[${exportIndex}]`;

      // Duplicate export name (fatal) — catalog-wide. The boilerplate
      // generator emits one import per export name; a collision is
      // unresolvable in module scope.
      const priorPath = seenExportName.get(exportName);
      if (priorPath !== undefined) {
        warnings.push({
          code: LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG,
          path: exportPath,
          message: `${exportPath} exports '${exportName}', already exported by ${priorPath}. Each gadget export name MUST be unique within an app's catalog — the boilerplate generator emits one import per name.`,
          fixHint: `Drop the duplicate, or publish one gadget under an aliased export name.`,
        });
      } else {
        seenExportName.set(exportName, exportPath);
      }

      // Missing permission (soft) — a known-permission stdlib hook.
      // `GadgetExport` is a type-exclusive union (`hook?: never` on the
      // component member); discrimination is by VALUE presence, not the
      // `in` operator, since `hook` is now an optional key of both.
      if (exp.hook !== undefined) {
        const expectedPermission = KNOWN_PERMISSION_HOOKS[exp.hook];
        if (
          expectedPermission !== undefined &&
          (typeof exp.permission !== 'string' || exp.permission.length === 0)
        ) {
          warnings.push({
            code: LINT_GADGET_MISSING_PERMISSION,
            path: `${exportPath}.permission`,
            message: `${exportPath} registers hook '${exp.hook}' without a 'permission' field. The agent's reasoning loop reads permission to surface "this UI will prompt for ${expectedPermission}" context.`,
            fixHint: `Add 'permission: "${expectedPermission}"' (Web Permissions API name).`,
          });
        }
      }

      // Unknown permission (soft).
      if (
        typeof exp.permission === 'string' &&
        exp.permission.length > 0 &&
        !KNOWN_PERMISSION_NAMES_SET.has(exp.permission)
      ) {
        warnings.push({
          code: LINT_GADGET_UNKNOWN_PERMISSION,
          path: `${exportPath}.permission`,
          message: `${exportPath}.permission is '${exp.permission}', which isn't a known Web Permissions API name. Catches typos + flags non-standard permissions for review.`,
          fixHint: `Pick a name from the Web Permissions API spec (e.g., 'geolocation', 'notifications', 'microphone'), or document the custom value if intentional.`,
        });
      }
    });
  });

  return warnings;
}

/**
 * Find top-level retired-field carriers on the contract. The schema
 * is `.passthrough()`, so a stray `libraries`/`dispatch`/`wiredTools`/
 * `clientTools`/`broadcast`/`capabilities` slips through silently. The
 * render-gate hard-rejects these (see
 * `mcp-server-handlers/.../assert-contract-no-retired-fields.ts`); this
 * lint surface keeps authoring tools symmetric — show the warning before
 * the render call so the author can fix it without a server round-trip.
 */
export function checkRetiredContractFields(
  contract: DataContract,
): HygieneWarning[] {
  // Cast to a generic record so we can probe the keys the passthrough
  // schema lets ride. The contract surface here is post-parse so all
  // typed fields are already covered; we're specifically looking for
  // siblings the type system can't see.
  const raw = contract as unknown as Record<string, unknown>;
  const warnings: HygieneWarning[] = [];
  for (const [retired, replacement] of Object.entries(RETIRED_CONTRACT_FIELDS)) {
    if (raw[retired] === undefined) continue;
    warnings.push({
      code: LINT_CONTRACT_RETIRED_FIELD,
      path: retired,
      message: `contract.${retired} is retired. Use ${replacement} instead — the field rides through .passthrough() but the render gate hard-rejects it as a structural error.`,
      fixHint: `Delete contract.${retired}; move its data to ${replacement}.`,
    });
  }
  return warnings;
}

/**
 * Run every WIRE-side hygiene rule on a `DataContract`. Aggregates
 * warnings; order is stable (orphans → usage → example → gadget
 * hook-names → duplicate-hook) so authoring tools render a predictable
 * checklist. Retired-field detection is NOT here — it is promoted to an
 * ERROR phase (`phaseRetired` in lint-contract.ts); the detector
 * `checkRetiredContractFields` stays exported for the author-time
 * surface and the render-gate assert.
 *
 * Registry-side gadget lints (`lintGadgetCatalog`) are NOT run here:
 * they need an `App.gadgets` descriptor array, not a contract, and
 * fire at registration time rather than render time.
 * Call {@link lintGadgetCatalog} separately at the registration
 * boundary.
 */
export function checkHygiene(
  contract: DataContract,
): HygieneWarning[] {
  return [
    ...checkOrphanAgentTools(contract),
    ...checkMissingUsage(contract),
    ...checkMissingExample(contract),
    ...checkGadgetHookNames(contract),
    ...checkDuplicateGadgetHooks(contract),
    // Retired-field detection is promoted to an ERROR phase
    // (`phaseRetired` in lint-contract.ts) — not a hygiene warning.
    // `checkRetiredContractFields` stays exported for the author-time
    // surface + the render-gate assert.
  ];
}
