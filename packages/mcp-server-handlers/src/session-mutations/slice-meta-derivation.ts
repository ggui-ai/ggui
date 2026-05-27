/**
 * Per-stack-item slice-meta derivation helpers.
 *
 * # Why this file exists
 *
 * The protocol has more than one transport that ships the `ai.ggui/*`
 * slice meta to the iframe-runtime:
 *
 *   - **MCP Apps** — `_meta["ai.ggui/session"]` +
 *     `_meta["ai.ggui/stack-item"]` on the `ggui_push` tool result,
 *     delivered via the host's tool-call → result postMessage path
 *     (Claude.ai, Claude Desktop).
 *   - **Public-render `/r/<shortCode>`** — inline
 *     `__GGUI_META__` global on the self-contained shell
 *     HTML (content-negotiated `application/json` returns the same
 *     slice envelope), served standalone for direct browser visits
 *     or non-MCP-Apps hosts.
 *   - **Future transports** — ChatShell embeds, WebSocket-only
 *     session boot, SSR-prerendered HTML, mobile native, etc.
 *
 * Each transport composes the slice meta with its own envelope
 * concerns (sessionId / appId / runtimeUrl / wsUrl / theme / auth /
 * codeUrl), but the *projection of the active stack item itself* is
 * variant-agnostic. Without a single source of truth for that
 * projection, every transport re-implements it, and a field that
 * grows on one path silently drifts on another (the 2026-05-09
 * `propsJson` regression: emitted on `/r/<shortCode>` but not on the
 * MCP-Apps slice meta for component items, so claude.ai's iframe
 * crashed accessing declared propsSpec fields).
 *
 * {@link deriveRenderMeta} is the single entry point.
 * Every transport SHOULD route stack-item-derived fields through it.
 * The lower-level `derive*` helpers stay exported for callers that
 * only need a single field (e.g. legacy code paths during migration).
 *
 * Pure functions; no I/O, no mutation. The caller has already loaded
 * the session + picked the active stack item.
 */
import {
  bundleHostScheme,
  computeContractBundle,
  deriveContextDefault,
  DEFAULT_BUNDLE_HOST,
  type GadgetDescriptor,
  type JsonSchema,
  type JsonValue,
  type Render,
} from '@ggui-ai/protocol';
import {
  deriveContextName,
  type CompiledContractValidators,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Resolve the canonical bundle URL + style URL for a gadget entry.
 *
 * Resolution order (operator override wins over author default wins
 * over spec default):
 *
 *   1. `entry.bundleUrl` — explicit full URL, escape hatch that
 *      bypasses bundleHost resolution entirely. Used when a wrapper
 *      ships via a non-registry CDN (esm.sh, jsdelivr, …).
 *   2. `entry.bundleHost` + `entry.package` + `entry.version` —
 *      hostname resolution: server assembles
 *      `https://<bundleHost>/bundles/<scope>/<name>/<version>/bundle.js`
 *      (matches `@ggui-ai/registry-core`'s `bundleStorage.bundleUrl(…)`
 *      path layout — see `packages/registry-core/src/impls/memory-bundle-storage.ts`).
 *   3. Spec default `registry.ggui.ai` — applied when `entry.bundleHost`
 *      is absent but `package` + `version` are present (first-party
 *      hosted-registry default).
 *
 * Returns `undefined` for either url when the entry doesn't have
 * enough info to resolve (e.g., `package` is set but no `version`
 * stamped, or only `package` without any hostable bundle path —
 * a STDLIB-style hook that the iframe resolves via bare-specifier
 * `package` import alone, no bundle URL needed).
 *
 * Style URL resolution mirrors bundle resolution. `entry.styleUrl`
 * wins as the full-URL escape hatch; otherwise the same bundleHost
 * computation suffixes `style.css` instead of `bundle.js`.
 *
 * Pure helper; no I/O. Exported for tests + callers that need the
 * resolved URLs outside `deriveBundleOrigins` (e.g., the iframe
 * runtime's per-gadget `bundleUrl` projection on the
 * `ai.ggui/session.gadgets[*]` slice).
 *
 * @public
 */
export function resolveGadgetUrls(
  entry: Pick<
    GadgetDescriptor,
    'bundleUrl' | 'bundleHost' | 'styleUrl' | 'package' | 'version'
  >,
): { readonly bundleUrl?: string; readonly styleUrl?: string } {
  // Memoize on entry identity. `deriveBundleOrigins` and
  // `deriveGadgetRegistrations` both walk the same gadget map during
  // one push; this collapses 2N calls to N.
  if (entry !== null && typeof entry === 'object') {
    const cached = resolvedGadgetUrlsCache.get(entry);
    if (cached !== undefined) return cached;
    const fresh = resolveGadgetUrlsImpl(entry);
    resolvedGadgetUrlsCache.set(entry, fresh);
    return fresh;
  }
  return resolveGadgetUrlsImpl(entry);
}

/**
 * Per-stack-item resolved-URL cache. The two downstream consumers
 * (`deriveBundleOrigins`, `deriveGadgetRegistrations`) would
 * otherwise call `resolveGadgetUrls(entry)` independently — one call
 * per gadget per consumer = 2N resolves per push. WeakMap-keyed on
 * the entry object
 * collapses that to N: `deriveRenderMeta` is the only
 * site that mutates entries; subsequent consumers see the cached
 * value.
 *
 * Cache is global because resolveGadgetUrls is referentially
 * transparent — same input → same output forever. No mutation seam
 * to invalidate.
 */
const resolvedGadgetUrlsCache = new WeakMap<
  object,
  ReturnType<typeof resolveGadgetUrlsImpl>
>();

function resolveGadgetUrlsImpl(
  entry: Pick<
    GadgetDescriptor,
    'bundleUrl' | 'bundleHost' | 'styleUrl' | 'package' | 'version'
  >,
): { readonly bundleUrl?: string; readonly styleUrl?: string } {
  const { bundleUrl, bundleHost, styleUrl, package: pkg, version } = entry;

  // Stdlib gadgets ship with the iframe runtime; no bundle URL is
  // loaded for them. Skip both bundleHost computation
  // and even explicit bundleUrl/styleUrl (operators don't override
  // the stdlib's transport — that's by-construction first-party).
  if (pkg === '@ggui-ai/gadgets') return {};

  const hasExplicitBundleUrl =
    typeof bundleUrl === 'string' && bundleUrl.length > 0;

  const computeFromHost = (file: 'bundle.js' | 'style.css'): string | undefined => {
    if (typeof pkg !== 'string' || typeof version !== 'string') return undefined;
    const host =
      typeof bundleHost === 'string' && bundleHost.length > 0
        ? bundleHost
        : DEFAULT_BUNDLE_HOST;
    return `${bundleHostScheme(host)}://${host}/bundles/${pkg}/${version}/${file}`;
  };

  const resolvedBundle = hasExplicitBundleUrl ? bundleUrl : computeFromHost('bundle.js');
  // When the operator explicitly sets `bundleUrl` (the escape-hatch
  // out of bundleHost mode), don't auto-synthesize a
  // styleUrl from `registry.ggui.ai/.../style.css` — that 404 would
  // pollute CSP `style-src`. Operator who escape-hatched the bundle
  // sets styleUrl too if they have one. bundleHost-mode entries still
  // get both bundle + style synthesized symmetrically.
  const resolvedStyle =
    typeof styleUrl === 'string' && styleUrl.length > 0
      ? styleUrl
      : hasExplicitBundleUrl
        ? undefined
        : computeFromHost('style.css');

  return {
    ...(resolvedBundle !== undefined ? { bundleUrl: resolvedBundle } : {}),
    ...(resolvedStyle !== undefined ? { styleUrl: resolvedStyle } : {}),
  };
}

/**
 * Per-action nextStep-tool mapping for an active stack item, derived
 * from its `actionSpec`. Returns `undefined` when there are no entries
 * (caller spreads `...(result !== undefined ? {actionNextSteps: result} : {})`
 * to keep legacy bootstrap envelopes byte-identical).
 *
 * Post-2026-05-11: every `actionSpec` entry is agent-routed; the
 * optional `nextStep` field names the agent-side tool the agent
 * INTENDS to call next. The renderer surfaces this map as
 * `actionNextSteps` to keep the bootstrap-meta shape stable —
 * downstream tooling (renderer dev console, SessionInspector) reads it
 * as "which actions hint at which tools." Entries without `nextStep`
 * are omitted.
 */
export function deriveWiredActionTools(
  item: Render,
): Record<string, string> | undefined {
  // McpApps + system variants don't carry an actionSpec. Discriminator
  // narrowing gives typed access to ComponentRender.actionSpec.
  if (item.type === 'mcpApps' || item.type === 'system') return undefined;
  const actionSpec = item.actionSpec;
  if (actionSpec === undefined || actionSpec === null) return undefined;
  const collected: Record<string, string> = {};
  for (const [actionName, entry] of Object.entries(actionSpec)) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.nextStep === 'string' &&
      entry.nextStep.length > 0
    ) {
      collected[actionName] = entry.nextStep;
    }
  }
  if (Object.keys(collected).length === 0) return undefined;
  return collected;
}

/**
 * Per-slot contextSpec data for an active stack item, derived to a
 * wire-friendly array. Returns `undefined` when no slots are declared.
 *
 * The runtime synthesizes one `React.createContext(default)` per
 * entry at boot. `default` is mandatory — push-time validation
 * rejects entries that resolve to `undefined`, so by construction
 * every projected slot here carries a derivable default. The
 * defensive `null` fallback below mirrors push.ts's posture: prefer a
 * literal null over silently emitting `undefined`, which would break
 * the runtime's typed Provider seed.
 *
 * Resume-aware seed: when the StackItem carries a `contextSnapshot`
 * (mirrored from the runtime via `ggui_runtime_sync_context`), each slot's
 * `default` is sourced from the snapshot value if present,
 * otherwise from the contract's authoring-time default. Chat-history
 * rehydrate therefore restores the user's last-known interactive
 * state instead of resetting to the contract default.
 */
export function deriveContextSlots(
  item: Render,
): ReadonlyArray<{
  name: string;
  contextName: string;
  schema: JsonSchema;
  default: JsonValue;
  debounceMs?: number;
}> | undefined {
  // Both `contextSpec` and `contextSnapshot` live on the `component`
  // variant of SessionStackEntry (StackItem) — narrowing via the
  // discriminator gives typed access without casts. mcpApps and
  // system variants don't carry these fields.
  if (item.type === 'mcpApps' || item.type === 'system') return undefined;
  const contextSpec = item.contextSpec;
  if (contextSpec === undefined || contextSpec === null) return undefined;
  const snapshot = item.contextSnapshot;
  const collected: Array<{
    name: string;
    contextName: string;
    schema: JsonSchema;
    default: JsonValue;
    debounceMs?: number;
  }> = [];
  for (const [slotName, entry] of Object.entries(contextSpec)) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      entry.schema !== undefined &&
      entry.schema !== null &&
      typeof entry.schema === 'object'
    ) {
      // Snapshot-first, contract-default fallback. The snapshot may
      // legitimately carry `null` for a slot whose schema declares
      // it nullable — preserve that with a `name in snapshot` check
      // rather than truthy-coercing.
      const snapshotValue =
        snapshot !== undefined && slotName in snapshot
          ? snapshot[slotName]
          : undefined;
      const derivedDefault =
        snapshotValue !== undefined
          ? snapshotValue
          : deriveContextDefault(entry);
      collected.push({
        name: slotName,
        contextName: deriveContextName(slotName),
        schema: entry.schema,
        default: derivedDefault === undefined ? null : derivedDefault,
        ...(entry.debounceMs !== undefined ? { debounceMs: entry.debounceMs } : {}),
      });
    }
  }
  if (collected.length === 0) return undefined;
  return collected;
}

/**
 * Permissions-Policy directive list for an active stack item, derived
 * from the contract's `clientCapabilities.gadgets[*].permission`
 * field. Returns `undefined` when no permissions are declared.
 *
 * Each declared gadget entry MAY carry a `permission` string keyed to
 * the browser Permissions API name (`'camera'`, `'microphone'`,
 * `'geolocation'`, `'clipboard-read'`, `'clipboard-write'`,
 * `'notifications'`, …) or an arbitrary identifier for custom
 * platforms. The host union-deduplicates these and emits them as a
 * Permissions-Policy directive set on the iframe's HTTP response (for
 * the public-render `/r/<shortCode>` path) and projects into the
 * bootstrap as `permissionsPolicy` (for in-iframe surface inspection +
 * future per-transport permission delivery).
 *
 * An earlier design derived the per-app `Permissions-Policy` from a
 * deny-default `App.declaredAdapters` runtime check that required
 * operators to manually whitelist capabilities at boot. That
 * App-side runtime gate has been retired — every push now declares
 * its own permission set via the contract.
 *
 * Resolution rules:
 *   - mcpApps / system items have no `clientCapabilities`; returns
 *     `undefined`.
 *   - Empty libraries map ⇒ `undefined` (no permissions requested).
 *   - Entries WITHOUT a `permission` field are skipped (the gadget
 *     does not gate on a browser permission).
 *   - Duplicate values are deduplicated; output order is stable
 *     (entries appear in declaration order from the libraries map).
 */
export function derivePermissionsPolicy(
  item: Render,
): readonly string[] | undefined {
  // Read from the descriptor sidecar (not the wire use map). The
  // wire's `GadgetExportUse` doesn't carry `permission`; the resolved
  // descriptor does.
  const descriptors =
    'gadgetDescriptors' in item ? item.gadgetDescriptors : undefined;
  if (descriptors === undefined || descriptors.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const collected: string[] = [];
  // A descriptor is a PACKAGE; `permission` is per-EXPORT (on each
  // `exports[*]`). Walk every export of every descriptor.
  for (const descriptor of descriptors) {
    for (const exp of descriptor.exports) {
      if (
        typeof exp.permission !== 'string' ||
        exp.permission.length === 0
      ) {
        continue;
      }
      if (seen.has(exp.permission)) continue;
      seen.add(exp.permission);
      collected.push(exp.permission);
    }
  }
  if (collected.length === 0) return undefined;
  return collected;
}

/**
 * Bundle/style/API origins derived from a stack item's
 * `gadgetDescriptors` sidecar. Sibling to
 * {@link derivePermissionsPolicy} — same iteration pattern over the
 * descriptor sidecar, different fields.
 *
 * Three buckets, one per CSP directive:
 *
 *   - `script` — `script-src` allowlist. Sourced from `bundleUrl`
 *     origins on each gadget descriptor. Wrappers bundle their
 *     underlying 3rd-party deps at build time and ggui hosts the
 *     bundle (same-origin via the OSS `/_ggui/libs/...` mount or the
 *     marketplace CDN); when authors point `bundleUrl` at an external
 *     CDN, that CDN origin lands here. `script-src` derivation
 *     intentionally does NOT include `package`-only entries — those
 *     are resolved by the iframe's existing module-resolver and load
 *     from `'self'`.
 *   - `style` — `style-src` allowlist. Sourced from `styleUrl`
 *     origins on each gadget descriptor.
 *   - `connect` — `connect-src` allowlist. Sourced from the
 *     `connect[]` field on each gadget descriptor (plugin's API-call
 *     origins — Stripe API, DoorDash API, Mapbox tile servers, …).
 *
 * Returns `undefined` when no library declares any of the three —
 * the renderer route uses this signal to SKIP attaching the
 * Content-Security-Policy header so existing scenarios (8/16/17/18)
 * that don't declare external origins stay header-clean.
 *
 * The returned origins are deduplicated per bucket and emitted in
 * stable declaration order. Parse failures (malformed URLs) are
 * dropped silently — the wrapper SDK's `strictGadgetDescriptorSchema`
 * already rejects empty strings at registration time, so the only
 * way we'd see bad data here is a hand-authored ggui.json that
 * skipped that validation. Better to render-with-fewer-origins than
 * to throw mid-request.
 */
export function deriveBundleOrigins(
  item: Render,
): { script: readonly string[]; style: readonly string[]; connect: readonly string[] } | undefined {
  // Read from the descriptor sidecar.
  const descriptors =
    'gadgetDescriptors' in item ? item.gadgetDescriptors : undefined;
  if (descriptors === undefined || descriptors.length === 0) return undefined;

  const scriptOrigins: string[] = [];
  const styleOrigins: string[] = [];
  const connectOrigins: string[] = [];
  const seenScript = new Set<string>();
  const seenStyle = new Set<string>();
  const seenConnect = new Set<string>();

  const tryAdd = (
    url: string,
    seen: Set<string>,
    bucket: string[],
  ): void => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    if (seen.has(origin)) return;
    seen.add(origin);
    bucket.push(origin);
  };

  for (const entry of descriptors) {
    // Route both `bundleUrl` (explicit full URL) and `bundleHost`-
    // computed URLs through one resolver. The CSP allowlist always
    // sees the SAME URL the iframe runtime ends up loading, so a
    // bundleHost-only entry's origin lands here too — no silent
    // origin-drop when an operator opts into hostname-mode.
    const resolved = resolveGadgetUrls(entry);
    if (resolved.bundleUrl !== undefined) {
      tryAdd(resolved.bundleUrl, seenScript, scriptOrigins);
    }
    if (resolved.styleUrl !== undefined) {
      tryAdd(resolved.styleUrl, seenStyle, styleOrigins);
    }
    if (Array.isArray(entry.connect)) {
      for (const url of entry.connect) {
        if (typeof url === 'string' && url.length > 0) {
          tryAdd(url, seenConnect, connectOrigins);
        }
      }
    }
  }

  if (
    scriptOrigins.length === 0 &&
    styleOrigins.length === 0 &&
    connectOrigins.length === 0
  ) {
    return undefined;
  }
  return {
    script: scriptOrigins,
    style: styleOrigins,
    connect: connectOrigins,
  };
}

/**
 * Compose a `Content-Security-Policy` header value from
 * {@link deriveBundleOrigins} output. Returns `undefined` when there
 * are no origins to allowlist — the renderer route skips the header
 * attachment in that case so existing zero-external-origin scenarios
 * remain header-clean.
 *
 * The composed policy intentionally pins `'self'` first and union-
 * allowlists the declared external origins. Defaults `'self'` keeps
 * the same-origin iframe-runtime + bootstrap fetches working; the
 * external entries widen each directive only for what the wrappers
 * actually need.
 *
 * # script-src + 'unsafe-inline'
 *
 * The public-render `/r/<shortCode>` shell embeds the bootstrap
 * payload as an inline `<script>__GGUI_META__ = {...}</script>`
 * tag (the fast-path that skips the bootstrap fetch round-trip).
 * Strict `script-src 'self' <origins>` blocks inline scripts, which
 * would break the iframe boot the moment any library declares a
 * `bundleUrl`. We pin `'unsafe-inline'` to keep the inline bootstrap
 * working — the iframe is sandbox-origin and the protection benefit of
 * strict CSP is mostly null inside it. Future hardening: nonce-based
 * scripts (more plumbing — defer until we ship a real surface that
 * benefits from it).
 *
 * # img-src derived from connect[]
 *
 * `connect-src` covers fetch/XHR/WebSocket but NOT `<img src=>` tile
 * loads. Map plugins (Leaflet, Mapbox) load tiles via `<img>` from a
 * tile-server origin that the gadget author already declares under
 * `connect[]` (since some renderers also fetch via XHR). Pragmatic
 * union: any origin that ends up in `connect-src` also lands in
 * `img-src`, so plugin authors don't have to redeclare the same CDN
 * twice. The narrower alternative (separate `images?: readonly
 * string[]` field on `GadgetDescriptor`) costs more API surface for
 * marginal precision.
 *
 * Why this is its own helper instead of inlined: the server route
 * doesn't need to know about CSP directive serialization details;
 * this is the one place that maps the buckets to header syntax.
 */
export function composeContentSecurityPolicy(
  origins: ReturnType<typeof deriveBundleOrigins>,
): string | undefined {
  if (origins === undefined) return undefined;
  const directives: string[] = [];
  if (origins.script.length > 0) {
    directives.push(
      `script-src 'self' 'unsafe-inline' ${origins.script.join(' ')}`,
    );
  }
  if (origins.style.length > 0) {
    directives.push(`style-src 'self' 'unsafe-inline' ${origins.style.join(' ')}`);
  }
  if (origins.connect.length > 0) {
    directives.push(`connect-src 'self' ${origins.connect.join(' ')}`);
    directives.push(`img-src 'self' data: ${origins.connect.join(' ')}`);
  }
  if (directives.length === 0) return undefined;
  return directives.join('; ');
}

/**
 * JSON-stringify the active stack item's `props` field. Returns
 * `undefined` when no props are present or when serialization fails
 * (circular references, non-serializable values). Variant-agnostic —
 * system cards, component items, and any future stack item shape that
 * carries a `props` value all share this projection.
 *
 * Try/catch around `JSON.stringify` is defensive: the upstream push
 * handler validates props against `propsSpec` before they land on the
 * StackItem, so a JSON-circularity here would mean an internal
 * mutation post-validation. Returning `undefined` keeps the renderer
 * on the fallback path instead of failing the whole bootstrap.
 */
export function derivePropsJson(item: Render): string | undefined {
  if (!('props' in item) || item.props === undefined) return undefined;
  try {
    return JSON.stringify(item.props);
  } catch {
    return undefined;
  }
}

/**
 * Wire-shape view of a stack item, surfaced verbatim into every
 * bootstrap transport. Each field corresponds to a top-level entry
 * the iframe-runtime's bootstrap parser reads:
 *
 *   - `kind` — system-card identifier. Mutually exclusive with
 *     `codeUrl` (static-component delivery). 2026-05-13: the raw-ESM
 *     `componentCode` channel was retired; static components are always
 *     delivered via the content-addressable `codeUrl` channel composed
 *     by the push handler from its `codeStore` + `codeBaseUrl` deps.
 *   - `propsJson` — pre-serialized JSON string of the runtime props.
 *   - `actionNextSteps` — per-action tool mapping (Pattern α).
 *   - `contextSlots` — per-slot contextSpec data (one
 *     `React.createContext(default)` per entry).
 *
 * MCP Apps stack items (`item.type === 'mcpApps'`) project to an
 * empty view — those items have their own shell wiring and don't
 * route through this helper.
 */
export interface RenderMetaView {
  readonly kind?: string;
  readonly propsJson?: string;
  readonly actionNextSteps?: Record<string, string>;
  readonly contextSlots?: ReadonlyArray<{
    name: string;
    contextName: string;
    schema: JsonSchema;
    default: JsonValue;
    debounceMs?: number;
  }>;
  /**
   * Permissions-Policy directive list derived from the contract's
   * `clientCapabilities.gadgets[*].permission` field. Each transport
   * emits this into its own envelope:
   *
   *   - Public-render `/r/<shortCode>` → `Permissions-Policy` HTTP
   *     response header on the shell document (browser-enforced gate
   *     for the iframe content).
   *   - MCP Apps host-mounted iframe → `_meta.ui.permissions` on the
   *     ggui_push tool result, which the host translates to an
   *     `allow=""` attribute on the iframe element.
   *   - Inline `__GGUI_META__` global ⇒ `permissionsPolicy` field
   *     on the operator-owned credential payload for in-renderer surface
   *     inspection.
   *
   * Absent ⇒ no permissions requested (default-deny posture).
   */
  readonly permissionsPolicy?: readonly string[];
  /**
   * Content-Security-Policy header value derived from
   * `clientCapabilities.gadgets[*].{bundleUrl, styleUrl, connect[]}`
   * via {@link deriveBundleOrigins} + {@link composeContentSecurityPolicy}
   * (plugin slice Commit 5). Renderer routes attach this verbatim as
   * `Content-Security-Policy` on `/r/<shortCode>` when present.
   *
   * Absent ⇒ no external origins declared by any library; the
   * renderer route omits the header so the host's defaults apply.
   * Scenarios without 3rd-party plugin libs (e.g. 8/16/17/18) stay
   * header-clean — zero CSP attachment, zero regression.
   */
  readonly contentSecurityPolicy?: string;
  /**
   * Operator-registered gadget catalog the iframe-runtime
   * dynamically imports at boot. One entry per registered gadget
   * PACKAGE — `package` is the registry key, `bundleUrl` / `bundleSri`
   * the load source. Projected from the stack item's
   * `gadgetDescriptors` sidecar — the descriptor subset snapshotted
   * from `App.gadgets` at push time.
   *
   * STDLIB exports (`useGeolocation`, `useCamera`, …) are seeded
   * unconditionally by the iframe-runtime — `@ggui-ai/gadgets` need
   * NOT appear in this list. Only operator-registered 3rd-party
   * packages (Leaflet, Mapbox, …) contribute entries.
   *
   * Absent / empty ⇒ no 3rd-party packages needed; the runtime
   * resolves only STDLIB exports.
   */
  readonly gadgets?: ReadonlyArray<{
    readonly package: string;
    readonly bundleUrl?: string;
    /** `sha384-<base64>` subresource-integrity hash. Threaded
     * verbatim from the registered descriptor; iframe-runtime routes
     * the load through a `<link rel="modulepreload" integrity>` gate
     * when present. */
    readonly bundleSri?: string;
  }>;
  // `compiledValidators` removed in #109 — validators are now served
  // via a content-addressable URL surfaced on the stack-item slice
  // (`_meta["ai.ggui/stack-item"].validatorsUrl`). Producers call
  // {@link deriveContractBundle} to compute
  // `{contractHash, bundleSource}`, write `bundleSource` to their
  // `CodeStore` at `contractHash`, then emit
  // `stackItem.contractHash` + `stackItem.validatorsUrl` for the
  // iframe-runtime to fetch.
}

/**
 * Project the App's `publicEnv` down to the union of `requires` keys
 * across the contract's declared wrapper bindings.
 *
 * Minimum-disclosure principle: an iframe only sees the env values
 * that AT LEAST ONE of its declared wrappers asked for. Unused keys
 * never reach the iframe even if the operator configured them on
 * `App.publicEnv`.
 *
 * Reads `item.gadgetDescriptors[*].requires` — the descriptor
 * sidecar. `push.ts` snapshots the descriptor subset from
 * `App.gadgets` at commit time, so this projection sees the resolved
 * `requires` lists without re-resolving against the registry.
 *
 * The push gate (`assertPublicEnvSatisfied`) has already verified
 * every required key is present in `appPublicEnv` by the
 * time this projection runs — so the filter is total (no missing
 * keys); the only filtering this does is dropping App.publicEnv keys
 * no wrapper asked for.
 *
 * Returns `undefined` when:
 *   - The contract has no `clientCapabilities.gadgets`
 *   - No declared wrapper carries `requires` (so no env needed)
 *   - `appPublicEnv` is empty / undefined
 */
export function derivePublicEnvProjection(
  item: Render,
  appPublicEnv: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  // Read from the descriptor sidecar (`requires` is descriptor-side).
  const descriptors =
    'gadgetDescriptors' in item ? item.gadgetDescriptors : undefined;
  if (!descriptors || descriptors.length === 0) return undefined;

  // Gather the union of required keys across declared wrappers.
  const requiredKeys = new Set<string>();
  for (const ref of descriptors) {
    if (!Array.isArray(ref.requires)) continue;
    for (const k of ref.requires) {
      if (typeof k === 'string' && k.length > 0) requiredKeys.add(k);
    }
  }
  if (requiredKeys.size === 0) return undefined;
  if (!appPublicEnv) return undefined;

  // Filter App.publicEnv to just the required subset.
  const filtered: Record<string, string> = {};
  for (const key of requiredKeys) {
    if (Object.prototype.hasOwnProperty.call(appPublicEnv, key)) {
      const value = appPublicEnv[key];
      if (typeof value === 'string') filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

/**
 * Project the stack item's `gadgetDescriptors` sidecar into the
 * bootstrap-emission shape — one entry per registered gadget PACKAGE.
 * `package` is the registry key the iframe-runtime stores the loaded
 * module namespace under; `bundleUrl` / `bundleSri` carry the load
 * source. The iframe loads each package's WHOLE namespace once, so
 * both hook and component exports become reachable — the channel is
 * per-package, not per-export.
 *
 * STDLIB references (`package === '@ggui-ai/gadgets'`, the 7
 * first-party hooks seeded unconditionally) are filtered out — the
 * iframe-runtime pre-loads that package, so emitting it is a no-op.
 *
 * Deduplicated by package name: a descriptor list may carry the same
 * package once (`filterDescriptorsToContract` already dedupes), but
 * the `seen` guard keeps the projection total-by-construction.
 *
 * Returns `undefined` when the contract has no `clientCapabilities`
 * or resolves to only STDLIB packages.
 */
export function deriveGadgetRegistrations(
  item: Render,
): ReadonlyArray<{
  readonly package: string;
  readonly bundleUrl?: string;
  readonly bundleSri?: string;
}> | undefined {
  // Read from the descriptor sidecar.
  const descriptors =
    'gadgetDescriptors' in item ? item.gadgetDescriptors : undefined;
  if (descriptors === undefined) return undefined;
  const collected: Array<{
    readonly package: string;
    readonly bundleUrl?: string;
    readonly bundleSri?: string;
  }> = [];
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    const pkgStr = descriptor.package;
    if (typeof pkgStr !== 'string' || pkgStr.length === 0) continue;
    // STDLIB is pre-loaded by the iframe-runtime; never emit it.
    if (pkgStr === '@ggui-ai/gadgets') continue;
    if (seen.has(pkgStr)) continue;
    seen.add(pkgStr);
    // Resolve bundleUrl from operator override > bundleHost computation >
    // spec default. The iframe runtime sees the FULLY-RESOLVED URL on
    // the bootstrap envelope — no hostname-mode logic on the client.
    const resolved = resolveGadgetUrls(descriptor);
    const bundleStr = resolved.bundleUrl;
    // SRI is only meaningful when paired with a bundleUrl (the
    // `<link rel="modulepreload" integrity>` gate). Drop a stray sri on
    // a package-only descriptor rather than carrying dead metadata into
    // the bootstrap.
    const sriStr =
      typeof descriptor.bundleSri === 'string' &&
      descriptor.bundleSri.length > 0 &&
      bundleStr !== undefined
        ? descriptor.bundleSri
        : undefined;
    collected.push({
      package: pkgStr,
      ...(bundleStr !== undefined ? { bundleUrl: bundleStr } : {}),
      ...(sriStr !== undefined ? { bundleSri: sriStr } : {}),
    });
  }
  return collected.length > 0 ? collected : undefined;
}

/**
 * Content-addressable bundle of precompiled, eval-free validator
 * modules for a stack item's runtime-validated contract specs —
 * `propsSpec` / `actionSpec` / `streamSpec` / `contextSpec`. The bundle
 * is an ES module text whose `default` export is a
 * {@link CompiledContractValidators}; the hash is `sha256` over the
 * canonical-JSON serialization of the input specs (stable across
 * server processes and Ajv version bumps).
 *
 * The push handler writes `bundleSource` to its `CodeStore` at
 * `contractHash`, then emits `contractHash` + `validatorsUrl` on the
 * `_meta["ai.ggui/stack-item"]` slice — the iframe-runtime fetches the
 * URL + dynamic-imports to resolve validators.
 *
 * Delegates to `@ggui-ai/protocol`'s {@link computeContractBundle} —
 * the producer half of the channel, colocated with the four runtime
 * validators so the precompiled module enforces byte-identical
 * semantics.
 *
 * Returns `undefined` for mcpApps / system variants (no contract) and
 * for component items that declare no runtime-validated schema.
 */
export async function deriveContractBundle(
  item: Render,
): Promise<
  | {
      readonly contractHash: string;
      readonly bundleSource: string;
      readonly validators: CompiledContractValidators;
    }
  | undefined
> {
  if (item.type === 'mcpApps' || item.type === 'system') return undefined;
  return computeContractBundle({
    propsSpec: item.propsSpec,
    actionSpec: item.actionSpec,
    streamSpec: item.streamSpec,
    contextSpec: item.contextSpec,
  });
}

/**
 * Build the {@link RenderMetaView} for a stack item — the
 * single-entry-point projection function every bootstrap transport
 * SHOULD call. Composing transports take the view, spread it into
 * their own envelope alongside session/auth/runtime concerns. The
 * static-component code body itself is delivered via the push
 * handler's `codeUrl` channel (composed from `codeStore` + `codeBaseUrl`);
 * this projection only carries the wire-shape metadata.
 *
 * Pure. Same input → identical output, byte-for-byte.
 */
export function deriveRenderMeta(
  item: Render,
): RenderMetaView {
  // MCP Apps items wire through their own shell — no projection here.
  if (item.type === 'mcpApps') return {};

  const propsJson = derivePropsJson(item);

  // System-card variant: emits `kind` + (optional) `propsJson`.
  // Component variant: emits (optional) `propsJson` + (optional)
  // `actionNextSteps` + (optional) `contextSlots` + (optional)
  // `permissionsPolicy`. The compiled code body itself rides on the
  // push handler's `codeUrl` channel (composed at push time from the
  // handler's `codeStore` + `codeBaseUrl` deps) — it is NOT projected
  // here. The actionNextSteps / contextSlots derivations are tolerant
  // of system items (return undefined when actionSpec / contextSpec is
  // absent), so calling them unconditionally is safe — but the
  // structural intent is that those fields belong to the component
  // variant only.
  if (item.type === 'system') {
    return {
      ...(typeof item.kind === 'string' && item.kind.length > 0
        ? { kind: item.kind }
        : {}),
      ...(propsJson !== undefined ? { propsJson } : {}),
    };
  }

  // Component variant.
  const actionNextSteps = deriveWiredActionTools(item);
  const slots = deriveContextSlots(item);
  const permissionsPolicy = derivePermissionsPolicy(item);
  const contentSecurityPolicy = composeContentSecurityPolicy(
    deriveBundleOrigins(item),
  );
  const gadgets = deriveGadgetRegistrations(item);
  return {
    ...(propsJson !== undefined ? { propsJson } : {}),
    ...(actionNextSteps !== undefined ? { actionNextSteps } : {}),
    ...(slots !== undefined ? { contextSlots: [...slots] } : {}),
    ...(permissionsPolicy !== undefined
      ? { permissionsPolicy: [...permissionsPolicy] }
      : {}),
    ...(contentSecurityPolicy !== undefined
      ? { contentSecurityPolicy }
      : {}),
    ...(gadgets !== undefined ? { gadgets } : {}),
  };
}
