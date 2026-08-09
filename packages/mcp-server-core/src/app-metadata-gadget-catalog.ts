/**
 * `AppMetadataGadgetCatalog` — a `GadgetCatalogAdapter` backed by an
 * {@link AppMetadataStore}.
 *
 * `GadgetCatalogAdapter` is the `@ggui-ai/gadgets` port consumed by
 * `createUiGenerator({ gadgetCatalog })`. `list(appId)` reads the
 * app's registered `App.gadgets` catalog, hard-validates every
 * descriptor, and runs the registry-side catalog lint before handing
 * the list to the generator.
 *
 * ## One adapter, not per-environment subclasses
 *
 * Both environments surface their per-app gadget catalog through the SAME
 * {@link AppMetadataStore} seam — OSS via `InMemoryAppMetadataStore`
 * (seeded from `ggui.json#app.gadgets`), cloud via
 * `dynamoAppMetadataStore` (the DDB `GguiApp` row). The per-environment
 * difference lives entirely in the store implementation; a
 * `JsonGadgetCatalog` and a `DynamoGadgetCatalog` would be
 * byte-identical wrappers. So this is ONE adapter — pass the OSS store
 * or the cloud store; the validation + lint behavior is identical.
 *
 * ## What `list()` guarantees (closes audit R5 — `lintGadgetCatalog`
 * wired)
 *
 *   1. **Schema** — every DECLARED descriptor is re-parsed against
 *      `strictGadgetDescriptorSchema` (teaching text required,
 *      permission enum-tight) — the same posture the write path and
 *      the read projections validate against, so a descriptor
 *      accepted at write time is never rejected here. A malformed
 *      descriptor throws a {@link GadgetCatalogIntegrityError}
 *      naming the offending index.
 *   2. **Catalog lint** — `lintGadgetCatalog` runs over the RESOLVED
 *      catalog (the union `list()` actually serves), so cross-floor
 *      collisions — a declared export name clashing with a stdlib
 *      export — are caught. Any warning whose code is in
 *      `FATAL_CATALOG_LINT_CODES` throws. Raw-level fatal codes
 *      (duplicate package, immutable-bundle mutation) are enforced at
 *      the WRITE boundaries instead (CLI install gate, cloud config
 *      write gate): both shipped stores pre-resolve via `composeApp`,
 *      so this read path never sees raw declared rows in production.
 *      Soft warnings are not surfaced here — they ride the
 *      authoring-tool path, not the read path.
 *
 * The adapter NEVER returns a partially-valid catalog: either every
 * descriptor passes or `list()` throws. This matches the
 * {@link GadgetCatalogAdapter} contract ("adapters MUST throw on
 * retrieval failure rather than returning an empty array").
 */

import {
  FATAL_CATALOG_LINT_CODES,
  lintGadgetCatalog,
  resolveAppGadgets,
  strictGadgetDescriptorSchema,
  type GadgetDescriptor,
} from '@ggui-ai/protocol';
import type { AppMetadataStore } from './app-metadata-store.js';

/**
 * One catalog-integrity violation — a descriptor that failed schema
 * validation, or a fatal `lintGadgetCatalog` finding.
 */
export interface GadgetCatalogViolation {
  /** Lint code, or `'schema'` for a Zod parse failure. */
  readonly code: string;
  /** Dotted path to the offending descriptor / field. */
  readonly path: string;
  /** Human-readable description of the violation. */
  readonly message: string;
}

/**
 * Thrown by {@link AppMetadataGadgetCatalog.list} when the resolved
 * `App.gadgets` catalog fails schema validation or carries a fatal
 * `lintGadgetCatalog` finding (duplicate hook, immutable-bundle
 * mutation).
 *
 * A corrupt catalog is a hard stop — the boilerplate generator emits
 * one import per hook, so a duplicate-hook catalog produces
 * unresolvable module-scope collisions. Failing here turns the
 * corruption into an observable error at the catalog boundary instead
 * of an opaque generation failure downstream.
 */
export class GadgetCatalogIntegrityError extends Error {
  readonly code = 'gadget_catalog_integrity' as const;
  readonly appId: string;
  readonly violations: readonly GadgetCatalogViolation[];
  constructor(appId: string, violations: readonly GadgetCatalogViolation[]) {
    const lines = violations.map(
      (v) => `  - [${v.code}] ${v.path}: ${v.message}`,
    );
    super(
      `gadget_catalog_integrity: App.gadgets for app \`${appId}\` failed catalog validation:\n${lines.join(
        '\n',
      )}`,
    );
    this.name = 'GadgetCatalogIntegrityError';
    this.appId = appId;
    this.violations = violations;
  }
}

/**
 * `GadgetCatalogAdapter` backed by an {@link AppMetadataStore}.
 *
 * Structurally satisfies `GadgetCatalogAdapter` from
 * `@ggui-ai/gadgets` (single method `list(appId)`); the conformance is
 * type-checked at the `createUiGenerator({ gadgetCatalog })` /
 * `CachingGadgetCatalog` wiring sites and pinned by a type assertion
 * in this module's test. Not declared with `implements` so
 * `@ggui-ai/mcp-server-core` need not take a runtime dependency on the
 * wrapper-author SDK.
 */
export class AppMetadataGadgetCatalog {
  readonly #store: AppMetadataStore;

  constructor(store: AppMetadataStore) {
    this.#store = store;
  }

  /**
   * Resolve, validate, and lint the registered gadget catalog for
   * `appId`. Falls back to `STDLIB_GADGETS` when the store has no
   * record for the app (matching the store's own default-on-read
   * behavior). Throws {@link GadgetCatalogIntegrityError} on any
   * schema failure or fatal lint finding on the RESOLVED catalog
   * (see the module docstring for why raw-level fatal codes are
   * enforced at write boundaries instead).
   */
  async list(appId: string): Promise<readonly GadgetDescriptor[]> {
    const app = await this.#store.get(appId);
    const declared = app?.gadgets ?? [];

    const violations: GadgetCatalogViolation[] = [];
    declared.forEach((entry, index) => {
      const parsed = strictGadgetDescriptorSchema.safeParse(entry);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          violations.push({
            code: 'schema',
            path: `gadgets[${index}].${issue.path.join('.')}`,
            message: issue.message,
          });
        }
      }
    });

    // Schema failures are reported before the lint runs — `lintGadgetCatalog`
    // assumes well-formed descriptors (it reads `hook` / `package` /
    // `version` / `bundleSri` unconditionally).
    if (violations.length > 0) {
      throw new GadgetCatalogIntegrityError(appId, violations);
    }

    // Lint the RESOLVED catalog — the union `list()` actually serves
    // to the generator, so cross-floor collisions (a declared export
    // name clashing with a stdlib export) are caught here. Raw-level
    // fatal codes (duplicate package, immutable-bundle mutation) are
    // NOT re-checked on this path: both shipped stores pre-resolve via
    // `composeApp`, so `list()` never sees raw declared rows in
    // production — those codes are enforced where WRITES happen (the
    // CLI install gate and the cloud config write gate).
    const resolved = resolveAppGadgets(declared);
    const fatal = lintGadgetCatalog(resolved).filter((w) =>
      FATAL_CATALOG_LINT_CODES.has(w.code),
    );
    if (fatal.length > 0) {
      throw new GadgetCatalogIntegrityError(
        appId,
        fatal.map((w) => ({
          code: w.code,
          path: w.path,
          message: w.message,
        })),
      );
    }

    return resolved;
  }
}
