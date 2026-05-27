/**
 * AppMetadataStore — per-app metadata resolver.
 *
 * Backs the `ggui_list_gadgets` tool: the handler reads `app.gadgets`
 * (defaulting to `STDLIB_GADGETS` from `@ggui-ai/protocol`) and
 * returns the per-app catalog.
 *
 * The interface is intentionally minimal. Future fields (adapters,
 * capabilities, auth mode) can land here additively; consumers MUST
 * treat unknown fields as optional.
 *
 * Reference adapters:
 *   - `InMemoryAppMetadataStore` (this package's `/in-memory` entry) — OSS
 *     single-tenant default + test fixtures. Seeds every registered
 *     app with `STDLIB_GADGETS`.
 *   - Cloud DDB adapter (`cloud/ggui-protocol-pod/src/ddb.ts`)
 *     applies the default-on-read pattern directly inside `getApp`
 *     so existing rows missing `gadgets` survive.
 */

import {
  STDLIB_GADGETS,
  type AppBlueprintSearchConfig,
  type GadgetDescriptor,
  type McpUiDisplayMode,
} from '@ggui-ai/protocol';

/**
 * Per-app metadata record. The core field is `gadgets`, which backs
 * the `ggui_list_gadgets` tool.
 *
 * Implementations MAY carry richer fields (cloud DDB's `AppRecord`
 * already does for adapters/capabilities/etc.) but consumers MUST
 * read only declared fields here. Treat additional fields as
 * adapter-private.
 */
export interface App {
  /** Stable app id. */
  readonly id: string;
  /**
   * Per-app browser-capability gadget catalog. Defaults to
   * `STDLIB_GADGETS` (the 7 v1 hooks) on app registration.
   * Operator UX to mutate this list ships in a follow-up slice; v1
   * every app's catalog = stdlib seed.
   */
  readonly gadgets: readonly GadgetDescriptor[];
  /**
   * Default theme preset id applied to every new render of this app
   * when the agent doesn't pass an explicit `themeId` on
   * `ggui_render`. Sourced from `ggui.json#theme.preset` for the
   * OSS CLI single-tenant case; hosted multi-tenant deployments set
   * per-app values on the App row.
   *
   * Sits at layer 2 of the theme-resolution chain (see
   * `Render.themeId` in `@ggui-ai/protocol` for the full ordering:
   * Render.themeId > App.defaultThemeId > server fallback). Absent
   * ⇒ chain falls through to the server's built-in theme.
   */
  readonly defaultThemeId?: string;
  /**
   * Operator-curated allowlist of theme preset ids this app exposes to
   * agents. When set, `ggui_list_themes` filters the global theme
   * registry to just these ids. Absent ⇒ every registered theme is
   * visible.
   *
   * Use this to scope branding choices (a marketing app may want agents
   * to only see `slate` / `crimson` and never the playful `claudic`
   * preset). Custom operator-defined preset documents are a separate
   * follow-up; today this filters the built-in catalog only.
   */
  readonly availableThemeIds?: readonly string[];
  /**
   * Per-app blueprint-search tunables. Read by the bound
   * `BlueprintSearch` impl to override per-axis weights / threshold /
   * topK. Absent ⇒ global defaults from
   * `@ggui-ai/mcp-server-core/blueprint-search`.
   */
  readonly blueprintSearchConfig?: AppBlueprintSearchConfig;
  /**
   * App-default display-mode hint stamped on every `ggui_render` from
   * this app via `_meta.ui.displayMode`. Honored by hosts as a
   * PRESENTATION preference — `'fullscreen'` says "render as a main
   * view, replacing the previous iframe in the primary slot";
   * `'inline'` says "stack vertically in the chat log"; `'pip'` says
   * "render as picture-in-picture overlay" (reserved).
   *
   * The wire mechanism is identical regardless of mode: every render
   * stamps its own `_meta.ui.resourceUri` and every iframe goes through
   * the same runtime mount path. Display mode controls ONLY how the
   * host arranges the iframes it mounts. Per-render agents can override
   * via `ggui_render.input.displayMode`.
   *
   * Absent ⇒ no per-render hint stamped (host falls back to its own
   * default, typically `'inline'`).
   */
  readonly defaultDisplayMode?: McpUiDisplayMode;
  /**
   * Public environment values the App makes available to registered
   * gadgets via `getPublicEnv()`. Each key
   * MUST match `PUBLIC_ENV_APP_KEY_RE` (`^GGUI_PUBLIC_APP_[A-Z0-9_]+$`,
   * imported from `@ggui-ai/protocol`) — the prefix is the security
   * boundary, NOT a convention. "Public" means visible to anyone with
   * iframe-source access (the renderer's data-URL shim exposes the
   * value verbatim). Sensitive credentials belong on the agent-side
   * tools surface, NOT here.
   *
   * Wrapper authors declare which keys they consume via
   * `GadgetDescriptor.requires`; the push gate
   * (`assertPublicEnvSatisfied`) rejects a push when any declared
   * wrapper's requires aren't satisfied by this map. Bootstrap
   * projection filters the map to the union of declared wrappers'
   * requires before emitting on the iframe envelope (minimum-
   * disclosure).
   *
   * Absent ⇒ no public env values; only wrappers without `requires`
   * can mount. Operator UX:
   *   - OSS: `ggui.json#app.publicEnv` (flat map, edited by hand).
   *   - Cloud: AppRecord persistence layer (AppSync mutation;
   *     marketplace UI in a follow-up slice).
   */
  readonly publicEnv?: Readonly<Record<string, string>>;
}

/**
 * Input to {@link composeApp}. Mirrors every optional field on
 * {@link App} with the same shape — `gadgets` defaults to
 * `STDLIB_GADGETS` when omitted, every other field passes
 * through unchanged. The reason this exists as a separate type rather
 * than `Partial<App>`: `App.gadgets` is REQUIRED, but
 * `ComposeAppInput.gadgets` is OPTIONAL (the composer's whole
 * job is filling the STDLIB default).
 *
 * Adding a new field to `App` should also add it here so consumers
 * benefit from the centralized composer. The compiler enforces that
 * (composeApp's body uses every field, so a missing entry surfaces as
 * a type error in the implementation).
 */
export interface ComposeAppInput {
  readonly id: string;
  readonly gadgets?: readonly GadgetDescriptor[];
  readonly defaultThemeId?: string;
  readonly availableThemeIds?: readonly string[];
  readonly blueprintSearchConfig?: AppBlueprintSearchConfig;
  readonly defaultDisplayMode?: McpUiDisplayMode;
  readonly publicEnv?: Readonly<Record<string, string>>;
}

/**
 * Single source of truth for constructing an {@link App} object from
 * partial input. Applies the `STDLIB_GADGETS` fallback when
 * `gadgets` is omitted; preserves the "absent ⇒ field
 * undefined" semantics for every other optional field (omitting a
 * field means the resulting App.X is `undefined`, NOT some "zero
 * value" like `[]` or `{}` — the OSS contract distinguishes "operator
 * said no" from "operator said empty").
 *
 * Replaces the per-site hand-construction in:
 *   - `InMemoryAppMetadataStore.register()`
 *   - `InMemoryAppMetadataStore.get()` defaults fallback branch
 *   - `dynamoAppMetadataStore.get()` AppRecord → App projection
 *     (cloud/ggui-protocol-pod/src/adapters/dynamo-app-metadata-store.ts)
 *
 * Drift-immune: adding a new field to {@link App} forces a matching
 * field on {@link ComposeAppInput} (the composer body destructures
 * every input field), and every call site picks it up structurally
 * via the same `composeApp({...})` invocation.
 *
 * **Empty-array convention**: `availableThemeIds: []` is treated the
 * same as `availableThemeIds: undefined` (empty list = no filter, same
 * semantics). This matches the pre-extraction behavior of the in-memory
 * + DDB-adapter sites.
 */
export function composeApp(input: ComposeAppInput): App {
  return {
    id: input.id,
    gadgets: input.gadgets ?? STDLIB_GADGETS,
    ...(input.defaultThemeId !== undefined
      ? { defaultThemeId: input.defaultThemeId }
      : {}),
    ...(input.availableThemeIds !== undefined &&
    input.availableThemeIds.length > 0
      ? { availableThemeIds: input.availableThemeIds }
      : {}),
    ...(input.blueprintSearchConfig !== undefined
      ? { blueprintSearchConfig: input.blueprintSearchConfig }
      : {}),
    ...(input.defaultDisplayMode !== undefined
      ? { defaultDisplayMode: input.defaultDisplayMode }
      : {}),
    ...(input.publicEnv !== undefined ? { publicEnv: input.publicEnv } : {}),
  };
}

/**
 * Runtime seam for resolving per-app metadata. Today's only caller is
 * `createGguiListGadgetsHandler`. Future per-app metadata
 * lookups (per-app adapter grants, per-app permission scopes, etc.)
 * hook into the same interface.
 *
 * Implementations SHOULD be cheap (single map lookup or single DDB
 * GetItem on the primary key); production paths sit on the hot path
 * of the `ggui_list_gadgets` tool.
 */
export interface AppMetadataStore {
  /**
   * Return the app record for `appId`, or `null` when the app is not
   * registered. Handlers MAY fall back to a stdlib-default response
   * for the not-found case (sandbox apps that bypass registration).
   */
  get(appId: string): Promise<App | null>;
}
