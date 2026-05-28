/**
 * Current protocol version. Used for cache invalidation and capability discovery.
 *
 * The block comment below is a chronological changelog of protocol
 * wire-shape changes. Each dated entry describes a wire-shape or
 * schema change; the most recent change anchors {@link PROTOCOL_VERSION}.
 *
 * --------------------------------------------------------------------
 * R4 — auth-credential `bootstrap` renamed to `wsToken`; aggregate
 * polling endpoint deleted; console session-meta route renamed
 * (BREAKING, pre-launch):
 *
 *   r4.1. **WS auth-credential field renamed.** The wire field that
 *      authenticates a live-channel subscribe was named "bootstrap" by
 *      historical accident — post-R3 the only thing called "bootstrap"
 *      on the wire was the credential, so the term lost its meaning.
 *      Renamed everywhere internally to `wsToken` (sharper, symmetric
 *      with `wsUrl`):
 *        - {@link SubscribePayload.bootstrap} → `SubscribePayload.wsToken`
 *        - `?bootstrap=<token>` WS upgrade query → `?wsToken=<token>`
 *        - `McpAppAiGguiSessionMeta.token` slice field → `wsToken`
 *        - `ChannelClientBootstrap.token` → `wsToken`
 *        - `bootstrap-tokens.ts` module → `ws-tokens.ts`
 *        - `mintBootstrapToken` / `verifyBootstrapToken` →
 *          `mintWsToken` / `verifyWsToken`
 *        - `refresh-bootstrap.ts` handler → `refresh-ws-token.ts`
 *        - `ggui_runtime_refresh_bootstrap` MCP tool →
 *          `ggui_runtime_refresh_ws_token`
 *        - Server config `bootstrapSecret` → `wsTokenSecret`
 *      The boot-lifecycle observable surface is independent and
 *      survives unchanged: {@link BootstrapFailureReason} +
 *      `ggui:bootstrap-failed` postMessage describe the boot lifecycle
 *      (mounting → code-ready → error), not the credential.
 *
 *   r4.2. **`/api/bootstrap/:shortCode` deleted; `/r/:shortCode`
 *      content-negotiated.** The standalone JSON polling endpoint was
 *      a workaround for `_meta`-stripping hosts + the iframe-runtime's
 *      `PollingTransport`. The HTML at `/r/<shortCode>` already
 *      inlines the same projection via `__GGUI_META__`. Replaced
 *      with one URL, two representations:
 *        - `GET /r/:shortCode` with `Accept: text/html` (or default) →
 *          HTML shell (unchanged byte-for-byte).
 *        - `GET /r/:shortCode` with `Accept: application/json` → slice
 *          envelope (`{"ai.ggui/session": {...}, "ai.ggui/stack-item":
 *          {...}}`), same shape as the wire `_meta` and the inline
 *          `__GGUI_META__` global. Single source of truth.
 *      Consumers (iframe-runtime polling, sample-agent useChat
 *      fallback, future cross-host clients) all migrate to the
 *      content-negotiated endpoint.
 *
 *   r4.3. **Inline global renamed.** `window.__GGUI_BOOTSTRAP__` →
 *      `window.__GGUI_META__`. The "BOOTSTRAP" prefix referred to the
 *      retired aggregate; the global now carries the slice meta pair
 *      (same shape as the wire `_meta`), so the name aligns with what
 *      the global is.
 *
 *   r4.4. **Console meta route renamed.**
 *      `/ggui/console/session-bootstrap?session=<id>` →
 *      `/ggui/console/sessions/:sessionId/meta`. Same JSON response
 *      shape (slice envelope post-R3). Console SessionViewer migrated.
 *
 *   r4.5. **Server-side `StackItemBootstrapView` →
 *      `StackItemMetaView`; `deriveStackItemBootstrapView` →
 *      `deriveStackItemMeta`.** The projection layer's "bootstrap" name
 *      was the last lingering vestige of the deleted aggregate.
 *
 * --------------------------------------------------------------------
 * R3 — `_meta.ggui.bootstrap` aggregate split into per-stability-window
 * slices (#109, BREAKING, pre-launch):
 *
 *   r3.1. **`_meta.ggui.bootstrap` aggregate DELETED from the wire.**
 *      The single-key MCP-Apps envelope ggui shipped for the iframe
 *      runtime is replaced by two per-stability-window keys on `_meta`:
 *
 *        - `_meta["ai.ggui/session"]` — mount-time identity, boot
 *          wiring, live-channel auth, capability advertisements
 *          ({@link McpAppAiGguiSessionMeta}).
 *        - `_meta["ai.ggui/stack-item"]` — the active stack item:
 *          stackItemId, props, action hints, contract pointer,
 *          component-mode discriminator
 *          ({@link McpAppAiGguiStackItemMeta}).
 *
 *      Hosts cache the session slice keyed by `sessionId`; render-only
 *      delta pushes carry just `stack-item`. Auth-rotation pushes carry
 *      just `session`.
 *
 *   r3.2. **`McpAppAiGguiMountView` deleted.** The aggregated TS type
 *      (and its pre-R1 `GguiBootstrapMeta` predecessor) is gone.
 *      Replaced by {@link McpAppAiGguiMeta} = `{session?, stackItem?}`
 *      — the parsed slice pair {@link parseMcpAppAiGguiMeta} returns.
 *      Wire-emitter helpers `mergeSlicesIntoMountView`,
 *      `splitMountViewIntoSlices`, `mountViewToMcpAppMeta`,
 *      `slicesToMcpAppMeta`, `combineMcpAppAiGguiMeta` all retired
 *      in favor of {@link parseMcpAppAiGguiMeta} (parse) +
 *      {@link toMcpAppEnvelope} (emit).
 *
 *   r3.3. **Auth-credential `bootstrap` survives R3.** R3 kept the
 *      `bootstrap` naming on the auth-credential surface
 *      ({@link SubscribePayload.wsToken}, `ws-tokens.ts`, the
 *      `wsTokenSecret` config field, the `mintWsToken` minter, the
 *      `__GGUI_META__` inline global, and the
 *      `ggui_runtime_refresh_ws_token` tool) on the principle that
 *      "bootstrap-the-credential" is a distinct namespace from
 *      "bootstrap-the-aggregate". R4 (entry above) retired that
 *      naming too — the credential namespace is now `wsToken` /
 *      `ws-tokens.*`.
 *
 *   r3.4. **Server projection layer renamed in R4.** R3 kept
 *      `StackItemBootstrapView` + `deriveStackItemBootstrapView` on
 *      the principle that the projection layer is its own namespace.
 *      R4 (entry above) renamed both to `StackItemMetaView` +
 *      `deriveStackItemMeta` — the projection now feeds slice meta
 *      (`{ "ai.ggui/session", "ai.ggui/stack-item" }`), so the
 *      "Meta" naming aligns with what the projection produces.
 *
 * --------------------------------------------------------------------
 * `McpAppAiGguiMeta.compiledValidators` — precompiled eval-free
 * runtime validators (ADDITIVE, non-breaking):
 *
 *   - `McpAppAiGguiMeta` (and the server's `StackItemMetaView`
 *     projection) gain an optional `compiledValidators` field —
 *     `CompiledContractValidators`: ESM validator-module source
 *     strings, one per `propsSpec` / `actionSpec` entry / `streamSpec`
 *     channel / `contextSpec` slot, compiled server-side by
 *     `compileValidatorModule`.
 *   - The renderer iframe runs under a strict CSP with no
 *     `'unsafe-eval'`, so it cannot run `ajv.compile()` (which builds
 *     validators via `new Function`). Validators are now compiled at
 *     push time — where `eval` is legal and the contract schema is
 *     fixed — and shipped; the iframe loads them via `blob:` dynamic
 *     import and only ever RUNS them.
 *   - Additive + optional: a bootstrap without the field is valid;
 *     a consumer that ignores it falls back to the server as the sole
 *     contract authority.
 *
 * --------------------------------------------------------------------
 * Wire `GadgetRef` retired — `clientCapabilities.gadgets` package-keyed,
 * `version` dropped from the wire (BREAKING, pre-launch):
 *
 *   w1. **`clientCapabilities.gadgets` is package-keyed.** The wire map
 *      flipped from `Record<bindingName, GadgetRef>` to
 *      `Record<packageName, GadgetPackageUse>`, where
 *      `GadgetPackageUse = Record<exportName, GadgetExportUse>` and
 *      `GadgetExportUse = { description?, usage? }`. A package entry IS
 *      its export map — the wire has no package-level field, so there
 *      is no `exports` wrapper. The export NAME is the inner map key;
 *      its grammar (`use`-prefixed hook vs PascalCase component)
 *      discriminates kind — there is no `hook` / `component` field and
 *      no arbitrary `binding` name.
 *
 *   w2. **`version` is OFF the wire.** A wire gadget reference carries
 *      identity only — `(package, export name)`. `version` is the
 *      operator's deployment pin in `App.gadgets`, not the agent's to
 *      author: the ggui server resolves the full `GadgetDescriptor`
 *      (version + transport metadata) from the catalog at push time.
 *      The catalog lint enforces ≤1 descriptor per package, so
 *      `(name, package)` resolves to exactly one registered export.
 *
 *   w3. **`GadgetRef` / `GadgetHookRef` / `GadgetComponentRef` /
 *      `GadgetRefBase` + schema `gadgetRefSchema` + helper
 *      `gadgetPackageKey` deleted.** New: `GadgetPackageUse`,
 *      `GadgetExportUse`, `GadgetUse` (a flattened `{ package, name,
 *      description?, usage? }` view) + `listContractGadgets(contract)`
 *      flatten helper. `gadgetIdentityKey` re-keyed to `(name, package)`.
 *
 *   w4. **Push reject `gadget_version_not_registered` removed.** With no
 *      wire `version` there is nothing to mismatch;
 *      `assertGadgetsRegistered` keeps `gadget_not_registered` +
 *      `gadget_package_mismatch`. New fatal catalog lint
 *      `LINT_GADGET_DUPLICATE_PACKAGE` enforces ≤1 descriptor per
 *      package in an app's `App.gadgets`.
 *
 * --------------------------------------------------------------------
 * `loadGadgets()` retired — gadgets direct-imported, runtime registry
 * per-package (BREAKING, pre-launch):
 *
 *   v1. **`McpAppAiGguiMeta.gadgets` is per-package.** The channel
 *      flipped from one entry per hook (`{hook, package?, bundleUrl?,
 *      bundleSri?}`) to one entry per registered gadget PACKAGE
 *      (`{package, bundleUrl?, bundleSri?}` — `package` REQUIRED). The
 *      iframe-runtime loads each package's module namespace once and
 *      stores it under `globalThis.__ggui__.gadgets[package]`, so every
 *      hook AND component export the package ships is reachable. The
 *      runtime `gadgets` slot is correspondingly keyed by package name
 *      (`Record<package, ModuleNamespace>`), not flat by hook name.
 *
 *   v2. **`loadGadgets()` removed from `@ggui-ai/gadgets`.** Generated
 *      component code now direct-imports gadget exports
 *      (`import { useLeafletMap } from '@my-org/leaflet'`) — one idiom
 *      with the design-system primitives. The `loadGadgets()` accessor
 *      + its `GadgetsCatalog` Proxy are gone; the 7 STDLIB hooks stay
 *      as plain named exports of `@ggui-ai/gadgets`. The iframe-runtime
 *      rewriter resolves every gadget package specifier to a
 *      per-package data-URL shim (hook exports → lazy thunks, component
 *      exports → error-boundary-wrapped components).
 *
 * --------------------------------------------------------------------
 * Component gadgets — `GadgetDescriptor` normalized to a package
 * (BREAKING, pre-launch):
 *
 *   u1. **`GadgetDescriptor` is now a PACKAGE.** A descriptor carries
 *      package identity (`package`, `version`) + transport metadata
 *      (`bundleUrl`, `bundleHost`, `bundleSri`, `styleUrl`, `connect`,
 *      `requires`, `typesUrl`, `typesSri`) once at the package level,
 *      plus an `exports: GadgetExport[]` array (≥1, enforced by the
 *      schema). The per-export fields that used to sit flat on the
 *      descriptor — `hook`, `description`, `usage`, `example`,
 *      `gotchas`, `permission`, `required` — MOVED onto each
 *      `exports[*]`. A gadget package can now ship more than one
 *      export behind a single npm identity + bundle.
 *
 *   u2. **`GadgetExport` is a union discriminated by field presence
 *      (`hook` vs `component`) — no `kind` field.**
 *      `GadgetExport = GadgetHookExport | GadgetComponentExport`,
 *      told apart by which identifier field is present: `{hook, …}` is
 *      a `use`-prefixed React hook the generated component calls;
 *      `{component, …}` is a PascalCase React component the generated
 *      code renders as JSX. Both share the per-export teaching text
 *      (`description` / `usage` / `example` / `gotchas`) + runtime
 *      gates (`permission` / `required`) via `GadgetExportBase`. New
 *      schemas `gadgetExportSchema` (wire-permissive) +
 *      `strictGadgetExportSchema` (registry — teaching text required,
 *      `permission` enum-tight).
 *
 *   u3. **`GadgetRef` (wire) is a union discriminated by field
 *      presence (`hook` vs `component`) — no `kind` field.**
 *      `GadgetRef = GadgetHookRef | GadgetComponentRef` — the wire
 *      ref selects ONE export of a registered package:
 *      `{hook, package, version, description?, usage?}`
 *      or `{component, package, version, description?, usage?}`.
 *      `gadgetRefSchema` is a `z.union([…])` of two `.strict()`
 *      members — transport fields + per-export registry metadata stay
 *      off the wire.
 *
 *   u4. **`descriptorToJSDoc` → `exportToJSDoc`.** The codegen helper
 *      now takes a `GadgetExport` (`exportToJSDoc(entry: GadgetExport)`)
 *      and projects its per-export teaching text. `catalogToAugmentationDts`
 *      walks `descriptor.exports`, emitting one `typeof import(...)`
 *      declaration per HOOK export (component exports are skipped —
 *      `GadgetsCatalog` is the `loadGadgets()` hook surface).
 *      (`catalogToAugmentationDts` retired GG.8.3 — the descriptor-
 *      derived TS augmentation supersedes it.)
 *
 *   u5. **New helpers `gadgetExportName` / `gadgetPackageKey`.**
 *      `gadgetExportName(x: GadgetRef | GadgetExport)` returns the
 *      `hook` | `component` name — the single accessor every site
 *      that used to read `.hook` now calls. `gadgetPackageKey({package,
 *      version})` is the canonical `(package, version)` dedup key the
 *      resolver keys on; `gadgetIdentityKey(ref)` is the full
 *      `(name, package, version)` export-identity key the push-time
 *      gates agree on (the hook / component name grammars are
 *      disjoint, so the name itself is kind-disambiguating).
 *      (`gadgetPackageKey` + `GadgetRef` retired in GG.8.8 — the wire
 *      went package-keyed, so `version` left the wire and the
 *      `(package, version)` key collapsed to package-only; see the
 *      w-block. `gadgetIdentityKey` now keys `(name, package)`.)
 *
 *   u6. **New name grammars `HOOK_NAME_RE` + `COMPONENT_NAME_RE`.**
 *      `HOOK_NAME_RE` (`/^use[A-Z][A-Za-z0-9]*$/`) pins the
 *      `use`-prefixed hook grammar; `COMPONENT_NAME_RE`
 *      (`/^[A-Z][A-Za-z0-9]*$/`) pins the PascalCase component
 *      grammar. Both the wire `gadgetRefSchema` and the registry
 *      `gadget(Strict)ExportSchema` enforce them, so a malformed
 *      export name fails loudly at parse time.
 *      (`gadgetRefSchema` retired GG.8.8 with the wire shift to the
 *      package-keyed `clientCapabilities.gadgets` map; the grammars
 *      themselves stay live — see the w-block.)
 *
 *   `STDLIB_GADGETS` collapses to a 1-element array — the
 *   `@ggui-ai/gadgets` package descriptor whose `exports` are the
 *   seven stdlib hook exports. `loadGadgets()` + component-gadget
 *   rendering are GG.8.2+ work; GG.8.1 is the type/schema layer only.
 *
 * --------------------------------------------------------------------
 * Client-library plugin SDK + registry-membership gate (additive, no
 * wire breakage):
 *
 *   p1. **`createGguiGadget` SDK** in `@ggui-ai/gadgets`.
 *      Authors a single wrapper that publishes a stable React hook
 *      contract atop a 3rd-party library (Leaflet, Mapbox, Stripe,
 *      Chart.js, …) so the LLM never sees raw library APIs. Every
 *      wrapper carries `{description, usage, example}` (required) +
 *      optional `{gotchas, version, package, bundleUrl, styleUrl,
 *      connect[]}`. The factory zod-validates the spec at module load
 *      and throws `WrapperConformanceError` with field-path violations
 *      on shape misses. Returns a callable hook whose immutable
 *      `.descriptor` is what operators register on
 *      `App.gadgets`.
 *
 *   p2. **Two-schema strictness pattern on `GadgetDescriptor`.** A
 *      single TS type drives both the registry (strict —
 *      `strictGadgetDescriptorSchema` requires `description` /
 *      `usage` / `example` and at least one of `package` /
 *      `bundleUrl`) and the contract refs (permissive —
 *      `gadgetDescriptorSchema` for wire/contract use). Strictness
 *      lives in the validators, not the type, so consumers don't
 *      duplicate type defs.
 *
 *   p3. **Registry-membership gate at push validation.**
 *      `assertGadgetsRegistered(contract, appGadgets)`
 *      walks `contract.clientCapabilities.gadgets[*].hook` and
 *      throws `GadgetNotRegisteredError` on any reference not
 *      present in `App.gadgets`. Carries did-you-mean
 *      suggestions via `findClosestRegisteredHook` (Levenshtein < 3
 *      cutoff). Push falls back to `STDLIB_GADGETS` when the
 *      `App` row exists but doesn't carry an explicit catalog —
 *      symmetric with handshake.ts and list-gadgets.ts so
 *      every default-configured server enforces the gate without
 *      explicit operator config.
 *
 *   p4. **Push-time enrichment of `StackItem.clientCapabilities`.**
 *      Thin contract Refs are merged with the canonical registry
 *      descriptor so the persisted StackItem carries the FULL entry
 *      (teaching text + bundleUrl + styleUrl + connect[]).
 *      Contract-side overrides win on conflict so agents may author
 *      intent-specific description/usage at the mount site.
 *
 *   p5. **CSP derivation from registered gadget origins.** New
 *      `deriveBundleOrigins(item)` reads `bundleUrl` / `styleUrl` /
 *      `connect[]` off the enriched StackItem and emits per-directive
 *      origin buckets. `composeContentSecurityPolicy(origins)` formats
 *      them into a `Content-Security-Policy` header value
 *      (`script-src 'self' 'unsafe-inline' <origins>` so the inline
 *      `__GGUI_META__` survives, `style-src 'self' 'unsafe-inline'
 *      <origins>`, `connect-src 'self' <origins>`, `img-src 'self'
 *      data: <connect-origins>` so map tiles load). The renderer route
 *      attaches the header on `/r/<shortCode>` ONLY when libraries
 *      declare external origins — pre-plugin scenarios stay
 *      header-clean.
 *
 *   p6. **Boilerplate generator prefers `bundleUrl` over `package`.**
 *      Imports group by `bundleUrl ?? package` so a gadget with a
 *      hosted bundle emits
 *      `import { useLeafletMap } from 'https://registry.ggui.ai/leaflet@0.0.1/bundle.js'`,
 *      while npm-packaged-only libraries fall through to the existing
 *      bare-specifier path.
 *
 *   p7. **Teaching-text plumb into BOTH LLM paths.** The same
 *      `composeAvailableGadgetsSection(libraries)` helper feeds the
 *      synth prompt (`synthesize-contract.ts`) AND the decision-LLM
 *      prompt (`decision.ts`'s `buildDecisionUserMessage`). Both paths
 *      now see `description` + `usage` for every registered gadget
 *      with bounded per-entry (300 chars) + total (3 KB) budgets, so
 *      `App.gadgets`-registered plugins instruct the LLM
 *      uniformly without per-gadget prompt engineering.
 *
 *   p8. **CLI seed via `ggui.json#app.gadgets`.** Manifest
 *      schema gains an optional array of full registry descriptors;
 *      the CLI threads them into `InMemoryAppMetadataStore` so the
 *      same in-process singleton powers `ggui_list_gadgets`,
 *      handshake, push validation + enrichment, and CSP derivation.
 *
 *   p9. **Reference plugin + e2e gate.** `@ggui-samples/gadget-leaflet`
 *      ships as the canonical wrapper-author example;
 *      `@ggui-samples/ggui-leaflet-demo` is a sample server with the
 *      Leaflet plugin pre-registered. e2e/scenarios/19 pins the
 *      registry-membership gate end-to-end on the wire (registered
 *      hook accepts, unregistered hook rejects with
 *      `gadget_not_registered`, typo gets did-you-mean).
 *      Live-verified against `ggui-default` with a real LLM-backed
 *      negotiator.
 *
 * --------------------------------------------------------------------
 * Ajv layered validation (single source of truth for inner JSON
 * Schema + runtime data validation):
 *
 *   v1. **All four runtime validators use Ajv + closed-shape.** The
 *      hand-rolled JSON-Schema-subset validator is retired.
 *      `validatePropsData` / `validateActionData` / `validateStreamData`
 *      / `validateContextData` now share one seam — `compileForValidation()`
 *      from `@ggui-ai/protocol/validation/ajv-runtime` — which injects
 *      `additionalProperties: false` at every object node before Ajv
 *      compiles. Closed-shape applies uniformly at any depth (arrays
 *      of objects, oneOf branches, additionalProperties-as-schema).
 *      The `done`-vs-declared-`completed` class of bug — and any
 *      similar field-name divergence — surfaces as a wire-time
 *      `ContractViolationError` with the exact path (`todos[0].done`)
 *      instead of rendering silently as `undefined`.
 *      Authors who genuinely want an opaque-object escape hatch set
 *      `additionalProperties: true` explicitly on the schema; the
 *      injector preserves author intent (boolean kept, schema-form
 *      recursed into).
 *      Tolerated keywords: `example` (OpenAPI metadata) and
 *      `nullable` (OpenAPI 3.0 shorthand) registered as no-ops so
 *      Ajv strict mode doesn't reject schemas that carry them.
 *      Pre-launch no-backcompat: stream / action / context schemas
 *      authored as `{type: 'object'}` with no `properties` now mean
 *      "empty object only" (not "any object"). Migrate to explicit
 *      `properties` declarations OR set `additionalProperties: true`.
 *
 *   v2. **Layer-B meta-validation at handshake + push.**
 *      `assertContractSchemasValid(contract)` walks the six inner
 *      JSON Schema fields (`propsSpec.properties[*].schema`,
 *      `actionSpec[*].schema`, `streamSpec[*].schema`,
 *      `contextSpec[*].schema`, `agentCapabilities.tools[*].inputSchema`,
 *      `agentCapabilities.tools[*].outputSchema`) and runs
 *      `compileForValidation()` on each. Ajv strict mode throws at
 *      compile-time on malformed schemas (unknown keywords, properties
 *      values that aren't schemas, array schemas with non-schema
 *      items). Every offender collects into one
 *      `ContractSchemaMetaError` so the agent fixes them all in one
 *      round rather than retry-per-field. Called BEFORE the
 *      negotiator runs (handshake) and BEFORE any state mutation
 *      (push). Same fail-fast posture as the cross-reference +
 *      name-invariant + schema-compat assertions already in place.
 *
 *   v3. **Wrapper zod schemas are `.strict()`.** Seven entry/spec
 *      wrappers in `@ggui-ai/protocol/schemas/data-contract` flipped
 *      from `.passthrough()` to `.strict()`:
 *      `propEntrySchema`, `propsSpecSchema`, `actionEntrySchema`,
 *      `streamChannelEntrySchema` (+ its inner `source` schema),
 *      `contextEntrySchema`, `agentToolEntrySchema` (+ its inner
 *      `example` schema), `gadgetDescriptorSchema`. Extras at the
 *      wrapper layer now reject — symmetric with the closed-shape
 *      rigor at the data layer. `jsonSchemaSchema` and the outer
 *      `dataContractSchema` envelope stay permissive (vendor JSON
 *      Schema extensions + forward-compatibility for future top-
 *      level fields).
 *      Pre-launch no-backcompat: agents that put unknown fields at
 *      wrapper layers MUST migrate. Common offender: `required: []`
 *      on the `propsSpec` wrapper (required lives per-entry, not at
 *      the spec level).
 *
 * --------------------------------------------------------------------
 * propsSpec closed-shape (strict mode) + wire-schema trim:
 *
 *   u3. **`pushOutputSchema` + `updateOutputSchema` + `handshakeOutputSchema`
 *      trimmed to match handler reality.** Three response schemas in
 *      `@ggui-ai/protocol/schemas/mcp` were carrying retired fields
 *      that handlers had already stopped emitting (zod strips them
 *      before serialization). Public schema now mirrors what flows on
 *      the wire — third-party importers see the same shape the
 *      structuredContent carries:
 *        - `handshakeOutputSchema`: dropped `reason`, `target`,
 *          `alternatives`, `contractHash`, `serverCapabilities`.
 *          `serverCapabilities` flows via `_meta.ggui.bootstrap` instead.
 *        - `pushOutputSchema`: dropped `sessionId`, `shortCode`,
 *          `codeReady`, `handshakeId`, `decision`, `contract`,
 *          `interaction`, `contractHash`, `cache.*`, `codeUrl`,
 *          `codeHash`. Wire shape is now `{stackItemId, url, action,
 *          nextStep?}` — 90% byte reduction at the trim layer.
 *        - `updateOutputSchema`: dropped `sessionId`, `decision`,
 *          `contract`, `interaction`, `contractHash`. Wire shape is
 *          now `{stackItemId, updated}`.
 *      Pre-launch no-backcompat: consumers that read any of the dropped
 *      fields off the wire response MUST migrate. Internal telemetry
 *      threading via TS-only `HandshakeOutput` / `PushOutput` /
 *      `UpdateOutput` shapes is preserved for handler-side callers.
 *
 *   u2. **`validatePropsData` is closed-shape (strict mode).** Keys
 *      not declared on `propsSpec.properties` are now rejected with
 *      `ContractViolationError{tool:'ggui_update'}` (or `'ggui_push'`
 *      depending on call site). Load-bearing for `ggui_update kind:'merge'`
 *      — without it, a typo'd patch field would silently land on the
 *      stack item with no propsSpec coverage. Symmetric with
 *      `validateActionData`'s allowlist enforcement; intentionally
 *      asymmetric with `actionSpec.data` / `streamSpec.payload` /
 *      `contextSpec.value` (those validate type-only, forward-compatible).
 *      Pre-launch no-backcompat: agents that sent extra metadata fields
 *      alongside declared props MUST refine the contract's `propsSpec`
 *      to declare them, or drop them from the wire payload.
 *
 * --------------------------------------------------------------------
 * `ggui_update` replace + merge modes:
 *
 *   u1. **`kind: 'replace' | 'merge'` discriminator on `ggui_update`.**
 *      Wire input reshaped from `{stackItemId, props}` to a
 *      discriminated union:
 *        - `{stackItemId, kind:'replace', props}` — full props
 *          replacement; the map IS the new state. Same semantics as
 *          the pre-discriminator wire.
 *        - `{stackItemId, kind:'merge', patch}` — RFC 7396 JSON Merge
 *          Patch (top-level shallow merge; nested objects recurse;
 *          `null` deletes the key; arrays fully replace). Use when
 *          most props stay the same and the agent only needs to send
 *          a delta — typical after a single domain-tool mutation.
 *      Both modes validate the FINAL props (post-merge for `merge`)
 *      against the stack item's `propsSpec` and reject on violation.
 *      Missing the required field for a mode (e.g. `kind:'merge'`
 *      without `patch`) throws `ContractViolationError{tool:
 *      'ggui_update'}` pre-mutation.
 *      Pre-launch no-backcompat: agents that issued the old
 *      `{stackItemId, props}` shape MUST migrate to
 *      `{stackItemId, kind:'replace', props}`. The OSS handler's
 *      handshakeId arm was retired in the same pass; protocol schema
 *      now mirrors the handler's direct-only surface.
 *
 * --------------------------------------------------------------------
 * Pipe-as-single-source-of-truth pivot:
 *
 *   t1. **`ggui_runtime_claim_pending` retired.** The iframe-side rescue
 *      drain + its 10s claim timer + per-action `pendingActions` map
 *      are gone. The pipe is now the single source of truth: every
 *      `submit_action` either succeeds (event lands on the pipe; agent
 *      drains via `ggui_consume`) or fails (`PIPE_NOT_FOUND` / transport
 *      error; iframe emits the action inline via `ui/message`). No
 *      timer, no rescue, no race between two atomic-pop callers.
 *
 *   t2. **`content[0]._meta["ai.ggui/userAction"]` unifies `fallback` +
 *      `nudge`.** New single discriminator on `ui/message` envelopes
 *      replacing the separate `_meta.ggui.fallback` (reason:
 *      pipe_not_found | timeout) + `_meta.ggui.nudge`
 *      (no_active_consumer) split:
 *
 *        - `kind: 'queued'` — pipe HAS the event; agent SHOULD dispatch
 *          the prepared `{tool: 'ggui_consume', args: {stackItemId}}`
 *          nextStep to drain. Emitted when `submit_action` returned
 *          `{ok:true, consumerPresent:false}`.
 *        - `kind: 'inline'` — pipe is GONE; action data + uiContext
 *          delivered inline in `payload`. Agent MUST act directly on
 *          `payload.actionData`; calling `ggui_consume` would return
 *          empty. Emitted when `submit_action` returned PIPE_NOT_FOUND,
 *          INVALID_ACTION_KIND, or any transport/relay error. Optional
 *          `nextStep: string` hint surfaces the contract's bound agent
 *          tool when present.
 *
 *      Type guard `isGguiUserActionMeta` lives on
 *      `@ggui-ai/protocol/integrations/mcp-apps`.
 *
 *   t3. **Per-event `uiContext` on the pipe.** `submit_action`'s
 *      `dispatch` payload reshaped from `{intent, data}` to `{intent,
 *      actionData, uiContext}`. The iframe captures the contract's
 *      `contextSpec` snapshot at gesture time and stores it on the
 *      pipe entry alongside the action data — `consume`'s output
 *      events now carry `{intent, actionData, uiContext, actionId,
 *      firedAt}` per event.
 *
 *   t4. **`GguiConsumeOutput.contextSnapshot` retired.** The top-level
 *      contextSpec snapshot on consume's output is gone. Per-event
 *      `uiContext` (t3) replaces it. Agents read state AS OF the
 *      moment the user acted — not the post-action state that might
 *      have already mutated by the time consume returns.
 *
 * --------------------------------------------------------------------
 * No-active-consumer fast-path:
 *
 *   s1. **`consumerPresent` on `ggui_runtime_submit_action` output.** New
 *      optional `consumerPresent?: boolean` field on the dispatch
 *      success branch. When `true`, at least one `ggui_consume`
 *      long-poll is currently registered against the targeted stack
 *      item — iframe takes today's path (10s claim timer + drain_ack
 *      race). When `false`, no consumer is registered: the action IS
 *      on the pipe, but the agent won't wake on its own. Iframe
 *      SHOULD immediately emit a `ui/message` nudge instead of
 *      waiting on the 10s timer. When `undefined`, the server doesn't
 *      have an active-consumer registry wired (graceful degradation;
 *      iframe falls back to the timer). Additive — agnostic consumers
 *      ignore the field.
 *
 *   s2. **`_meta.ggui.nudge` discriminator on `ui/message`.** New
 *      structured fingerprint paired with the free-form text nudge:
 *      `{reason: 'no_active_consumer', stackItemId, actionId,
 *      submittedAt}`. Sibling of `_meta.ggui.fallback` but
 *      semantically distinct — the nudge carries NO action payload
 *      (the pipe holds the data); it's a pure wake-up signal telling
 *      the agent to `ggui_consume({stackItemId})`. Type guard
 *      `isGguiNudgeMeta` mirrors `isGguiFallbackMeta` so ggui-aware
 *      SDKs route deterministically. Additive — agnostic hosts ignore
 *      the field; free-form text alone is enough to act on.
 *
 *   s3. **`ActiveConsumerRegistry` seam (`@ggui-ai/mcp-server-core`).**
 *      Optional in-process reference-count seam tracking which stack
 *      items currently have an in-flight `ggui_consume` long-poll.
 *      `consume.ts` wraps its long-poll in `enter`/`exit`;
 *      `submit-action.ts` queries `hasActive` after a successful pipe
 *      append. Reference impl `InMemoryActiveConsumerRegistry` ships;
 *      cloud/multi-pod deployments wire a Redis-backed adapter
 *      against the same interface. Mirrors the optional-seam pattern
 *      of `DrainAckNotifier` / `ObserverNotifier` / `ConsumeLogger`.
 *
 * --------------------------------------------------------------------
 * Action drain guarantee:
 *
 *   r1. **Drain-guarantee envelope + WS channel.** New optional
 *      `_meta.ggui.fallback` discriminator on `ui/message` envelopes
 *      (`reason: 'pipe_not_found' | 'timeout'`) so ggui-aware SDKs
 *      can route fallback gestures through their tool-result loop
 *      instead of injecting as a synthetic user prompt. New
 *      server→client `drain_ack` WS frame so the iframe-runtime can
 *      cancel its per-action 10s claim timer + dismiss the toast as
 *      `consumed` when an event drains via `ggui_consume`.
 *      Additive — agnostic hosts ignore the `_meta.ggui.fallback`
 *      field and the unrecognized WS frame (no protocol break).
 *
 *   r2. **`ggui_runtime_claim_pending` wire.** New `audience: 'runtime'`
 *      tool the iframe calls from its per-action 10s timer to
 *      atomically pop a stale pipe entry when the host agent isn't
 *      draining. Same `consumeAndClear` primitive `ggui_consume` uses
 *      (one caller wins; race resolves at the server-side lock). The
 *      tool isn't agent-addressable; it surfaces on `/mcp` only and
 *      gates through the postMessage relay.
 *
 *   r3. **Drain-guarantee telemetry.** New `action_consume_slow`
 *      info-event (submit → drain latency >2s) and
 *      `action_claim_timeout` warn-event (claim_pending fired because
 *      nobody drained for 10s). Operators derive the fallback-ratio
 *      protocol-adherence metric from these.
 *
 * --------------------------------------------------------------------
 * Bootstrap-meta cleanup:
 *
 *   q1. **`_meta.ggui.bootstrap.componentCode` retired.** The
 *      inline base64 ESM channel on the bootstrap envelope is deleted.
 *      Static-component bootstraps now travel exclusively via the
 *      content-addressable `codeUrl` channel composed by the push
 *      handler from its `codeStore` + `codeBaseUrl` deps. The
 *      `hasPushBootstrapMeta` discriminator collapses from
 *      `{wsUrl-with-token, componentCode, codeUrl, kind}` to
 *      `{wsUrl-with-token, codeUrl, kind}`. `StackItemMetaView`
 *      drops the field on the projection layer. `buildSelfContainedShell`
 *      accepts `{codeUrl, codeHash}` (or `systemKind`, or live-mode
 *      trio); throws when none are set. `/r/<shortCode>` mints
 *      codeUrl via codeStore.hashOf + put; falls through to live-mode
 *      when codeStore isn't wired. Iframe-runtime parser drops
 *      `componentCode` read + the inline-base64 `decodeBase64Utf8`
 *      helper. Saves 5-50KB per push.
 *
 *   q2. **`_meta.ggui.bootstrap.adapters` retired.** The
 *      dormant dynamic-import-at-boot adapter loader is deleted from
 *      the wire surface. `McpAppAiGguiMeta.adapters?` field removed;
 *      `parseAdapterSpecs` + `installAdapters` + the
 *      `globalThis.__ggui__.adapters` registry slot retired from
 *      iframe-runtime. An earlier change had already moved capability
 *      hooks to `@ggui-ai/gadgets`; this cleanup closes the
 *      dead surface. Native shells (`@ggui-ai/camera`,
 *      `@ggui-ai/ggui-react-native`) unchanged — they register
 *      adapters via their own `<GguiProvider>` React Context, never
 *      via bootstrap-meta.
 *
 * --------------------------------------------------------------------
 * MCP Apps compliance & update fan-out:
 *
 *   p1. **`ggui_stream` → `ggui_emit` rename (wire name + symbol prefix).**
 *      The send-from-agent-to-iframe tool was named `ggui_stream`, which
 *      reads as a noun referring to the stream object rather than the
 *      imperative act of emitting. `ggui_emit` reads correctly as an
 *      action and disambiguates from the wire field `streamSpec` (which
 *      keeps its name — it describes channels, not the act of emitting).
 *      Mechanical sweep across `@ggui-ai/protocol`, `@ggui-ai/mcp-server-handlers`,
 *      `@ggui-ai/mcp-server`, `@ggui-ai/ggui-cli`, `@ggui-ai/ggui-react-native`,
 *      `cloud/ggui-protocol-pod`, `cloud/generation-runtime`, and `cloud/cdk`:
 *
 *      - Wire-name literal `'ggui_stream'` → `'ggui_emit'`
 *      - Pascal symbol prefix `GguiStream` → `GguiEmit` (covers
 *        `GguiEmitInput`, `GguiEmitOutput`, `GguiEmitHandlerDeps`,
 *        `createGguiEmitHandler`)
 *      - Test-d file rename `ggui-stream.test-d.ts` → `ggui-emit.test-d.ts`
 *
 *      Untouched (NOT the tool name): `streamSpec`, `StreamChannelEntry`,
 *      `StreamEnvelope`, `SessionChannelServer`, `streamReplayOps`, and
 *      file paths like `renders/stream.ts`. These describe the
 *      channel data plane, not the imperative emit action.
 *      Pre-launch breaking rename; no compatibility shim.
 *
 *   p2. **`ggui_update` emits `_meta.ggui.bootstrap` on tool result.**
 *      Previously, the canonical re-apply path
 *      (MCP Apps `ui/notifications/tool-result` → host postMessage → iframe
 *      `_meta.ggui.bootstrap` consumer in `@ggui-ai/iframe-runtime`) had
 *      no envelope to deliver: `ggui_update`'s `resultMeta` was empty.
 *      Hosts that forwarded tool results couldn't trigger the spec-compliant
 *      live-update path. `createGguiUpdateHandler` now accepts the same
 *      bootstrap-emitting deps as `ggui_push` (`mintBootstrap`, `runtimeUrl`,
 *      `themeId`, `themeMode`, `themeProvider`, `appCallableTools`,
 *      `streamWebSocketLocalTools`) and emits `_meta.ggui.bootstrap`
 *      derived from the just-patched stack item via the shared
 *      `deriveStackItemMeta` projection — byte-identical to
 *      `ggui_push`'s bootstrap envelope at the projection boundary.
 *      Strictly additive: prior consumers that ignored `resultMeta` are
 *      unaffected; hosts that DO forward `_meta.ggui.bootstrap` now
 *      receive the new envelope and can re-render without losing client
 *      state. Follows the MCP Apps tool-result forwarding rule.
 *      No wire-shape change; behavior change on `ggui_update`'s response
 *      `_meta` only.
 *
 *   p3. **`/r/<shortCode>` mints the live trio (`wsUrl + token + expiresAt`)
 *      and inlines it in `__GGUI_META__`.** Previously the public
 *      render route minted no bootstrap token, so iframe-runtime's
 *      `subscribe.ts` rejected the envelope as "live-mode required" and
 *      never opened a WS — `props_update` and stream frames never reached
 *      the iframe even when the server fan-out fired. The route now calls
 *      `mintBootstrap(sessionId, appId)` when the minter is wired,
 *      rewrites localhost wsUrl to the request host (mirroring
 *      `/api/bootstrap/<shortCode>`), and threads the three fields into
 *      `buildSelfContainedShell`. `SelfContainedShellInputs` gains the
 *      three optional live-trio fields. Strictly additive — pre-existing
 *      static-only renders behave identically when no minter is wired.
 *
 * --------------------------------------------------------------------
 * Multi-variant Blueprints — three-step handshake protocol:
 *
 *   o. **Three-step handshake protocol.** `match` / `plan` /
 *      `hint` / `provisional` / `contractHash` (the previous
 *      top-level shape) DELETED from `handshakeOutputSchema`; replaced
 *      by a
 *      single `suggestion: HandshakeSuggestion` carrying a
 *      `origin: 'cache' | 'agent' | 'synth'` enum that routes the
 *      agent's next decision. `blueprintMeta` is ALWAYS present.
 *      `handshakeInputSchema` reshape: `contract?` + `hint?` ⇒ single
 *      `blueprintDraft: {contract, variance?, generator?}` (top-level
 *      `hint` field deleted in this slice). `handshakeOutputSchema`
 *      gains optional `alternatives: Blueprint[]` (top-N search misses
 *      below threshold so the agent can override into one).
 *      `pushInputSchema` reshape: `contract?` + `contractHash?` triad
 *      DELETED; replaced by a `decision` discriminator
 *      (`{kind: 'accept'} | {kind: 'override', blueprintDraft: {...}}`).
 *      `accept` reuses the provisional `blueprintId` from the
 *      handshake's `suggestion.blueprintMeta`; `override` mints a
 *      fresh `blueprintId` against a NEW draft. New types
 *      `BlueprintDraft`, `BlueprintMeta`, `SuggestionOrigin`,
 *      `HandshakeSuggestion`, `PushDecision`, `JsonPatch` ship in
 *      `@ggui-ai/protocol/types/handshake-suggestion` with zod mirrors
 *      in `@ggui-ai/protocol/schemas/handshake-suggestion`. A breaking
 *      reshape.
 *
 * --------------------------------------------------------------------
 * Multi-variant Blueprints — operator-class blueprint tools:
 *
 *   o. **Operator-class blueprint tool schemas** added to
 *      `@ggui-ai/protocol/schemas/ops-blueprint`. Four input/output
 *      pairs for the operator MCP tools:
 *
 *      - `opsGenerateBlueprintInputSchema` /
 *        `opsGenerateBlueprintOutputSchema` — `ggui_ops_generate_blueprint`.
 *        Operator-authored blueprint generation, persona-tagged,
 *        optional `setAsOperatorDefault` flag.
 *      - `opsListBlueprintsInputSchema` /
 *        `opsListBlueprintsOutputSchema` — `ggui_ops_list_blueprints`.
 *        Indexed `(appId, contractHash)` list OR semantic search via
 *        `BlueprintSearch` when `intentKeywords` / `persona` is set.
 *      - `opsUpdateBlueprintInputSchema` /
 *        `opsUpdateBlueprintOutputSchema` — `ggui_ops_update_blueprint`.
 *        Mutable-field patch — `isOperatorDefault?: true` + partial
 *        `variance?`. Immutable fields (contractHash, appId,
 *        codeS3Url, codeHash, generator, createdAt, createdBy) are
 *        absent from the schema.
 *      - `opsDeleteBlueprintInputSchema` /
 *        `opsDeleteBlueprintOutputSchema` — `ggui_ops_delete_blueprint`.
 *        Idempotent — second delete returns `{deleted: true}`.
 *
 *      All four tools tag `audience: ['ops']`; agents on `/mcp` do
 *      not see them. Strictly additive — existing handshake / push /
 *      list paths unchanged. No agent companion tool — agent
 *      blueprint authoring stays through the normal handshake → push
 *      flow.
 *
 * --------------------------------------------------------------------
 * Multi-variant Blueprints — multi-axis blueprint search:
 *
 *   n. **`Blueprint.contractEmbedding?: readonly number[]`** added —
 *      cached embedding vector written by `BlueprintStore.put` when an
 *      `EmbeddingProvider` is wired; read by `BlueprintSearch` on the
 *      embed axis (cosine similarity). Strictly additive — every
 *      existing `Blueprint` row deserializes with `contractEmbedding:
 *      undefined`, and the search layer's embed axis contributes zero
 *      in that case. Other axes (hash, structural, variance, intent)
 *      still carry the decision.
 *   nn. **`BlueprintSearchWeights` + `AppBlueprintSearchConfig`** types
 *      + zod schemas added. Per-app blueprint-search configuration
 *      lives on the `App` record in `@ggui-ai/mcp-server-core` as
 *      `App.blueprintSearchConfig?`; the wire shape stays in protocol
 *      so cloud-DDB + OSS in-memory adapters share one source of
 *      truth. Defaults applied at the impl layer
 *      (`DEFAULT_BLUEPRINT_SEARCH_WEIGHTS` / `THRESHOLD` / `TOP_K`
 *      in `@ggui-ai/mcp-server-core/blueprint-search`).
 *
 * --------------------------------------------------------------------
 * Multi-variant Blueprints — the `Blueprint` record:
 *
 *   m. **`Blueprint` type + zod schema** added to `@ggui-ai/protocol`.
 *      Represents the variant-unit between a `DataContract` and the
 *      generated UI code that renders it. Multiple `Blueprint` rows
 *      MAY share `(appId, contractHash)`; they differ on `generator`
 *      and/or `variance`. Fields: `blueprintId`, `contractHash`,
 *      `appId`, optional `codeS3Url + codeHash` (cached code pointer),
 *      `generator` (slug), optional `validatorScore`, `variance`
 *      (`{persona?, context?, seedPrompt?}`), optional
 *      `isOperatorDefault: true`, `createdAt`, `createdBy`
 *      ('agent' | 'operator'), and a read-cache copy of `contract`.
 *      Strictly additive — no fields removed; no consumer sees a
 *      schema-incompatible change. Consumers using `BlueprintProvider`
 *      see no break.
 *
 * --------------------------------------------------------------------
 * Wire-shape v2 — contract vocabulary reshape:
 *
 *   0. `broadcast` field deleted; channel data sources move inline as
 *      `streamSpec[ch].source = { tool, args? }`. Server-side
 *      `runBroadcastLoop` removed entirely (no replacement on server;
 *      transport now runtime-negotiated by `@ggui-ai/wire`).
 *
 *   00. `DataContract.props` → `DataContract.propsSpec` rename. Aligns the
 *      contract-level declaration with the other three typed surfaces
 *      (`actionSpec` / `streamSpec` / `contextSpec`). Wire-side `props`
 *      field on `ggui_push.input` / `ggui_update.input` stays as `props`
 *      — those carry values, not the spec.
 *
 *   000. `DataContract.wiredTools` → `DataContract.agentTools` rename +
 *      entry restructure: drop `label`, rename `requestSchema`/`responseSchema`
 *      → `inputSchema`/`outputSchema` (MCP alignment), rename
 *      `example: {request, response}` → `example: {input, output}`, add
 *      `usage?: string` field. All `WiredTool*` types rename to `AgentTool*`.
 *      Hook name `useWiredTool` retired in a follow-up commit (paired
 *      with kind removal). `PushStory.wiredTools?: string[]` shorthand
 *      input ALSO renamed to `agentTools` in the same follow-up.
 *
 *   000a. `DataContract.agentTools` → `DataContract.agentCapabilities`
 *      rename. The catalog parent is renamed for symmetry with
 *      `clientCapabilities` — both are capability declarations grouped
 *      under a `*Capabilities` parent so the protocol's capability
 *      namespace reads as `{agent,client}Capabilities`. Inner map stays
 *      as `.tools` (e.g., `agentCapabilities.tools.fetch_quote`). Type
 *      alias `AgentToolSpec` → `AgentCapabilitiesSpec`; `AgentToolEntry`
 *      unchanged. Catalog-level `description?` field dropped (vestigial,
 *      no consumer). Linter rule messages + paths updated. `PushStory`
 *      shorthand input `agentTools: string[]` is left under its current
 *      name (retired later alongside PushStory itself).
 *
 *   000b. `DataContract.clientCapabilities.capabilities` →
 *      `DataContract.clientCapabilities.gadgets` rename + reshape.
 *      Inner map renamed for vocabulary parity with the agent side
 *      (`agentCapabilities.tools` vs `clientCapabilities.gadgets`).
 *      Per-entry type renamed: `ClientCapabilityEntry` →
 *      `GadgetDescriptor`; spec renamed: `ClientCapabilitySpec` →
 *      `ClientCapabilitiesSpec`. Hook generic renamed:
 *      `ClientCapabilityHook` → `GadgetHook`; lifecycle types
 *      `CapabilityStatus` → `GadgetStatus`, `CapabilityError` →
 *      `GadgetError`. Catalog-level `description?` dropped (vestigial,
 *      no consumer). New optional `example?: JsonValue` on
 *      `GadgetDescriptor` parallels `AgentToolEntry.example` so the
 *      agent has a concrete shape to reference for unfamiliar libraries.
 *      Hygiene rule codes renamed: `LINT_CAP_*` → `LINT_LIB_*`.
 *      Helper `getClientCapabilityNames` → `getGadgetNames` in
 *      `@ggui-ai/ui-gen/evaluation/axis-checks`. The
 *      `@ggui-ai/client-tools` package literal is renamed separately
 *      (see entry 000c) alongside the workspace directory move.
 *
 *   000e. Per-app library discovery. Three changes ship together
 *      (the data-plane half of the per-app library story; UX +
 *      renderer follow up):
 *
 *      a. **App model** — the OSS `@ggui-ai/mcp-server-core` adds an
 *         `App` type with `gadgets: readonly GadgetDescriptor[]`
 *         and an `AppMetadataStore` seam. Reference `InMemoryAppMetadataStore` seeds
 *         every registered app with `STDLIB_GADGETS`.
 *      b. **Cloud DDB adapter** — `AppRecord.gadgets` added.
 *         `getApp` applies the **default-on-read** pattern at the row
 *         projection site so existing rows without the column survive.
 *      c. **New tool `ggui_list_gadgets`** — audience `['agent']`,
 *         bare `ggui_*` prefix (NOT `ggui_protocol_*` — fetches runtime,
 *         per-app data, not static spec). Input `{appId?: string}` —
 *         defaults to `ctx.appId`; explicit mismatch throws
 *         `AppAccessDeniedError` (code `app_access_denied`). App-not-found
 *         falls back to `STDLIB_GADGETS` (sandbox-app permitted-
 *         error path).
 *
 *      Operator console UX to mutate per-app lists and renderer support for
 *      serving operator-added custom libraries are deferred to later
 *      work; initially every app's `gadgets` == stdlib by default.
 *
 *   000g. Generation triad vocabulary sweep. `@ggui-ai/ui-gen`'s
 *      HOW / WHAT / CHECK surfaces all speak the renamed contract
 *      paths (`agentCapabilities.tools`, `clientCapabilities.gadgets`).
 *
 *      a. **HOW prompts** (`harness/prompts.ts`) — every reference to
 *         the catalog now uses `agentCapabilities.tools` /
 *         `clientCapabilities.gadgets`; pre-rename hook identifiers
 *         (`useWiredTool` / `useAgentTool` / `useClientTool`) are
 *         described as retired rather than mentioned by name.
 *      b. **WHAT classifier** (`classifier/inspect.ts`) — the inner
 *         `clientCapabilities.capabilities` read path was stale; now
 *         reads `clientCapabilities.gadgets` to match the current
 *         wire shape.
 *      c. **CHECK Tier 0** (`check/run-tier0.ts`) — `wire_undeclared`
 *         remediation messages no longer reference the retired
 *         `story.contract`; they name the flat `contract` field on
 *         `ggui_push`.
 *      d. **CHECK evaluator** (`evaluation/llm-evaluator.ts`,
 *         `evaluation/types-public.ts`) — eval criteria descriptions
 *         use `agentCapabilities.tools` and `clientCapabilities.gadgets`.
 *      e. **Anti-pattern grep gate** (`evaluation/axis-checks/checks/
 *         tooling.ts`) — `RETIRED_IDENTIFIERS` extended with
 *         `useAgentTool`, `callWiredTool`, `agentTools` (top-level
 *         field), `clientCapabilities.capabilities`,
 *         `@ggui-ai/client-tools` (package), `PushStory`,
 *         `pushStorySchema`, `story.adapters`, `declaredAdapters`,
 *         `assertAdaptersDeclared`, `HandshakeStoredStory`, and
 *         `record.story`. Each emits one issue per detection so the
 *         LLM rewrites toward the current shape before evaluation
 *         completes.
 *
 *   000h. Bench corpus rebuild. The static bench corpora carried
 *      example contracts and prose docstrings on the old catalog
 *      shape; this sweep updates them so every fixture and comment
 *      reads as a valid contract under the new wire shape.
 *
 *      a. **Negotiator synth corpus** (`packages/negotiator/src/
 *         synth-bench/corpus.ts`) — docstring path `agentTools[*]` /
 *         `agentTools.tools[*]` → `agentCapabilities.tools[*]`.
 *         Fixture data already carried the new shape; only the prose
 *         drifted.
 *      b. **Multi-SDK gen fixtures** (`packages/benchmark/src/multi-
 *         sdk/commits.ts` + `fixtures/{activity-feed,inbox-triage,
 *         place-search,uber-ride}.fixture.ts`) — `agentCapabilities.
 *         tools` entries reshaped: drop `label`,
 *         `requestSchema`/`responseSchema` → `inputSchema`/
 *         `outputSchema`, `example: {request, response}` →
 *         `example: {input, output}`. `clientCapabilities.
 *         capabilities` → `clientCapabilities.gadgets`.
 *      c. **Floor-test contract** (`packages/benchmark/src/multi-sdk/
 *         floor.test.ts`) — sample `{ props: { properties: {} } }`
 *         → `{ propsSpec: { properties: {} } }` per the
 *         DataContract.props → propsSpec rename.
 *
 *   000f. Permissions-Policy derivation from
 *      `DataContract.clientCapabilities.gadgets[*].permission`.
 *      Replaces the previous App-level `declaredAdapters` runtime
 *      gate with per-contract derivation. `StackItem` gains an
 *      optional `clientCapabilities?: ClientCapabilitiesSpec` field
 *      so push commit-time persists the catalog onto the active stack
 *      item. `StackItemMetaView.permissionsPolicy?: readonly
 *      string[]` projects the union-deduplicated directive list every
 *      transport reads — public-render `/r/<shortCode>` emits a
 *      `Permissions-Policy` HTTP response header (`<directive>=(self)`
 *      per W3C Permissions Policy), MCP-Apps `_meta.ui.permissions`
 *      forwards into the iframe host's `allow=""` attribute, and the
 *      inline bootstrap mirrors `permissionsPolicy` so the
 *      iframe-runtime can surface the gate set to in-iframe consumers.
 *      Browser-enforced gates flow from the parent transport; the
 *      iframe-runtime itself cannot mutate Permissions-Policy
 *      post-load. `McpAppAiGguiMeta` gains an optional matching
 *      `permissionsPolicy?: readonly string[]` field;
 *      `validateMcpAppAiGguiMeta` validates the array shape.
 *      Boilerplate generator (`@ggui-ai/ui-gen`) reads
 *      `clientCapabilities.gadgets` and emits
 *      one combined `import { hookA, hookB } from '<pkg>'` per
 *      declared package, alphabetically sorted within each group for
 *      stable diffs. The intermediate inner key
 *      `clientCapabilities.capabilities` is fully retired in the
 *      generator surface.
 *
 *   000d. Handshake input redesigned to flat fields + hint group.
 *      `handshakeInputSchema` was `{sessionId, story: {intent, data?, sourceTools?,
 *      agentTools?, prompt?, context?, contract?}, forceCreate?}`. The story
 *      nesting is dismantled: `intent` and `contract` are promoted to top-level
 *      on the input; `data`/`prompt`/`context`/`availableAgentTools`/`sourceTools`
 *      move under a labeled `hint?: HandshakeHint` group (cold-path synth signal).
 *      `agentTools` rename → `availableAgentTools` clarifies role (catalog seed,
 *      not authority). `PushStory` interface + `pushStorySchema` Zod retired
 *      entirely (no consumer left). Vestigial sub-schemas `pushSessionSchema`/
 *      `pushRenderingSchema`/`pushInfraSchema`/`pushShortcutsSchema` + their
 *      TS interfaces (`PushSession`/`PushRendering`/`PushInfra`/`PushShortcuts`)
 *      also dropped — dead code (no consumer outside sync-check).
 *      OSS handler's internal `HandshakeStoredStory` → `HandshakeStoredInput`
 *      reshape: `{intent, contract?, forceCreate?, hint?}` (drops legacy
 *      `context`/`schema`/`adapters` passthrough plumbing — schema lives in
 *      `contract.propsSpec`; adapters retire alongside the
 *      `declaredAdapters` deployment-policy field, replaced by per-app
 *      `gadgets` permissions). Negotiator
 *      `decide({story, sessionId, ctx})` → `decide({intent, contract?, hint?,
 *      sessionId, ctx})`. Push consumers (`push.ts`, `update.ts`) read
 *      `record.input.*` not `record.story.*`. `provisional-preview.ts` field
 *      `story` → `input` to match.
 *
 *   000g. Negotiator synth refactor. Synth now reads + writes the
 *      renamed catalog paths and threads per-app library context
 *      through.
 *
 *      a. **Synth prompt + DECISION_TOOL JSON-schema** flipped from
 *         `clientCapabilities.capabilities` → `clientCapabilities.gadgets`.
 *         Inner field shape unchanged ({hook, package?, permission?,
 *         usage?}); only the parent key renamed. Worked examples in the
 *         synth system prompt match.
 *      b. **`parseToolInput` + `buildContract`** now extract
 *         `agentCapabilities.tools` AND `clientCapabilities.gadgets`
 *         from the LLM tool output and populate them on the assembled
 *         contract. Previously both catalogs were dropped silently —
 *         the LLM authored entries the contract never carried.
 *      c. **`NegotiatorInput.agent.gadgets?: readonly GadgetDescriptor[]`**
 *         + **`NegotiatorDecisionInput.gadgets?`**. The
 *         handshake handler reads `app.gadgets` via the bound
 *         `AppMetadataStore` and threads the catalog to the
 *         negotiator. The decision-prompt user message gains a
 *         "Client-side libraries available" section listing each
 *         hook + permission so the LLM authors valid bindings.
 *      d. **`mergeAgentTools` → `mergeAgentCapabilities`** rename.
 *         Behavior unchanged.
 *      e. **`mergeGadgets(contract, appGadgets)`** new
 *         function — enriches partial LLM-emitted gadget entries
 *         (missing package/permission) from the app's canonical
 *         catalog. Bindings whose `hook` doesn't match any app entry
 *         are preserved verbatim (third-party packages outside the
 *         seed). Wires into all three return paths (structured-output
 *         success, regex JSON fallback, buildFallbackDecision).
 *      f. **HandshakeNegotiator.decide** interface gains optional
 *         `gadgets`. OSS llm-backed-negotiator + cloud pod's
 *         Bedrock negotiator forward to `negotiate(input.agent.gadgets)`.
 *      g. **GguiHandshakeHandlerDeps.appMetadataStore** new optional field.
 *         OSS `createGguiServer` resolves it from `deps.handshake.appMetadataStore`
 *         or top-level `deps.appMetadataStore` (same store the
 *         `ggui_list_gadgets` tool uses).
 *      h. **Anti-pattern list** extended in synth + decision prompts
 *         with retired identifiers — `clientCapabilities.capabilities`,
 *         `PushStory`/`story.*`, `@ggui-ai/client-tools`,
 *         `story.adapters`/`declaredAdapters`, `useAgentTool`. Prevents
 *         LLM regression on older training data.
 *
 *   000c. `@ggui-ai/client-tools` → `@ggui-ai/gadgets` package
 *      rename. The workspace directory moves from `packages/client-tools`
 *      to `packages/gadgets`; the published package name
 *      changes from `@ggui-ai/client-tools` to `@ggui-ai/gadgets`.
 *      All import strings across the workspace flip simultaneously
 *      (negotiator synth prompt, ui-gen boilerplate + system prompt +
 *      eval axis checks, design rewrite-imports, ggui-react test
 *      fixtures, mcp-server-handlers blueprint docs, hygiene-rules
 *      `DEFAULT_GADGET_PACKAGE` literal). The exported hook surface
 *      (`useGeolocation`, `useClipboardWrite`, `useClipboardPaste`,
 *      `useNotifications`, `useFilePicker`, `useMicrophone`,
 *      `useCamera`) is unchanged. Package version stays at 0.1.0.
 *
 *   00000000. Protocol-level schema-compat invariant in
 *      `@ggui-ai/protocol/validation/schema-compat-invariants`:
 *      `CTR_SCHEMA_INCOMPAT` validates `actionSpec[*].schema` is a
 *      subset of the referenced `agentCapabilities.tools[*].inputSchema`,
 *      and `streamSpec[*].schema` is a superset of the referenced
 *      `agentCapabilities.tools[*].outputSchema`. Compares against the
 *      contract's OWN agentCapabilities catalog (no runtime tool registry,
 *      no zod conversion) — author-visible bug class. Distinct from
 *      and complementary to the server-level F4 check
 *      (`checkStackItemSchemaCompat` in `@ggui-ai/mcp-server`),
 *      which compares the same action/stream schemas against the
 *      live tool registry's zod schemas. Folded into
 *      `validateContractStructure` and wired into the push handler
 *      via `assertSchemaCompat(contract)`.
 *
 *   0000000. Name-invariant rules in
 *      `@ggui-ai/protocol/validation/name-invariants`:
 *      `CTR_DUP_NAME` (no name collision across `actionSpec` /
 *      `streamSpec` / `contextSpec` keys — boilerplate generator emits
 *      identifiers from these; a collision shadows or compiles
 *      ambiguously) + `CTR_RESERVED_NAME` (no `_ggui:`-prefixed keys on
 *      `actionSpec` or `contextSpec` — the streamSpec equivalent
 *      already fires in `validateContractStructure`; this extends the
 *      rule uniformly to the other two inbound spec maps). Both folded
 *      into `validateContractStructure` and into the push handler via
 *      `assertNameInvariants(contract)`, which throws
 *      `NameInvariantError` listing every offending name. Companion
 *      to the `CTR_REF_*` cross-reference rules in
 *      `@ggui-ai/protocol/validation/cross-references`.
 *
 *   000000. Cross-reference invariants in `@ggui-ai/protocol/validation/cross-references`:
 *      `CTR_REF_NEXT_STEP` (validates `actionSpec[*].nextStep` resolves
 *      to `agentCapabilities.tools[*]`) + `CTR_REF_STREAM_SOURCE` (validates
 *      `streamSpec[*].source.tool` resolves to `agentCapabilities.tools[*]`).
 *      Both wired into `validateContractStructure` (so blueprint-registry +
 *      future structural-validator callers get cross-refs free) and into
 *      the push handler via `assertCrossReferences(contract)`, which
 *      throws `CrossReferenceError` listing every dangling reference in
 *      one pass. Separate from `assertActionRoutingTargets` (which checks
 *      `nextStep` against the SERVER's `knownTools` registry); both run
 *      at push and surface author-recoverable failures before any state
 *      mutation.
 *      No migration doc — purely additive enforcement of invariants
 *      already documented in the type-system (`StreamChannelEntry.source`,
 *      `ActionEntry.nextStep` reference `CTR_REF_*` linter rules in their
 *      docstrings; this commit ships the linter behind those mentions).
 *
 *   00000. `ActionEntry.dispatch` discriminated-union collapsed to a
 *      single shape with an optional `nextStep?: string` hint. All
 *      actions are agent-routed by default; the pre-rename
 *      `kind: 'tool'` synchronous-tool dispatch path is retired (it
 *      silently bypassed the agent's reasoning loop, which conflicted
 *      with the actions-vs-context placement rule). Removed:
 *      `ActionDispatch` type, `dispatchTo` helper namespace,
 *      `actionDispatchSchema` zod variant. Renamed: `dispatch.tool` →
 *      `nextStep`, `dispatch.intendedTool` → `nextStep` (the two collapse
 *      into one optional advisory hint). The cross-ref linter
 *      (`CTR_REF_NEXT_STEP`) enforces that `nextStep` resolves to a
 *      declared `agentCapabilities.tools[*]` key on the same
 *      contract. `UnknownActionToolError` retained but reframed
 *      to fire on `nextStep` resolution rather than `dispatch.tool`.
 *
 *   0000. `DataContract.clientTools` → `DataContract.clientCapabilities`
 *      complete reframe. The pre-rename `ClientToolEntry` carried
 *      `argsSchema`/`responseSchema`/`example` as if the agent invoked
 *      the tool RPC-style; that was inverted — browser-capability hooks
 *      are owned by the UI, fire from the user side, and only become
 *      agent-observable when the UI threads their value into a
 *      `contextSpec` slot or an `actionSpec` payload. New entry shape:
 *      `{description?, usage?, hook, package?, permission?, required?}`
 *      — pure declaration, no input/output, no example. The catalog map
 *      key rename `tools` → `capabilities` mirrors the conceptual shift.
 *      `ClientCapabilityHook<TOutput, TOptions=void>` generic + `CapabilityStatus`
 *      + `CapabilityError` ship in `@ggui-ai/protocol`'s
 *      `types/gadget.ts` to lock the runtime contract every
 *      hook in the planned `@ggui-ai/gadgets` v1 catalog MUST
 *      satisfy. `useClientTool` React hook + `registerClientTool` /
 *      `WireClientToolArgs` / `WireClientToolResult` types + iframe
 *      `tool:<name>` channel RPC path are deleted — no RPC channel
 *      surface remains.
 *
 * --------------------------------------------------------------------
 * Four wire-shape changes:
 *
 *   1. `ActionEntry` discriminated-union dispatch: collapsed
 *      `{tool, mode}` into `dispatch: {kind: 'tool', tool} | {kind:
 *      'agent', intendedTool?}`. Renamed `mode: 'host-routed'` →
 *      `kind: 'agent'` for vendor-neutrality. Deleted
 *      `OrphanActionError` + `AmbiguousActionRoutingError`
 *      (structurally impossible).
 *
 *   2. F4 schema-compat fail-fast at push validation: agent-recoverable
 *      schema violations throw `SchemaCompatError` at push time instead
 *      of silently committing a fallback error stack item. Eliminates
 *      the "stuck on Generating UI…" trap.
 *
 *   3. `ggui_new_session` introduced + `sessionId` REQUIRED on
 *      `ggui_handshake`: server-mints / agent-threads (SEP-2567 aligned).
 *      Optional `seed` enables deterministic idempotent derivation.
 *      Three-tool flow: `ggui_new_session` → `ggui_handshake` → `ggui_push`.
 *
 *   4. `pageId` → `stackItemId` rename: mechanical 1:1 sweep across
 *      protocol/handlers/server/SDKs/cloud. `getSessionByPageId` →
 *      `getSessionByStackItemId`; `PageNotFoundError` →
 *      `StackItemNotFoundError`; `targetPageId` → `targetStackItemId`.
 *
 * --------------------------------------------------------------------
 * Marketplace registry:
 *
 *   1. `GadgetDescriptor.bundleSri?: string` — additive optional
 *      field carrying the registry-emitted SHA-384 SRI hash of the
 *      bundle bytes (`sha384-<base64>` format, validated via
 *      `BUNDLE_SRI_RE`). When present, the iframe-runtime emits the
 *      bundle import as a `<link rel="modulepreload" integrity>`
 *      element so a CDN compromise can't silently swap the bundle.
 *      Both `gadgetDescriptorSchema` (wire) and
 *      `strictGadgetDescriptorSchema` (registry) carry the
 *      same regex. Authors do NOT set this manually; registry
 *      install writes it.
 *
 *   2. Marketplace registry HTTP API (`/search` / `/pkg` /
 *      `/publish` / `/conformance/check`). Off the WS wire surface
 *      — a distinct HTTP service, not a wire-protocol surface, and
 *      therefore not a conformance-kit bump.
 *
 * --------------------------------------------------------------------
 * Canvas mode (additive):
 *
 *   1. `McpAppAiGguiMeta.displayMode?: 'inline' | 'fullscreen'` —
 *      discriminator for the iframe-runtime canvas-mount path.
 *      When `'fullscreen'`, the runtime mounts a session-scoped
 *      `CanvasShell` (one iframe for the whole session) instead of
 *      the legacy per-stack-item iframe. Mutually exclusive with
 *      `stackItemId`. Producers SHOULD reject bootstraps with both
 *      `displayMode === 'fullscreen'` and `stackItemId` set; the
 *      protocol does not require them to. Absent ⇒ existing inline
 *      behavior. Spec-aligned with MCP App `McpUiDisplayMode` (the
 *      `'pip'` literal is reserved for a future floating-canvas
 *      variant, not yet implemented).
 *
 *   2. `_ggui:lifecycle` reserved channel + `CanvasLifecyclePayload`
 *      discriminated union. Server publishes lifecycle envelopes
 *      (`handshake_started` / `handshake_completed` /
 *      `push_started` / `consume_polling`) on the reserved channel;
 *      the canvas animator pill state machine advances on each kind.
 *      Wire shape lives in `@ggui-ai/protocol/types/canvas-lifecycle`;
 *      structural validator registered in `BUILTIN_RESERVED_VALIDATORS`.
 *
 *   3. `canvas_navigated` WS message type (Client → Server) with
 *      `CanvasNavigatedPayload`. Emitted by the canvas iframe when
 *      the user back-navigates; the server updates
 *      `Session.activeStackItemId` and MAY abort in-flight cold-gen
 *      for the popped item. Payload carries `sessionId` +
 *      `previousActiveItemId` + `activeItemId` (no `appId` — the
 *      subscriber binding is the authoritative scope).
 *
 *   4. `host_context_observed` WS message type (Client → Server) with
 *      `HostContextObservedPayload`. The iframe echoes the
 *      `McpUiHostContext` it received from `ui/initialize` so the
 *      server can persist a `HostContextProjection` on the session.
 *      Updates flow on every `host-context-changed` notification so
 *      the projection stays current for canvas display-mode policy.
 *
 * --------------------------------------------------------------------
 * Schema hardening:
 *
 *   1. `StackItem.adapters?: AdapterType[]` — DELETED. Grant model now
 *      lives entirely on `clientCapabilities.gadgets[*].permission`
 *      which projects to the iframe's `Permissions-Policy` header.
 *      `AdapterType` / `ADAPTER_TYPES` / `AdapterTypeSchema` removed
 *      from `@ggui-ai/protocol`. SDK + cloud-pod call sites that
 *      threaded `adapters: []` now drop the field entirely. The
 *      runtime `AdapterPermissions` permission-state interface +
 *      `AdapterRegistry` impl slot stay (orthogonal to the grant model
 *      retired here).
 *
 *   2. `ggui.json#registryAuth` — DELETED. Source-controlled config no
 *      longer carries Cognito pool ids. The publish CLI reads from
 *      env exclusively: canonical `GGUI_REGISTRY_COGNITO_POOL_ID` /
 *      `GGUI_REGISTRY_COGNITO_APP_CLIENT_ID`, legacy-fallback
 *      `GGUI_COGNITO_POOL_ID` / `GGUI_COGNITO_APP_CLIENT_ID`. No
 *      filesystem walk-up for ggui.json#registryAuth. Per-project
 *      pinning still possible via `.envrc` / shell wrapper.
 *
 *   3. Blueprint name regex unified under gadget rules.
 *      `BLUEPRINT_NAME_RE` is retired; both gadgets and blueprints now
 *      share `GADGET_NAME_RE` (`/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/` —
 *      kebab-case, 2–64 chars, no underscores, no single-char). Names
 *      that previously passed the looser blueprint regex (e.g.
 *      `weather_card`, single-char `a`) now reject at publish + at
 *      `register_blueprint`. The sample fixture `weather_card` was
 *      renamed to `weather-card` to satisfy the unified rule.
 *
 *   4. `pluginId` → `artifactId` wire-side rename in
 *      `@ggui-ai/registry-core` and the cloud Lambda env. The
 *      registry stores both gadgets and blueprints under one row
 *      family keyed by `kind: 'gadget' | 'blueprint'`; `artifactId`
 *      matches what the field actually carries. Renames:
 *      `PLUGINS_METADATA_SK → ARTIFACTS_METADATA_SK`,
 *      `Plugins/Plugin*Row → Artifacts/Artifact*Row`,
 *      `Row.pluginId → Row.artifactId`,
 *      `SearchResultEntry.pluginId → .artifactId`,
 *      `PublishResponseBody.pluginId → .artifactId`,
 *      RegistryStorage methods (`getPluginMetadata` etc.) → `…Artifact…`,
 *      CDK tables `<env>-Plugins` / `<env>-PluginVersions` →
 *      `…-Artifacts` / `…-ArtifactVersions`, Lambda env vars
 *      `PLUGINS_TABLE` / `PLUGIN_VERSIONS_TABLE` → `ARTIFACTS_TABLE` /
 *      `ARTIFACT_VERSIONS_TABLE`.
 *
 *   5. Schema tighten-ups — the protocol+handler boundaries now
 *      hard-reject misconfigured input that previously silently rode
 *      through:
 *
 *        - `clientCapabilitiesSpecSchema` is `.strict()` — the retired
 *          `libraries` field name fails parse instead of being
 *          silently dropped.
 *        - `LINT_CONTRACT_RETIRED_FIELD` / `RETIRED_CONTRACT_FIELDS` /
 *          `assertContractNoRetiredFields` — push + handshake reject
 *          contracts that carry `libraries`, `dispatch`, `wiredTools`,
 *          `clientTools`, `broadcast`, `capabilities`.
 *        - `strictGadgetDescriptorSchema.permission` is
 *          `z.enum(KNOWN_PERMISSION_NAMES)` — typos
 *          (`geolocaiton`) fail at parse.
 *        - `bundleUrl` / `styleUrl` / `connect[]` use `z.url()` not
 *          `z.string().min(1)`.
 *        - `tags` capped: ≤20 entries, each ≤64 chars, charset
 *          `[a-z0-9-]`.
 *        - `InMemoryAppMetadataStore` + cloud `dynamoAppMetadataStore`
 *          re-validate every gadget through `strictGadgetDescriptorSchema`
 *          on register + on read — strict-schema posture at the store
 *          seam.
 *        - `resolveGadgetUrls` uses `bundleHostScheme()` — `http://`
 *          for loopback, `https://` elsewhere.
 *        - `enrichContractGadgets` hoisted to `@ggui-ai/protocol` —
 *          one canonical site shared by push (handlers) and
 *          generation-dispatch (ui-gen).
 *        - `assertGeneratorRegistered` extracted — handshake + push
 *          share one allow-list check.
 *        - `gadgetRequiresSchema` extracted — single source for the
 *          `requires[]` field across wire / registry / artifact-manifest
 *          schemas.
 *        - `baseGadgetFieldsShape` extracted — both gadgetEntry
 *          schemas spread from one shape constant.
 *        - `manifestToRegistryEntry` helper hoisted from CLI to
 *          `@ggui-ai/artifact-manifest`; install CLI imports the
 *          canonical helper.
 *        - `ReadErrorCode` adds `'yanked'` for the 410-Gone path;
 *          `SearchErrorCode` defined as a closed enum; both are
 *          closed unions.
 *        - `conformanceFailureCode` sub-discriminator added on the
 *          publish conformance-failed response.
 *        - `GadgetGateErrorCode` closed enum union — single-source
 *          for push-gate error codes (`gadget_not_registered`,
 *          `gadget_public_env_missing`, `unknown_generator`).
 *        - `handshakeOutputSchema.reason?: string (≤280 chars)` —
 *          optional truncated diagnostic.
 *        - `assertNoDuplicateGadgetHooks` (slug:
 *          `duplicate_gadget_hook`) — hard reject when two bindings
 *          declare the same `(package, hook)` pair.
 *        - `resolveGadgetUrls` memoized — WeakMap-keyed cache on
 *          entry object identity.
 *
 * --------------------------------------------------------------------
 * Blueprint conformance gate:
 *
 *   1. `ConformanceErrorCode` (closed union, exported from
 *      `@ggui-ai/registry-core`) gains six new entries. The blueprint
 *      branch of `checkConformance()` was previously a no-op
 *      short-circuit; it is now five mandatory static gates plus one
 *      opt-in runtime probe:
 *
 *        - `blueprint_source_too_large` — `manifest.source` exceeds
 *          {@link MAX_BLUEPRINT_SOURCE_BYTES} (5 MiB, symmetric with
 *          the gadget bundle ceiling).
 *        - `blueprint_compile_error` — `esbuild.transformSync({
 *          loader: 'tsx' })` rejects the TSX source.
 *        - `blueprint_disallowed_import` — `oxc-parser` walks the
 *          source TSX (not compiled JS — esbuild tree-shakes unused
 *          imports even with `treeShaking: false`) and rejects any
 *          import outside `{ react, react/jsx-runtime, react-dom,
 *          @ggui-ai/gadgets }`. Blueprints have no `peerDeps` channel.
 *        - `blueprint_missing_default_export` — iframe runtime mounts
 *          the default export as the root component.
 *        - `fixture_props_shape_mismatch` — when both
 *          `manifest.fixtureProps` and `manifest.contract.propsSpec`
 *          are present, every key marked `required: true` on
 *          `propsSpec.properties` must appear on the fixture.
 *        - `blueprint_runtime_probe_failed` — opt-in via
 *          `PublishArtifactDeps.blueprintProbe`. Probe compiles TSX →
 *          CJS, evaluates in Node `vm.runInContext` with a `require`
 *          shim, mounts the default export via
 *          `react-dom/server.renderToString` with the manifest's
 *          fixtureProps; any thrown error during compile / module
 *          load / mount / render surfaces this code.
 *
 *      Consumers with an exhaustive `switch` on
 *      `ConformanceErrorCode` MUST add the six new branches. Closed-
 *      union semantics mean prior-version exhaustive consumers
 *      silently fall through on the new codes.
 *
 *   2. New constant `MAX_BLUEPRINT_SOURCE_BYTES` (= `5 * 1024 * 1024`)
 *      exported from `@ggui-ai/registry-core`. Symmetric with the
 *      gadget bundle ceiling so publishers can pre-check source size
 *      before invoking `ggui blueprint publish`.
 *
 *   3. New optional `PublishArtifactDeps.blueprintProbe?:
 *      BlueprintProbeRunner` deps slot on the publish op. Implementa-
 *      tions wiring this slot get the 6th conformance gate (the
 *      runtime probe); leaving it `undefined` preserves the
 *      static-only behavior. Reference implementation:
 *      `@ggui-ai/blueprint-probe`.
 *
 *   4. `POST /conformance` runs the 5 static gates only. `POST
 *      /publish` MAY additionally run the runtime probe when the
 *      deploy wires `blueprintProbe`. A blueprint passing
 *      `/conformance` MAY still be rejected by `/publish` with
 *      `blueprint_runtime_probe_failed`. Publishers SHOULD run the
 *      local probe before publishing.
 *
 * Security posture for the runtime probe (read before wiring it).
 * `vm.runInContext` is NOT a security sandbox — it's a JavaScript-
 * isolation primitive, not an adversarial-code-execution boundary.
 * A blueprint that passes all five static gates can climb the
 * prototype chain of the injected `react` module to reach the parent
 * process's `Function` constructor and execute arbitrary code in the
 * parent context.
 *
 * Because of this, **the cloud-hosted publish Lambda's default deps
 * do NOT wire `blueprintProbe`.** The static gates still run on every
 * publish. The runtime probe is local-trust-boundary-only by default
 * — CLI on the publisher's own machine, self-hosted registries with
 * a closed publisher pool. A fully isolated probe (isolated-vm,
 * separate process, execution timeout) is future work.
 *
 * --------------------------------------------------------------------
 * Sigstore signing for public-visibility artifacts. The trust chain
 * bifurcates: private artifacts → Ed25519 (existing); public
 * artifacts → sigstore (Fulcio short-lived cert + Rekor transparency
 * log + cosign bundle).
 *
 *   1. **`SigstoreSignature` widened** to embed a serialized cosign
 *      bundle (per `@sigstore/bundle` v0.3 spec) — `{ algorithm:
 *      'sigstore-cosign', bundleSha384, bundle: <serialized-json>,
 *      signedAt }`. Old narrow shape (`{ uuid, logIndex }`) carried
 *      only Rekor coordinates and was insufficient for offline
 *      verification. The widened shape ships everything a verifier
 *      needs: cert chain, inclusion proof, signed entry timestamp.
 *
 *   2. **`PublishArtifactInput.signature`** now typed
 *      `GadgetSignature = Ed25519Signature | SigstoreSignature`
 *      (discriminated union over `algorithm`). The publish op
 *      dispatches on the discriminator after a single-shape guard
 *      (`isGadgetSignature` from `@ggui-ai/gadget-signing`):
 *        - `'ed25519'` → AuthorKeys-rooted flow (unchanged).
 *        - `'sigstore-cosign'` → `verifyBundleSigstore` flow; on
 *          verify-OK the leaf cert PEM is extracted from
 *          `bundle.verificationMaterial.x509CertificateChain.certificates[0].rawBytes`
 *          and pinned as `ArtifactVersionRow.authorPublicKey`.
 *
 *   3. **`@ggui-ai/gadget-signing` exports** new canonical type
 *      guards `isEd25519Signature` / `isSigstoreSignature` /
 *      `isGadgetSignature` (collapsing 3 duplicated inline guards)
 *      and new error class `SigstoreSigningError` with discriminated
 *      `code: 'oidc_invalid' | 'fulcio_error' | 'rekor_error' |
 *      'unknown'`. The `SigstoreNotImplementedError` stub class is
 *      DELETED (pre-launch posture — no shims).
 *
 *   4. **`PublishError.error` gains** `oidc_resolution_failed`
 *      (sub-discriminated by `oidcCode`) for CLI publish-side failure
 *      to acquire an OIDC token. Server-side never returns this code
 *      — it's CLI-internal — but the wire shape allows for it so the
 *      same error envelope flows through the CLI's error printer.
 *
 *   5. **CLI publish dispatches on `manifest.visibility`**: `'public'`
 *      → sigstore flow (calls `resolveOidcToken` then
 *      `signBundleSigstore`); `'private'` → Ed25519 flow (unchanged).
 *      New `--identity-token <jwt>` flag + `GGUI_OIDC_TOKEN` env var.
 *      Resolution order: flag → env → GitHub Actions ambient (via
 *      `ACTIONS_ID_TOKEN_REQUEST_URL`) → interactive PKCE browser
 *      flow on a TTY.
 *
 *   6. **CLI install dispatches on `signature.algorithm`**:
 *      `'sigstore-cosign'` → `verifyBundleSigstore` with optional
 *      `--verify-identity <pattern>` (literal or `/regex/[flags]`
 *      form). The flag enforces that the bundle's Fulcio leaf cert
 *      SAN matches the supplied identity. Ed25519 unchanged.
 *
 * No exhaustive-switch concerns — `GadgetSignature` was already a
 * discriminated union; the changes widen the SigstoreSignature
 * variant in-place. Consumers that always hit the Ed25519 branch
 * keep working without modification.
 *
 * Trust chain table:
 *
 *   | visibility | trust chain                                    |
 *   | ---------- | ---------------------------------------------- |
 *   | `private`  | Ed25519 author key pinned in registry's        |
 *   |            | AuthorKeys table, base-rooted at the           |
 *   |            | publisher's Cognito subject.                   |
 *   | `public`   | Fulcio short-lived X.509 cert (OIDC-backed,    |
 *   |            | Sigstore-keyless) + Rekor inclusion proof,     |
 *   |            | offline-verifiable via the embedded cosign     |
 *   |            | bundle.                                        |
 *
 * --------------------------------------------------------------------
 * Two-layer storage for blueprint compiled bytes (TSX → JS compile
 * boundary):
 *
 *   - Blueprint version rows now carry a `compiledDigest` pointer
 *     (lowercase hex SHA-256 of the compiled bytes) into a new
 *     `<envName>-CompiledBlobs` DDB table; the previous
 *     `blueprintSource` column is deleted (raw TSX stays on
 *     `manifest.source` for audit / future-recompile).
 *   - `ReadPkgResponse` exposes `compiledDigest` + `compiledBytes`
 *     (base64); install consumers MUST read compiledBytes — the
 *     registry is now the trust boundary for the compile step.
 *   - `CompiledBlobRow` reserves `manifestSig` + `compiledSig`
 *     columns for a future signing wave; this change writes neither.
 *   - esbuild pinned to 0.25.12 (was `^0.25.0`) for digest stability.
 *
 * `compiledDigest` is the shareable cache key for cross-app cache
 * sharing and cross-registry federation; the reserved signature
 * columns ride on the blob row for a later signing wave.
 *
 * --------------------------------------------------------------------
 * `package.json`-style gadget refs + `GadgetRef` / `GadgetDescriptor`
 * split. The wire shape
 * `DataContract.clientCapabilities.gadgets[*]` carries the identity
 * tuple `{ hook, package, version, description?, usage? }`. Transport
 * metadata (`bundleUrl` / `bundleHost` / `bundleSri` / `typesUrl` /
 * `typesSri` / `permission` / `connect` / `requires` / `styleUrl` /
 * `required` / `gotchas` / `example`) stays on the registered
 * `GadgetDescriptor` resolved server-side from `App.gadgets`. The
 * resolved descriptor subset rides alongside the wire on
 * `SessionStackEntry.gadgetDescriptors` as a sidecar — no enrichment
 * overlay on the contract surface.
 *
 *   1. **`GadgetRef = { hook, package, version, description?, usage? }`**
 *      Wire-side identity matches `package.json` dependency pins:
 *      bare npm package name + exact semver pin (no ranges). Schema
 *      `gadgetRefSchema` is `.strict()` and rejects transport fields
 *      + range syntax at parse time.
 *
 *   2. **`GadgetEntry` → `GadgetDescriptor`** (TS interface rename).
 *      Sibling renames: `gadgetEntrySchema` →
 *      `gadgetDescriptorSchema`; `registryGadgetEntrySchema` →
 *      `strictGadgetDescriptorSchema`; `gadgetManifestToGadgetEntry`
 *      → `gadgetManifestToGadgetDescriptor`. No back-compat aliases.
 *
 *   3. **`ClientCapabilitiesSpec` is non-generic** — values are wire-side
 *      `GadgetRef` only. Post-resolution descriptors live on the
 *      `SessionStackEntry.gadgetDescriptors` sidecar (filtered subset
 *      of `App.gadgets`). `filterDescriptorsToContract(contract,
 *      appGadgets) → readonly GadgetDescriptor[]` replaces the prior
 *      `enrichContractGadgets` overlay.
 *
 *   4. **`assertNoDuplicateGadgetHooks` keys on `hook` alone.** Hook
 *      unique-per-app at registration time (`lintGadgetCatalog`);
 *      LLM-generated component code wouldn't disambiguate two
 *      destructure bindings with the same name. Operators pre-alias
 *      at registration if they want both.
 *
 *   5. **New `@ggui-ai/gadgets` adapter port**:
 *      `GadgetCatalogAdapter { list(appId): Promise<readonly
 *      GadgetDescriptor[]> }` + `InMemoryGadgetCatalog` (static map +
 *      `withDefault()` factory) + `CachingGadgetCatalog` (per-appId
 *      TTL + single-flight dedup + `invalidate(appId?)`). One batch
 *      method by design — never N+1 per-hook. Per-environment adapter
 *      implementations (JSON / DynamoDB) land separately.
 *
 *   6. **`NPM_PACKAGE_NAME_RE` + `SEMVER_PIN_RE`** schema constants
 *      published from `@ggui-ai/protocol`. Loose `z.string()` checks
 *      retired; agent prompts show exact pinned identity. Cache key
 *      `hashContract(wire, intent)` is a pure function of the wire
 *      bytes (no canonicalize step) — version bumps invalidate caches
 *      automatically.
 *
 * No exhaustive-switch concerns. Agents that previously omitted
 * `package` / `version` on a wire ref now fail at parse — the loud
 * failure is the design intent (a caller bug, not a forward-compat
 * hedge).
 *
 * --------------------------------------------------------------------
 * Phase B — flatten-render-identity. Session vessel deleted; renderId
 * is the single identity referenced across the wire (BREAKING,
 * pre-launch):
 *
 *   b1. **`Session` deleted.** The vessel-wrapping-a-stack-of-one model
 *      is gone. `SessionStackEntry` (the actual rendered thing) was
 *      promoted to a flat `Render` union (`ComponentRender | SystemRender
 *      | McpAppsRender`) and `SessionView` was retired. Conversation
 *      grouping (sibling renders within one host chat) flows via the
 *      unchanged `_meta["ai.ggui/host-session"]` channel captured ONCE
 *      at render creation, NOT by lifting fields onto every Render.
 *
 *   b2. **`sessionId` + `stackItemId` → `renderId`.** One identifier on
 *      the wire (the two values were already the same once each render
 *      was its own thing). Renames cover `SubscribePayload`, `AckPayload`,
 *      `StreamEnvelope`, `ActionEnvelope`, `GguiConsumeInput`,
 *      `GguiCloseInput`, `GguiEmitInput`, `PropsUpdatePayload`,
 *      `DrainAckPayload`, lifecycle events, `submit-action` envelope,
 *      user-action meta. `AckPayload.stack[]` → `AckPayload.render`
 *      (single item — vessel is gone).
 *
 *   b3. **Tools collapsed: `ggui_new_session` deleted; `ggui_push`
 *      renamed to `ggui_render`.** The three-tool flow is `ggui_handshake`
 *      → `ggui_render` → `ggui_update` / `ggui_consume`. The handshake
 *      mints the render server-side; `ggui_new_session` is gone (its
 *      sessionId minting folded into the handshake-internal renderId
 *      mint). TS aliases `GguiPushInput/Output` → `GguiRenderInput/Output`;
 *      Zod schemas `pushInputSchema` / `pushOutputSchema` → `renderInputSchema`
 *      / `renderOutputSchema`. `handshakeInputSchema.sessionId` REMOVED
 *      (handshake input no longer carries a session handle); `nextStep.tool`
 *      literal `'ggui_push'` → `'ggui_render'`; output `stackItemId` field
 *      → `renderId`. The `'compose'` action enum value dropped (was
 *      multi-item-stack push semantics, retired with the stack).
 *
 *   b4. **Slice envelope collapsed.** `_meta["ai.ggui/session"]` +
 *      `_meta["ai.ggui/stack-item"]` (the two-key pair) → one
 *      `_meta["ai.ggui/render"]` key carrying identity + boot wiring +
 *      live-channel auth + capability advertisements + render state +
 *      contract pointer + component-mode discriminator. Single-slice
 *      parser `parseMcpAppAiGguiRenderMeta`; emitter
 *      `toMcpAppEnvelope` emits one key.
 *
 *   b5. **Resource URI renamed.** `ui://ggui/session` → `ui://ggui/render`;
 *      `GGUI_SESSION_RESOURCE_URI` → `GGUI_RENDER_RESOURCE_URI`;
 *      `GGUI_SESSION_UI_META` → `GGUI_RENDER_UI_META`. Error codes
 *      renamed too: `SESSION_NOT_FOUND` → `RENDER_NOT_FOUND`;
 *      `STACK_ITEM_NOT_FOUND` → `RENDER_NOT_FOUND`;
 *      `CONCURRENT_SESSION_LIMIT` → `CONCURRENT_RENDER_LIMIT`.
 *
 *   b6. **Retired wire-side payloads deleted (no shims).** `PushPayload`,
 *      `PopPayload`, `GetStackPayload`, `SessionPayload`,
 *      `CanvasNavigatedPayload`, `GeneratePayload`, `GenerateAckPayload`,
 *      `GguiNewSessionInput/Output`, `GguiGetStackInput/Output`,
 *      `StackItemSummary`, `EventSubscription`, `DEFAULT_SUBSCRIPTION`,
 *      `Action` re-export, lifecycle-event literals
 *      `lifecycle:stack_push`, `stack_pop`, `session_start`,
 *      `session_end`. `SessionSummaryWire` → `RenderSummaryWire`
 *      (always-1 `stackItemCount` field deleted). Stack-navigation
 *      reducer (`stackNavigationReducer`, `initialNavigationState`,
 *      `StackNavigationState`, `StackNavigationAction`) deleted — no
 *      stack of N to navigate.
 *
 *   b7. **`ggui_close` tool deleted.** Matches the earlier deletion of
 *      `ggui_new_session`: with the Session vessel gone, there is no
 *      entry-and-exit ceremony to bracket a render. Renders decay
 *      implicitly via TTL — created → active → expired. The
 *      `RenderStatus` union collapses from
 *      `'active' | 'completed' | 'expired'` to `'active' | 'expired'`;
 *      the `'session.closed'` `RenderEventType` literal is gone (no
 *      terminal ledger event); `GguiCloseInput` / `GguiCloseOutput`
 *      types + `closeInputSchema` Zod schema deleted from the protocol
 *      surface. `notifyRenderClosed` observer-notifier seam, the
 *      `RenderStore`-side `closed` bucket flag + per-render-close revoke
 *      paths (`shortCodeIndex.revokeByStackItemId`,
 *      `pendingEventConsumer.markDeleted`) all retire alongside.
 *      Agent-side: the long-poll loop terminates on TTL expiry rather
 *      than on an explicit terminal status.
 *
 *   b8. **SessionEvent dropped; RenderEvent is the single ledger
 *      primitive (Wave 7, 2026-05-28).** The protocol-side `SessionEvent`
 *      (sequence + emittedAt + type + payload) and the server-side
 *      `RenderEvent` (seq + timestamp[ms-epoch] + type + data) merge
 *      into one canonical `RenderEvent` owned by `@ggui-ai/protocol`.
 *      Field shape: `seq + type + timestamp[ISO 8601 UTC string] +
 *      data`. `EventsResponse.events` now ships `ReadonlyArray<RenderEvent>`.
 *      The WS replay frame discriminator renames
 *      `'session_event' → 'render_event'`; payload type follows the
 *      same shape. `@ggui-ai/mcp-server-core` re-exports `RenderEvent`
 *      / `RenderEventType` from `@ggui-ai/protocol` so downstream
 *      import paths stay stable. Sqlite + DDB stores stamp ISO
 *      strings on write; legacy numeric rows are coerced on read.
 *      Cross-deployment uniformity: the same field type ships from
 *      polling HTTP endpoint, WS replay frame, and store-side `observe()`.
 */
export const PROTOCOL_VERSION = "draft-2026-05-28";

/**
 * Schema version stamped onto wire envelopes that opt into the
 * `schemaVersion` forward-compat field (see {@link ActionEnvelope},
 * {@link StreamEnvelope}, {@link ContractErrorPayload}).
 *
 * Pre-launch semantics (current): producers SHOULD stamp; consumers
 * SHOULD NOT reject on mismatch — the field is advisory and lets old
 * clients recognize the protocol generation their server emits.
 *
 * Launch-cutover semantics (future): a later change promotes this to
 * required on producers and tightens client-side policy (e.g.,
 * reject-with-UPGRADE-REQUIRED when the received version's major bumps
 * past the client's known major).
 *
 * Kept as a string so SemVer-like extensions (`'1.0-rc.2'`,
 * `'1.1'`) don't require retyping consumers. Value equals
 * {@link PROTOCOL_VERSION} today — the alias exists so envelope-layer
 * consumers can reference schema-versioning specifically without
 * coupling to the broader cache-invalidation constant.
 */
export const PROTOCOL_SCHEMA_VERSION = PROTOCOL_VERSION;

/**
 * Canonical live-channel error code emitted when a peer's declared
 * {@link SubscribePayload.supportedVersions} /
 * {@link AckPayload.serverVersion} does not overlap the receiver's
 * known compatible set.
 *
 * `ErrorPayload.code` is typed as `string` (open) rather than a closed
 * union — this constant anchors the canonical literal so consumers can
 * pattern-match against a typed reference instead of string-sniffing.
 *
 * Policy posture:
 *
 *   - OSS `createSessionChannelServer` default
 *     `versionPolicy: 'reject'`: server emits `UPGRADE_REQUIRED` AND
 *     closes the connection so the caller cannot proceed against a
 *     version-mismatched session. Canonical first-party posture.
 *   - `versionPolicy: 'advisory'` (legacy opt-out): server emits an
 *     `UPGRADE_REQUIRED` error envelope on mismatch but keeps the
 *     connection open. Use only for controlled migration windows
 *     during which legacy-version clients must remain attached.
 *
 * Consumers (clients and servers alike) MUST handle the code as a
 * string — the constant exists for authoring ergonomics, not to imply
 * a closed union on `ErrorPayload.code`.
 */
export const UPGRADE_REQUIRED = "UPGRADE_REQUIRED";

/**
 * Versions of the ggui protocol this client library accepts on the
 * wire.
 *
 * The first-party client declares this set on every subscribe via
 * {@link SubscribePayload.supportedVersions}. A server whose
 * {@link PROTOCOL_SCHEMA_VERSION} is NOT a member of this list is a
 * version mismatch — the server replies with an `UPGRADE_REQUIRED`
 * error envelope (see {@link UPGRADE_REQUIRED}). Symmetrically, if a
 * server returns {@link AckPayload.serverVersion} not in this set,
 * the client surfaces `UPGRADE_REQUIRED` to the caller.
 *
 * Seeded with {@link PROTOCOL_SCHEMA_VERSION}. Future minor-compatible
 * versions are added here as the protocol evolves — a client that
 * accepts both `"1.0"` and `"1.1"` ships with `['1.0', '1.1']`, and
 * `PROTOCOL_SCHEMA_VERSION` advances independently.
 *
 * Frozen so runtime consumers can't mutate the module-level array
 * (would be a cross-session leak).
 */
export const CLIENT_SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  PROTOCOL_SCHEMA_VERSION,
]);
