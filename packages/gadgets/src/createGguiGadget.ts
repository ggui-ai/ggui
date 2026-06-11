/**
 * `createGguiGadget` — the plugin SDK factory for ggui client
 * library wrappers.
 *
 * Authors compose 3rd-party JS libraries (Leaflet, Mapbox, Stripe,
 * Chart.js, …) into stable React hooks that satisfy
 * {@link GadgetHook}. The factory:
 *
 *   1. Strictly validates the spec at call time via
 *      `strictGadgetDescriptorSchema` — `package` (npm name) and a
 *      pin-only semver `version` are REQUIRED on every descriptor,
 *      teaching text (`description` / `usage` / `example`) is
 *      REQUIRED and non-empty, URL fields (`bundleUrl` / `styleUrl` /
 *      `typesUrl`) must be full URLs — plus a non-function `hookImpl`
 *      check the schema can't see. Throws
 *      {@link WrapperConformanceError} with field-level paths on any
 *      violation. (`typesUrl` is not required HERE — at author time
 *      the build hasn't emitted a `.d.ts` yet — but registration via
 *      `registeredGadgetDescriptorSchema` requires it for every
 *      non-stdlib package.)
 *   2. Returns the React hook function as the primary export, with
 *      the serializable {@link GadgetDescriptor} descriptor attached
 *      as `.descriptor`. Single export, dual purpose:
 *
 *      ```ts
 *      export const useLeafletMap = createGguiGadget({
 *        hook: 'useLeafletMap',
 *        description: '...',
 *        usage: '...',
 *        example: { ... },
 *        package: '@my-org/ggui-leaflet',
 *        version: '0.1.0',
 *        styleUrl: 'https://cdn.example.com/ggui-leaflet/leaflet.css',
 *        hookImpl: (options) => { …real React hook… },
 *      });
 *
 *      // Call as a React hook from generated component code:
 *      const map = useLeafletMap({ center: [0, 0], zoom: 2 });
 *
 *      // Register on App.gadgets via the descriptor:
 *      app.gadgets.push(useLeafletMap.descriptor);
 *      ```
 *
 * Why no `bind: (lib) => …` indirection: wrappers bundle their
 * underlying dependencies at build time (per the "ggui hosts every
 * bundle" model that the CSP derivation depends on). Authors `import L
 * from 'leaflet'` inside the wrapper and tsup/esbuild rolls it into
 * the published bundle. The factory doesn't need to load 3rd-party
 * libs at runtime — just validate the spec + plumb the descriptor.
 *
 * Why no separate `HookResult` shape: the existing protocol
 * {@link GadgetHook} already nails the return contract
 * (`{value, status, error?, start, stop?}`). Re-using it keeps
 * stdlib hooks and 3rd-party plugins indistinguishable at the
 * consumption site — generated component code calls them the same
 * way.
 */

import {
  strictGadgetDescriptorSchema,
  type GadgetDescriptor,
  type GadgetExportBase,
  type GadgetHook,
  type GadgetHookExport,
  type JsonValue,
} from '@ggui-ai/protocol';

/**
 * Author input to {@link createGguiGadget}. A `createGguiGadget` call
 * builds a gadget PACKAGE that exposes exactly one HOOK export — so
 * the spec keeps the per-export teaching fields flat (`hook`,
 * `description`, `usage`, `example`, `gotchas`, `permission`)
 * alongside the package identity + transport fields
 * (`package`, `version`, `bundleUrl`, …) and a `hookImpl` runtime
 * function. The factory assembles these into a
 * {@link GadgetDescriptor} of the package+exports shape.
 *
 * Generic over `TOutput` / `TOptions` so consumers get type-safe
 * value + options surfaces. Defaults to `void` / `unknown` for hooks
 * that take no options.
 */
export interface GguiGadgetSpec<TOutput, TOptions = void>
  extends Omit<GadgetDescriptor, 'exports'>,
    Omit<GadgetExportBase, 'description' | 'usage' | 'example'> {
  /**
   * Hook name — `use`-prefixed camelCase. Becomes the single hook
   * export of the assembled descriptor.
   */
  hook: string;
  /** REQUIRED — see {@link GadgetExportBase.description}. */
  description: string;
  /** REQUIRED — see {@link GadgetExportBase.usage}. */
  usage: string;
  /** REQUIRED — see {@link GadgetExportBase.example}. */
  example: JsonValue;
  /**
   * The React hook implementation. Conforms to
   * {@link GadgetHook} — same shape stdlib hooks satisfy.
   * Authors `import` underlying 3rd-party libs at build time and
   * compose inside this function.
   */
  hookImpl: GadgetHook<TOutput, TOptions>;
}

/**
 * Output of {@link createGguiGadget} — the React hook
 * function with the serializable {@link GadgetDescriptor}
 * descriptor attached as `.descriptor`. Authors export this as their
 * primary surface; consumers call it as a hook and operators
 * register the descriptor.
 */
export type GguiGadget<TOutput, TOptions = void> = GadgetHook<
  TOutput,
  TOptions
> & {
  /** Serializable registry entry — register on App.gadgets. */
  readonly descriptor: GadgetDescriptor;
};

/**
 * Conformance violation thrown by the wrapper-author SDK
 * ({@link createGguiGadget} / `defineGadgetPackage`) when the supplied
 * spec fails the strict registry schema or the SDK-specific checks
 * (`impl` shape). Carries the zod issues so authoring tools can
 * highlight individual fields.
 */
export class WrapperConformanceError extends Error {
  readonly code = 'wrapper_conformance' as const;
  readonly violations: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
  }>;
  constructor(
    /** Identifying label for the failing spec — a hook name
     * (`createGguiGadget`) or a package name (`defineGadgetPackage`). */
    label: string | undefined,
    violations: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    const labelTail = label ? ` (${label})` : '';
    const summary = violations
      .map((v) => `  - ${v.path.join('.') || '<root>'}: ${v.message}`)
      .join('\n');
    super(`gadget spec conformance failed${labelTail}\n${summary}`);
    this.name = 'WrapperConformanceError';
    this.violations = violations;
  }
}

/**
 * Build a ggui gadget. See file-level docstring for
 * the usage pattern.
 *
 * Throws {@link WrapperConformanceError} synchronously when the spec
 * is malformed — caller-time validation means a bad wrapper fails at
 * module-load, not at first invocation.
 */
export function createGguiGadget<TOutput, TOptions = void>(
  spec: GguiGadgetSpec<TOutput, TOptions>,
): GguiGadget<TOutput, TOptions> {
  // Split the flat author spec into its three groups: the runtime
  // `hookImpl`, the package-level identity + transport fields, and
  // the per-export teaching fields. The schema only sees the
  // assembled package+exports descriptor.
  const {
    hookImpl,
    hook,
    description,
    usage,
    example,
    gotchas,
    permission,
    ...packageFields
  } = spec;

  // SDK-side check: hookImpl MUST be a function. Zod can't validate
  // function shape, so we do this manually before the schema parse.
  const violations: Array<{
    path: ReadonlyArray<string | number>;
    message: string;
  }> = [];
  if (typeof hookImpl !== 'function') {
    violations.push({
      path: ['hookImpl'],
      message: '`hookImpl` MUST be a React hook function',
    });
  }

  // Assemble the single hook export. Optional fields are only set
  // when present so the strict schema's `.strict()` element never
  // sees explicit `undefined` keys.
  const hookExport: GadgetHookExport = {
    hook,
    description,
    usage,
    example,
    ...(gotchas !== undefined ? { gotchas } : {}),
    ...(permission !== undefined ? { permission } : {}),
  };
  const descriptorDraft = {
    ...packageFields,
    exports: [hookExport],
  };

  // Registry conformance: required teaching text per export + a
  // well-formed package identity.
  const parsed = strictGadgetDescriptorSchema.safeParse(descriptorDraft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      violations.push({
        // zod's path is `(string | number | symbol)[]`; we coerce
        // symbol segments to strings for our author-facing message.
        path: issue.path.map((segment) =>
          typeof segment === 'symbol' ? segment.toString() : segment,
        ),
        message: issue.message,
      });
    }
  }

  // Narrow on `parsed.success` directly — this both throws on a
  // conformance failure (covering every `violations` entry, which is
  // populated only from `parsed.error`) and gives `parsed.data` its
  // `GadgetDescriptor` type without a cast.
  if (!parsed.success || violations.length > 0) {
    throw new WrapperConformanceError(
      typeof spec.hook === 'string' ? spec.hook : undefined,
      violations,
    );
  }

  // Build the descriptor as a plain serializable object. We
  // deliberately rebuild from the parsed output so unknown keys
  // (already rejected by the strict schema) can never leak through.
  const descriptor: GadgetDescriptor = parsed.data;

  // Compose the dual-purpose return: the hook function + the
  // descriptor as a named property.
  //
  // We can't subclass a function in pure TS, so we use Object.assign
  // to graft the property onto the function reference. The runtime
  // type is `GadgetHook<…> & { descriptor }`.
  const wrapped = ((options?: TOptions) =>
    hookImpl(options)) as GguiGadget<TOutput, TOptions>;
  return Object.assign(wrapped, {
    descriptor: Object.freeze(descriptor),
  });
}
