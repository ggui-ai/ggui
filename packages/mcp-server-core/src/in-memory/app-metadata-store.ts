/**
 * InMemoryAppMetadataStore — reference implementation of {@link AppMetadataStore}.
 *
 * Intended for OSS single-tenant deployments and tests. Apps are
 * registered via {@link register} (or auto-created via {@link getOrCreate})
 * and seeded with `STDLIB_GADGETS` from `@ggui-ai/protocol` so
 * the `ggui_list_gadgets` tool returns a meaningful catalog
 * out of the box.
 *
 * Production multi-tenant bindings (Cloud DDB adapter inside
 * `cloud/ggui-protocol-pod/src/ddb.ts`) apply the same default-on-read
 * pattern directly at the row-projection site so existing rows survive.
 */

import {
  FATAL_CATALOG_LINT_CODES,
  lintGadgetCatalog,
  strictGadgetDescriptorSchema,
  type GadgetDescriptor,
  type McpUiDisplayMode,
} from '@ggui-ai/protocol';
import {
  composeApp,
  type App,
  type AppMetadataStore,
} from '../app-metadata-store.js';

/**
 * Re-validate every gadget descriptor crossing the store boundary
 * against the strict registry-side schema. JSON-parse callers
 * (`parseGguiJson`) already validate, but programmatic callers (test
 * fixtures, custom server bootstraps) handed plain `GadgetDescriptor[]`
 * arrays would otherwise bypass the `package + version + bundleHost`
 * trio refinement + permission-enum tightening + URL-shape checks.
 *
 * Re-parsing here turns the boundary into the "observable violation"
 * point so a malformed gadget surfaces as a Zod throw at registration
 * time instead of silently riding through to render.
 *
 * Returns the list verbatim (parse is identity-shape when valid) so
 * the caller can keep its existing typing. `source` is woven into the
 * thrown ZodError context so multi-call diagnostics name the seam.
 */
function assertGadgetsValid(
  gadgets: readonly GadgetDescriptor[] | undefined,
  source: 'register-input' | 'register-defaults' | 'get-defaults',
): readonly GadgetDescriptor[] | undefined {
  if (!gadgets) return gadgets;
  gadgets.forEach((entry, index) => {
    try {
      strictGadgetDescriptorSchema.parse(entry);
    } catch (cause) {
      // A descriptor is a PACKAGE — name it by its `(package,
      // version)` identity in the error rather than a per-export
      // `hook` (which no longer lives at the descriptor level).
      const pkg = (entry as GadgetDescriptor | undefined)?.package;
      const version = (entry as GadgetDescriptor | undefined)?.version;
      const identity =
        typeof pkg === 'string'
          ? `${pkg}${typeof version === 'string' ? `@${version}` : ''}`
          : '<missing-package>';
      throw new Error(
        `InMemoryAppMetadataStore: gadget[${index}] (${identity}, source=${source}) failed schema validation. See cause for details.`,
        { cause },
      );
    }
  });

  // Registry-side catalog lint at the OSS registration boundary.
  // `assertGadgetsValid` checks each descriptor in
  // isolation; `lintGadgetCatalog` checks the array as a whole.
  // A duplicate hook or an immutable-bundle mutation in
  // `ggui.json#app.gadgets` would otherwise ride silently through to
  // the boilerplate generator (one import per hook ⇒ unresolvable
  // module-scope collision). Only FATAL codes hard-reject here; soft
  // warnings ride the authoring-tool path, not this seam.
  const fatal = lintGadgetCatalog(gadgets).filter((w) =>
    FATAL_CATALOG_LINT_CODES.has(w.code),
  );
  if (fatal.length > 0) {
    throw new Error(
      `InMemoryAppMetadataStore: gadget catalog (source=${source}) failed integrity lint:\n${fatal
        .map((w) => `  - [${w.code}] ${w.path}: ${w.message}`)
        .join('\n')}`,
    );
  }

  return gadgets;
}

/**
 * Optional per-app fields a caller MAY override on registration.
 * `gadgets` and `defaultThemeId` both fall back to undefined
 * when omitted (gadgets to STDLIB seed; themeId to undefined =
 * "no per-app default, fall through to server fallback").
 */
export interface InMemoryAppRegisterInput {
  readonly gadgets?: readonly GadgetDescriptor[];
  readonly defaultThemeId?: string;
  readonly availableThemeIds?: readonly string[];
  /**
   * Default display-mode hint stamped on every render from this app.
   * See `App.defaultDisplayMode` for semantics.
   */
  readonly defaultDisplayMode?: McpUiDisplayMode;
  /**
   * Public env channel values. Stamped on `App.publicEnv` for
   * `getPublicEnv()` to read via the bootstrap projection. Omitted ⇒
   * field absent on the App record (no values projected; wrappers
   * without `requires` still mount, wrappers with `requires` fail
   * `assertPublicEnvSatisfied`).
   */
  readonly publicEnv?: Readonly<Record<string, string>>;
}

/**
 * Construction-time defaults. Single-tenant OSS hosts stamp these
 * once at boot so every appId the handlers see picks up the operator's
 * `ggui.json` values without an explicit `register()` per appId. Per-
 * appId overrides come through {@link InMemoryAppMetadataStore.register}.
 */
export interface InMemoryAppMetadataStoreDefaults {
  readonly defaultThemeId?: string;
  readonly availableThemeIds?: readonly string[];
  /**
   * The operator-declared gadget catalog from `ggui.json#app.gadgets`.
   * Apps the store hasn't seen inherit this list on `App.gadgets`.
   * Omitted ⇒ falls back to `STDLIB_GADGETS`.
   */
  readonly defaultGadgets?: readonly GadgetDescriptor[];
  /**
   * The operator-declared public env channel from
   * `ggui.json#app.publicEnv`. Apps the store hasn't seen inherit this
   * map on `App.publicEnv`. Omitted ⇒ field absent.
   */
  readonly defaultPublicEnv?: Readonly<Record<string, string>>;
  /**
   * Operator-declared display-mode hint from
   * `ggui.json#app.defaultDisplayMode`. Apps the store hasn't seen
   * inherit this value on `App.defaultDisplayMode`. Omitted ⇒ field
   * absent (no per-render hint stamped; host picks its own default).
   */
  readonly defaultDisplayMode?: McpUiDisplayMode;
}

export class InMemoryAppMetadataStore implements AppMetadataStore {
  private readonly apps = new Map<string, App>();
  private readonly defaults: InMemoryAppMetadataStoreDefaults;

  /**
   * Construct an in-memory store. `defaults.defaultThemeId` /
   * `defaults.defaultGadgets` / `defaults.defaultPublicEnv`
   * become the per-app default for every `get(appId)` /
   * `getOrCreate(appId)` call that lands on a never-registered app —
   * single-tenant OSS hosts (one App per process) pass the manifest's
   * theme preset + gadgets catalog + public env here so any
   * appId the handlers see picks up the operator's choices without an
   * explicit `register()` per appId.
   *
   * `register(appId, {defaultThemeId, gadgets, publicEnv})`
   * still overrides per-app for multi-tenant test fixtures that need
   * different defaults.
   */
  constructor(defaults: InMemoryAppMetadataStoreDefaults = {}) {
    // Validate defaults once at construction so a bad operator
    // ggui.json caught by `parseGguiJson` doesn't slip through a
    // programmatic-handoff seam either.
    assertGadgetsValid(defaults.defaultGadgets, 'register-defaults');
    this.defaults = defaults;
  }

  /**
   * Register (or replace) an app entry. Per-app input fields fall back
   * to construction-time defaults (then to STDLIB for `gadgets`,
   * undefined for `publicEnv`) when omitted.
   */
  register(appId: string, input: InMemoryAppRegisterInput = {}): App {
    // Resolution chain: per-app input → construction-time default →
    // STDLIB / undefined (the latter applied inside `composeApp`).
    // This site owns the resolution; `composeApp` owns the final App
    // shape construction. Splitting them keeps the in-memory store
    // free to do per-instance default-merging while every other call
    // site composes from a single source of truth.
    assertGadgetsValid(input.gadgets, 'register-input');
    const resolvedDisplayMode =
      input.defaultDisplayMode ?? this.defaults.defaultDisplayMode;
    const composed = composeApp({
      id: appId,
      gadgets:
        input.gadgets ?? this.defaults.defaultGadgets,
      defaultThemeId:
        input.defaultThemeId ?? this.defaults.defaultThemeId,
      availableThemeIds:
        input.availableThemeIds ?? this.defaults.availableThemeIds,
      ...(resolvedDisplayMode !== undefined
        ? { defaultDisplayMode: resolvedDisplayMode }
        : {}),
      publicEnv: input.publicEnv ?? this.defaults.defaultPublicEnv,
    });
    this.apps.set(appId, composed);
    return composed;
  }

  /**
   * Return an existing app entry or register a fresh one seeded with
   * stdlib. Convenience for paths that may see an `appId` before the
   * deployment had a chance to call {@link register} explicitly
   * (e.g., handler ctx threads `appId='local'` on first request).
   */
  getOrCreate(appId: string): App {
    const existing = this.apps.get(appId);
    if (existing) return existing;
    return this.register(appId);
  }

  async get(appId: string): Promise<App | null> {
    const existing = this.apps.get(appId);
    if (existing) return existing;
    // When defaults are configured at construction, materialize a
    // default-bearing App on read for any appId. Single-tenant OSS hosts
    // pass `defaults.*` once at boot and expect every appId the handlers
    // see to pick up the operator's choices without an explicit
    // `register()` per appId.
    const hasAnyDefault =
      this.defaults.defaultThemeId !== undefined ||
      (this.defaults.availableThemeIds &&
        this.defaults.availableThemeIds.length > 0) ||
      (this.defaults.defaultGadgets &&
        this.defaults.defaultGadgets.length > 0) ||
      this.defaults.defaultPublicEnv !== undefined ||
      this.defaults.defaultDisplayMode !== undefined;
    if (!hasAnyDefault) return null;
    return composeApp({
      id: appId,
      gadgets: this.defaults.defaultGadgets,
      defaultThemeId: this.defaults.defaultThemeId,
      availableThemeIds: this.defaults.availableThemeIds,
      ...(this.defaults.defaultDisplayMode !== undefined
        ? { defaultDisplayMode: this.defaults.defaultDisplayMode }
        : {}),
      publicEnv: this.defaults.defaultPublicEnv,
    });
  }
}
