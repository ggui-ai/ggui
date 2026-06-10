/**
 * Zod schema for {@link DataContract} — the canonical wire shape for
 * agent-authored contract declarations.
 *
 * ## Why this file exists
 *
 * Output-side seams that type-narrow contract on the wire —
 * `renderOutputSchema.contract` and the various `decision` echoes — use
 * `z.custom<DataContract>()` because they trust the shape (it
 * originates from internal pod state).
 *
 * The input seam is different: agents author contract on
 * `story.contract` and the handler MUST plumb them to the generator.
 * `z.custom<DataContract>()` does NOT work on input schemas — the
 * MCP SDK serializes input schemas as JSON Schema for `tools/list`,
 * and `z.custom<T>()` has no JSON-Schema representation (it's a
 * TypeScript-only escape hatch). The narrow alternative
 * (`z.record(z.string(), z.unknown())`) erases the type and forces
 * `as DataContract` casts downstream, which violates the project's
 * Zero Workarounds Policy + Strict Typing First principle.
 *
 * The fundamental fix is this file: a real zod schema mirroring the
 * `DataContract` interface field-for-field. Both the protocol's
 * `handshakeInputSchema` and the OSS handler's `inputSchema` build
 * their `contract?` field from `dataContractSchema`, the type derives
 * via `z.infer`, and JSON-Schema serialization for MCP `tools/list`
 * advertises the contract surface to agents.
 *
 * ## Shape source of truth
 *
 * The TS interface in `../types/data-contract.ts` remains the
 * declared source of truth (consumers import the type). This file's
 * schemas are a structural mirror — `dataContractSchema` is typed
 * `z.ZodType<DataContract>` so any drift between schema and
 * interface fails compile. A future cleanup can flip the relationship
 * (TS via `z.infer`), but that's a broader refactor.
 *
 * ## JsonSchema posture
 *
 * Every nested `schema: JsonSchema` field on contract entries
 * (PropEntry, ActionEntry, StreamChannelEntry, ContextEntry, ...)
 * accepts `jsonSchemaSchema` — a permissive `z.object` over the
 * known JSON Schema draft-07 subset {@link JsonSchema} declares,
 * with `passthrough()` for fields the shape doesn't enumerate. We
 * deliberately do NOT enforce JSON Schema's full grammar at this
 * layer — that work belongs in
 * `@ggui-ai/protocol/validation/schema-subset` and runs at
 * render-time + blueprint-registration-time as the F4 schema
 * compatibility checker. Agents authoring malformed schemas surface
 * at that pass with a named violation reason; this layer's job is
 * just to accept the contract and pass it to the generator.
 */

import { z } from 'zod';
import { KNOWN_PERMISSION_NAMES } from '../validation/hygiene-rules';
import { STDLIB_GADGETS_PACKAGE } from '../gadgets/stdlib-gadgets';
import { COMPONENT_NAME_RE, HOOK_NAME_RE } from './gadget-name-grammar';
import type {
  DataContract,
  JsonValue,
  JsonSchema,
} from '../types/data-contract';

/**
 * Recursive {@link JsonValue} — string | number | boolean | null |
 * array | object. All fields on contract entries that carry default
 * values, examples, or arbitrary JSON payloads use this.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    // JsonObject is `{[key: string]: JsonValue | undefined}`. zod's
    // `record` on the value side accepts `JsonValue`; missing keys
    // surface as `undefined` at runtime which JSON.stringify drops.
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * {@link JsonSchema} — JSON Schema draft-07 subset. Mirrors the
 * fields the TS interface enumerates. `additionalProperties` and
 * `items` are recursive — kept loose (`z.unknown()`) to avoid
 * deep `z.lazy` chains; the F4 schema-subset checker validates
 * full structural correctness at render time.
 */
export const jsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z
    .object({
      type: z
        .enum([
          'string',
          'number',
          'integer',
          'boolean',
          'array',
          'object',
          'null',
        ])
        .optional(),
      description: z.string().optional(),
      enum: z.array(jsonValueSchema).optional(),
      default: jsonValueSchema.optional(),
      example: jsonValueSchema.optional(),
      items: jsonSchemaSchema.optional(),
      properties: z.record(z.string(), jsonSchemaSchema).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z
        .union([jsonSchemaSchema, z.boolean()])
        .optional(),
      format: z.string().optional(),
    })
    .passthrough() as z.ZodType<JsonSchema>,
);

/**
 * {@link PropEntry} — per-prop metadata in a {@link PropsSpec}.
 *
 * Shape: `{schema: {type:'string', ...}, required?, default?, ...}`.
 * The JSON Schema NEVER sits flat at the entry level — every entry's
 * schema lives in `.schema`. Authors writing `{type:'string'}` instead
 * of `{schema: {type:'string'}}` will hit a shape error at render time.
 */
export const propEntrySchema = z
  .object({
    description: z.string().optional(),
    schema: jsonSchemaSchema,
    required: z.boolean().optional(),
    default: jsonValueSchema.optional(),
    example: jsonValueSchema.optional(),
    sourceTool: z.string().optional(),
  })
  .strict();

/** {@link PropsSpec} — wrapper `{description?, properties}` over the per-prop map. */
export const propsSpecSchema = z
  .object({
    description: z.string().optional(),
    properties: z.record(z.string(), propEntrySchema),
  })
  .strict();

/**
 * {@link ActionEntry} — per-action metadata in an {@link ActionSpec}.
 *
 * Actions are agent-routed gestures; no dispatch discriminator. Optional
 * `nextStep` hints at the agent's intended next tool call (must resolve
 * to an `agentCapabilities.tools[*]` key on the same contract —
 * cross-ref enforced by the `CTR_REF_NEXT_STEP` linter).
 *
 * Anti-pattern: do NOT write `dispatch: {kind: 'tool', tool: '...'}` —
 * that vocabulary is retired. Use a flat optional `nextStep: '<toolName>'`.
 */
export const actionEntrySchema = z
  .object({
    description: z.string().optional(),
    label: z.string(),
    schema: jsonSchemaSchema.optional(),
    example: jsonValueSchema.optional(),
    icon: z.string().optional(),
    confirm: z.boolean().optional(),
    nextStep: z.string().min(1).optional(),
  })
  .strict();

/** {@link ActionSpec} — flat `Record<name, ActionEntry>`. */
export const actionSpecSchema = z.record(z.string(), actionEntrySchema);

/** {@link StreamChannelEntry} — per-channel metadata in a {@link StreamSpec}. */
export const streamChannelEntrySchema = z
  .object({
    description: z.string().optional(),
    schema: jsonSchemaSchema,
    example: jsonValueSchema.optional(),
    mode: z.enum(['append', 'replace']).optional(),
    replay: z.enum(['latest', 'all', 'none']).optional(),
    complete: z.boolean().optional(),
    source: z
      .object({
        tool: z.string(),
        args: z.record(z.string(), jsonValueSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** {@link StreamSpec} — flat `Record<channel, StreamChannelEntry>`. */
export const streamSpecSchema = z.record(z.string(), streamChannelEntrySchema);

/** {@link ContextEntry} — per-slot metadata in a {@link ContextSpec}. */
export const contextEntrySchema = z
  .object({
    description: z.string().optional(),
    schema: jsonSchemaSchema,
    default: jsonValueSchema.optional(),
    debounceMs: z.number().int().nonnegative().optional(),
    example: jsonValueSchema.optional(),
  })
  .strict();

/** {@link ContextSpec} — flat `Record<slot, ContextEntry>`. */
export const contextSpecSchema = z.record(z.string(), contextEntrySchema);

/** {@link AgentToolEntry} — per-tool metadata in an {@link AgentCapabilitiesSpec}. */
export const agentToolEntrySchema = z
  .object({
    // version is OPTIONAL: a Tier-2 author derives serverInfo.name from the
    // mcp__<server>__ prefix and has no version; the catalog (Tier-1) fills both
    // from `initialize`. name stays required — serverInfo without a name carries
    // no identity.
    serverInfo: z.object({ name: z.string(), version: z.string().optional() }).strict().optional(),
    toolInfo: z
      .object({
        inputSchema: jsonSchemaSchema,
        description: z.string().optional(),
        outputSchema: jsonSchemaSchema.optional(),
      })
      .strict(),
    usage: z.string().optional(),
    example: z.object({ input: jsonValueSchema, output: jsonValueSchema }).strict().optional(),
  })
  .strict();

/** {@link AgentCapabilitiesSpec} — wrapper over the per-tool map. */
export const agentCapabilitiesSpecSchema = z
  .object({
    tools: z.record(z.string(), agentToolEntrySchema),
  })
  .passthrough();

/**
 * `App.publicEnv` key regex.
 *
 * Each key in `App.publicEnv` MUST match this pattern. The prefix is
 * the **security boundary** — operators can't accidentally stash
 * sensitive credentials under arbitrary names, and downstream consumers
 * (render gate, bootstrap projection, iframe shim) can rely on the
 * naming convention to mean "public-by-design".
 *
 * Rule: `GGUI_PUBLIC_APP_` prefix, then uppercase letters / digits /
 * underscores, at least one char after the prefix.
 *
 * `GGUI_PUBLIC_USER_*` keys are RESERVED for a future per-user
 * channel. The current regex rejects them so App-side config can't
 * pre-emptively use the namespace.
 *
 * Hoisted above `gadgetDescriptorSchema` so the wrapper's `requires`
 * array can reference it at schema-construction time (TDZ-safe).
 */
export const PUBLIC_ENV_APP_KEY_RE = /^GGUI_PUBLIC_APP_[A-Z0-9_]+$/;

/**
 * Single source of truth for the `requires[]` field shape on gadget
 * descriptors. The wire-permissive `gadgetDescriptorSchema`, the
 * strict `strictGadgetDescriptorSchema`, AND the author-facing
 * `@ggui-ai/artifact-manifest#gadgetManifestSchema` all need an
 * identical `z.array(z.string().regex(PUBLIC_ENV_APP_KEY_RE))`.
 * Exported here so any future tightening (e.g., cap count, dedupe
 * refinement) lives in one place.
 *
 * Entries are App.publicEnv key names — `GGUI_PUBLIC_APP_*`. Wrappers
 * that declare a `requires` key must have a corresponding App-side
 * publicEnv value at render time (gate: `assertPublicEnvSatisfied`).
 */
export const gadgetRequiresSchema = z
  .array(z.string().regex(PUBLIC_ENV_APP_KEY_RE))
  .readonly();

/**
 * SRI hash format for gadget bundles. Registry install writes
 * `bundleSri` in this shape; iframe-runtime emits it verbatim into
 * the `<script integrity>` attribute. Only `sha384` is accepted on
 * purpose:
 *
 *   - SHA-384 is the strongest hash routinely allowed by browsers
 *     for SRI without compatibility caveats (SHA-512 is allowed but
 *     adds no real security over -384 here).
 *   - Pinning a single algorithm makes the publish Lambda's hash
 *     computation and the iframe's verification trivially aligned —
 *     no algorithm negotiation, no ambiguity at audit time.
 *
 * Base64 body is the standard SRI body (RFC 3548 `+/=`, NOT
 * url-safe). The regex permits zero or two `=` pad chars (SHA-384
 * digest is 48 bytes = base64 length 64 with no padding).
 */
export const BUNDLE_SRI_RE = /^sha384-[A-Za-z0-9+/]+=*$/;

/**
 * Bare npm package name. Either an unscoped name (`leaflet`) or a
 * scoped name (`@my-org/leaflet`). Mirrors the
 * `validate-npm-package-name` subset that nearly every modern
 * registry accepts:
 *
 *   - Lowercase alphanumerics + `.` + `_` + `-`.
 *   - First char of name (and scope, if present) MUST be alphanumeric
 *     — leading `.`/`_`/`-` rejected to match historical npm bans.
 *   - At most one optional `@scope/` prefix.
 *
 * Examples that pass:
 *   - `leaflet`, `react-router`, `@ggui-ai/gadgets`, `@my-org/foo.bar`
 *
 * Examples that fail:
 *   - `@scope/@other/name` (multi-scope)
 *   - `https://registry.ggui.ai/foo` (URL — registry choice lives on
 *     `bundleUrl` / `typesUrl`, not `package`)
 *   - `Leaflet` (uppercase)
 *   - `.foo` / `_foo` / `-foo` (leading non-alphanumeric)
 */
export const NPM_PACKAGE_NAME_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * Exact semver pin (e.g., `0.0.1`, `1.2.3-beta.1`, `2.0.0+build.7`).
 * No ranges (`^`, `~`, `>=`), no leading `v`, no wildcards.
 *
 * Why pin-only: the cache key for a generated UI is
 * `hashContract(wire, intent)` — making the wire carry an exact
 * version means cache invalidation is a pure function of the wire
 * bytes (no canonicalize step). Version bumps produce new wire →
 * fresh generation; forensics are observable from storage alone.
 *
 * Grammar mirrors semver 2.0 spec:
 *   `MAJOR.MINOR.PATCH(-PRERELEASE)?(+BUILD)?`
 * Pre-release + build identifiers match `[\w.]+` (semver's
 * dot-separated alphanumeric identifiers).
 */
export const SEMVER_PIN_RE = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;

/**
 * Hostname-only regex for `bundleHost` — the registry hostname (no
 * scheme, no path) that the server prepends `https://` to and
 * appends the canonical `/bundles/<scope>/<name>/<version>/{bundle.js,style.css}`
 * suffix to when resolving a gadget's URLs at render time.
 *
 * Examples that pass:
 *   - `registry.ggui.ai` (spec default)
 *   - `dev.registry.sandbox.ggui.ai`
 *   - `sandbox-ggui-main.registry.sandbox.ggui.ai`
 *   - `localhost:8787` (port permitted for local registries)
 *
 * Examples that fail (caught at register-time):
 *   - `https://registry.ggui.ai` (scheme not allowed; use `bundleUrl`
 *     full-URL escape hatch if you need non-HTTPS or a non-standard path)
 *   - `/leaflet@0.0.1/bundle.js` (path not allowed)
 *   - `Registry.Ggui.Ai` (must be lowercase; DNS names are
 *     case-insensitive but we pin lower for canonicalization)
 */
export const BUNDLE_HOST_RE = /^[a-z0-9.-]+(:\d+)?$/;

/**
 * Spec-default registry hostname applied when neither operator
 * (`app.gadgets[*].bundleHost`) nor gadget manifest
 * (`ggui.gadget.json#bundleHost`) declares one. The server's URL
 * resolver falls through here last, so first-party + hosted-registry
 * publishes "just work" without explicit operator config.
 */
export const DEFAULT_BUNDLE_HOST = 'registry.ggui.ai';

/**
 * Loopback `bundleHost` predicate — anchored regex matching the three
 * IP/hostname pairs that resolve to localhost: `localhost`, `127.0.0.1`,
 * `0.0.0.0` (each optionally suffixed with a port). Anchoring at both
 * ends prevents `localhost-evil.com` from being treated as loopback.
 *
 * Used symmetrically by:
 *   - `buildInstallCommand` (publish CLI) to emit `http://localhost:PORT`
 *     in the printed `ggui gadget install ...` line.
 *   - `resolveGadgetUrls` (render-time bootstrap derivation) to compute
 *     `http://localhost:PORT/bundles/...` so iframe fetches a reachable
 *     URL during local-dev / sandbox-registry workflows.
 *
 * If install + render disagreed on scheme, an operator running a local
 * registry would publish via `http://` then have render emit `https://`
 * and silently fail in the iframe (mixed-content block in the host's
 * sandboxed context).
 */
export const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/;

/**
 * Compute the scheme (`http` / `https`) for a given `bundleHost`.
 * Loopback hosts get `http://`; everything else gets `https://`.
 *
 * Centralized so any future scheme-policy change (e.g., allowing
 * `https://` on a self-signed local cert) updates one site.
 */
export function bundleHostScheme(host: string): 'http' | 'https' {
  return LOOPBACK_HOST_RE.test(host) ? 'http' : 'https';
}

/**
 * `HOOK_NAME_RE` + `COMPONENT_NAME_RE` are defined in the
 * dependency-free leaf {@link module:schemas/gadget-name-grammar} and
 * re-exported here so the package barrel surface is unchanged. The
 * leaf placement breaks the import cycle that would otherwise form
 * between this module and `validation/hygiene-rules.ts` (which also
 * needs the grammars and which this module imports
 * `KNOWN_PERMISSION_NAMES` from).
 */
export { HOOK_NAME_RE, COMPONENT_NAME_RE } from './gadget-name-grammar';

/**
 * Per-export field shape shared by both export-schema postures —
 * `gotchas`. Teaching text (`description` / `usage` / `example`) and
 * `permission` differ between wire-permissive and registry-strict, so
 * they are spread per-posture below.
 */
const baseExportFieldsShape = {
  gotchas: z.string().optional(),
} as const;

/**
 * Wire-permissive per-export metadata: teaching text optional,
 * `permission` free-form.
 */
const permissiveExportMetaShape = {
  ...baseExportFieldsShape,
  description: z.string().optional(),
  usage: z.string().optional(),
  example: jsonValueSchema.optional(),
  permission: z.string().optional(),
} as const;

/**
 * Registry-strict per-export metadata: teaching text REQUIRED,
 * `permission` enum-tight ({@link KNOWN_PERMISSION_NAMES}).
 */
const strictExportMetaShape = {
  ...baseExportFieldsShape,
  description: z.string().min(1),
  usage: z.string().min(1),
  example: jsonValueSchema,
  permission: z.enum(KNOWN_PERMISSION_NAMES).optional(),
} as const;

/**
 * Package-level field shape shared by `gadgetDescriptorSchema` and
 * `strictGadgetDescriptorSchema`. Identity (`package` + `version`) +
 * transport metadata (`bundleUrl` / `bundleHost` / `bundleSri` /
 * `styleUrl` / `connect` / `requires` / `typesUrl` / `typesSri`) —
 * all per-PACKAGE. The two descriptor schemas differ only in their
 * `exports` element schema (permissive vs strict).
 */
const basePackageFieldsShape = {
  // Identity tuple `(package, version)`. Pin-only semver per
  // {@link SEMVER_PIN_RE}.
  version: z.string().regex(SEMVER_PIN_RE),
  package: z.string().regex(NPM_PACKAGE_NAME_RE),
  // Full URL shape — non-URL strings would crash the iframe's
  // `import(<bundleUrl>)` at runtime.
  bundleUrl: z.url().optional(),
  // Hostname-only constraint (see {@link BUNDLE_HOST_RE}).
  bundleHost: z.string().regex(BUNDLE_HOST_RE).optional(),
  // SHA-384 SRI hash; registry-emitted, hand-authored refs may omit.
  bundleSri: z.string().regex(BUNDLE_SRI_RE).optional(),
  styleUrl: z.url().optional(),
  // CSP `connect-src` feed — full URL shape on every entry.
  connect: z.array(z.url()).readonly().optional(),
  // Shared `gadgetRequiresSchema`.
  requires: gadgetRequiresSchema.optional(),
  // HTTPS URL of the package's `.d.ts`. The handler fetches it at
  // render time, SRI-verifies against `typesSri`, and loads it into the
  // code-gen sandbox VFS. Optional at the base shape;
  // `registeredGadgetDescriptorSchema` refines it to REQUIRED for
  // non-stdlib packages.
  typesUrl: z.url().optional(),
  // SHA-384 SRI over the `.d.ts` bytes; registry-emitted. Reuses
  // `BUNDLE_SRI_RE` — same `sha384-<base64>` shape as `bundleSri`.
  typesSri: z.string().regex(BUNDLE_SRI_RE).optional(),
} as const;

/**
 * Wire-permissive {@link GadgetExport} schema — a union of a
 * hook-export shape (carries `hook`) and a component-export shape
 * (carries `component`); the identifier field present is the natural
 * discriminator. Each member is `.strict()`, so an entry carrying
 * BOTH `hook` and `component` is rejected. Teaching text is optional
 * so contract authoring stays cheap; the registry-side
 * {@link strictGadgetExportSchema} requires it.
 */
export const gadgetExportSchema = z.union([
  z
    .object({
      hook: z.string().regex(HOOK_NAME_RE),
      ...permissiveExportMetaShape,
    })
    .strict(),
  z
    .object({
      component: z.string().regex(COMPONENT_NAME_RE),
      ...permissiveExportMetaShape,
    })
    .strict(),
]);

/**
 * Registry-strict {@link GadgetExport} schema — teaching text
 * REQUIRED, `permission` enum-tight. Used as the `exports` element
 * schema inside {@link strictGadgetDescriptorSchema}.
 */
export const strictGadgetExportSchema = z.union([
  z
    .object({
      hook: z.string().regex(HOOK_NAME_RE),
      ...strictExportMetaShape,
    })
    .strict(),
  z
    .object({
      component: z.string().regex(COMPONENT_NAME_RE),
      ...strictExportMetaShape,
    })
    .strict(),
]);

/**
 * {@link GadgetDescriptor} — a gadget PACKAGE: identity + transport
 * metadata + an `exports` array (≥1). Permissive shape: per-export
 * teaching text is optional so contract authoring stays cheap.
 * Registry-side registration uses the stricter
 * {@link strictGadgetDescriptorSchema}.
 */
export const gadgetDescriptorSchema = z
  .object({
    ...basePackageFieldsShape,
    exports: z.array(gadgetExportSchema).min(1),
  })
  .strict();

/**
 * Registry-side {@link GadgetDescriptor} validator. Stricter than the
 * wire schema: every export's `description` / `usage` / `example` is
 * REQUIRED and `permission` is enum-tight — via
 * {@link strictGadgetExportSchema} as the `exports` element schema.
 *
 * Used by:
 *   - `createGguiGadget` SDK factory (validates wrapper specs).
 *   - `App.gadgets` registration handlers (ggui.json seed,
 *     ops_register_gadget, etc.).
 *
 * Same TS interface as the wire schema — the strictness lives in zod
 * refinements, not the type system.
 */
export const strictGadgetDescriptorSchema = z
  .object({
    ...basePackageFieldsShape,
    exports: z.array(strictGadgetExportSchema).min(1),
  })
  .strict();

/**
 * Registration-ready descriptor validator.
 * {@link strictGadgetDescriptorSchema} plus the refinement that
 * every non-stdlib package MUST carry a `typesUrl`.
 *
 * Two boundaries, two schemas:
 *
 *   - `strictGadgetDescriptorSchema` — **author time**. The
 *     `createGguiGadget` SDK factory validates a wrapper spec at
 *     module load, BEFORE the build emits a `.d.ts` — `typesUrl`
 *     doesn't exist yet, so it can't be required here.
 *   - `registeredGadgetDescriptorSchema` — **registration time**.
 *     The build helper (`writeDescriptorJson`) and the `App.gadgets`
 *     registration handlers validate here, AFTER the build has
 *     emitted the `.d.ts`, computed its SRI, and stamped
 *     `typesUrl` + `typesSri` on the descriptor.
 *
 * The code-gen sandbox loads the `.d.ts` the URL points at to
 * typecheck generated component code against the package's real
 * export signatures. Stdlib (`@ggui-ai/gadgets`) is exempt — the
 * sandbox loads its types directly. No permissive fallback:
 * pre-launch posture forces strict typing across the board.
 */
export const registeredGadgetDescriptorSchema =
  strictGadgetDescriptorSchema.refine(
    (entry) =>
      entry.package === STDLIB_GADGETS_PACKAGE ||
      typeof entry.typesUrl === 'string',
    {
      message:
        'registered GadgetDescriptor MUST declare a `typesUrl` (HTTPS URL to the package\'s .d.ts) — the code-gen sandbox loads it to typecheck generated component code against the export signatures. Run `tsup --dts` (or `tsc --declaration`) in the wrapper build and publish the emitted .d.ts. Only the first-party `@ggui-ai/gadgets` stdlib is exempt.',
      path: ['typesUrl'],
    },
  );

// `package` + `version` are required on every descriptor (mirroring
// the wire's `(hook, package, version)` identity tuple), so there is
// no "at least one of package / bundleUrl / bundleHost" refinement
// and no "bundleHost requires package + version" refinement.

/**
 * Wire-side per-export USE entry on `clientCapabilities.gadgets`.
 *
 * The export NAME is the map key (see {@link gadgetPackageUseSchema});
 * its grammar discriminates kind — a `use`-prefixed key is a hook, a
 * PascalCase key is a component. Kind is therefore never a field.
 *
 * The only wire-authored payload is optional intent-specific prose:
 *
 *   - `description?` / `usage?` — when present the agent's prose wins
 *     over the registered export's text; when omitted, render-time
 *     resolution inherits the registered text verbatim.
 *
 * Everything else — `version`, transport metadata, `permission`,
 * `example`, `gotchas` — is registry-side and resolves from the
 * `App.gadgets` catalog. `.strict()` so a hallucinated registry field
 * fails loudly instead of being silently dropped.
 */
export const gadgetExportUseSchema = z
  .object({
    description: z.string().optional(),
    usage: z.string().optional(),
  })
  .strict();

/**
 * Wire-side per-PACKAGE gadget use — the value type of
 * `clientCapabilities.gadgets` (which is keyed by npm package name).
 *
 * A map of export name → {@link gadgetExportUseSchema}; at least one
 * entry. The export name key is a `use`-prefixed hook
 * ({@link HOOK_NAME_RE}) or a PascalCase component
 * ({@link COMPONENT_NAME_RE}). The wire carries identity only —
 * `(package, export name)` — never `version` or transport metadata;
 * there is no package-level wire field, so the package entry IS its
 * export map (no `exports` wrapper).
 */
export const gadgetPackageUseSchema = z
  .record(
    z
      .string()
      .refine((s) => HOOK_NAME_RE.test(s) || COMPONENT_NAME_RE.test(s), {
        message:
          'gadget export name must be a `use`-prefixed hook or a PascalCase component identifier',
      }),
    gadgetExportUseSchema,
  )
  .refine((r) => Object.keys(r).length > 0, {
    message:
      'a `clientCapabilities.gadgets` package entry must declare at least one export',
  });

/**
 * {@link ClientCapabilitiesSpec} — wrapper over the package-keyed
 * gadget map.
 *
 * `gadgets` is keyed by npm PACKAGE name; each value is a
 * {@link gadgetPackageUseSchema} listing the exports of that package
 * the UI uses. The wire carries identity only — `(package, export
 * name)` — never `version` or transport metadata: the ggui server
 * resolves the full {@link GadgetDescriptor} from the `App.gadgets`
 * catalog at render time onto the `ComponentGguiSession.gadgetDescriptors`
 * sidecar (the `gadgetDescriptors` field of the `GguiSession` union member).
 *
 * `.strict()` (not `.passthrough()`): the retired `libraries` field
 * (renamed to `gadgets`) and any other stale sibling field MUST fail
 * loudly at parse time.
 */
export const clientCapabilitiesSpecSchema = z
  .object({
    gadgets: z.record(
      z.string().regex(NPM_PACKAGE_NAME_RE),
      gadgetPackageUseSchema,
    ),
  })
  .strict();

/**
 * Zod schema for `App.publicEnv`.
 *
 * Flat `Record<string, string>` with key-regex enforcement
 * ({@link PUBLIC_ENV_APP_KEY_RE}). Empty-string values are allowed
 * (operator may want "intentionally absent" without dropping the key).
 *
 * Consumed by:
 *   - OSS `ggui.json#app.publicEnv` boot-time parse.
 *   - Cloud AppRecord persistence layer.
 *   - Defensive re-validation in the iframe-runtime slice-meta
 *     extractors (`parseMetaFromGlobal`, `parseMetaFromToolResult`).
 */
export const appPublicEnvSchema = z
  .record(z.string().regex(PUBLIC_ENV_APP_KEY_RE), z.string())
  .readonly();

/**
 * {@link DataContract} — the unified four-spec contract surface
 * agents author on `story.contract` and that the generator
 * constrains the LLM to honor.
 *
 * Fields per the TS interface: `propsSpec` / `actionSpec` / `streamSpec` /
 * `contextSpec` (the four typed surfaces), `agentCapabilities` (MCP
 * tool catalog) + `clientCapabilities` (browser-capability hook
 * catalog). All fields are optional — agents declare only what their UI
 * uses. `intent` is NOT a contract field; internal consumers (prompt
 * rendering, contract hash, cache scope) receive intent from the outer
 * pipeline (the flat `intent` field on `ggui_handshake`, the operator
 * prompt for harness benchmarks).
 *
 * No `interaction` mode field — the four specs describe the wire
 * surface exhaustively, so a categorical mode label would be
 * redundant. `passthrough()` below tolerates legacy payloads that
 * still carry it — the field is silently dropped on round-trip.
 *
 * No `broadcast` field — channel data sources are declared per-channel
 * via `streamSpec[ch].source` (flat `{tool, args?}` shape; transport
 * auto-negotiated at runtime by `@ggui-ai/wire`).
 *
 * `passthrough()` lets unknown fields ride through without rejection
 * — forward-compatible with future protocol additions, and matches
 * the protocol's general "input-shape lax / validator-shape strict"
 * posture (`handshakeInputSchema`, `renderInputSchema`, etc. all
 * `passthrough` for the same reason).
 */
export const dataContractSchema: z.ZodType<DataContract> = z
  .object({
    propsSpec: propsSpecSchema.optional(),
    actionSpec: actionSpecSchema.optional(),
    streamSpec: streamSpecSchema.optional(),
    contextSpec: contextSpecSchema.optional(),
    agentCapabilities: agentCapabilitiesSpecSchema.optional(),
    clientCapabilities: clientCapabilitiesSpecSchema.optional(),
  })
  .passthrough() as z.ZodType<DataContract>;
