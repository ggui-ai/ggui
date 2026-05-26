/**
 * Bootstrap-meta extraction — single shared validator + three thin
 * extractors for the three envelope shapes the iframe-runtime accepts.
 *
 * Three boot modes share one {@link McpAppAiGguiMountView} shape, distinguished
 * by which of the three discriminator fields is populated:
 *
 *   - **live** — `wsUrl` + `token` + `runtimeUrl`; runtime opens
 *     live-channel WS and renders agent-driven frames.
 *   - **static-component** — `codeUrl` + `runtimeUrl`; runtime fetches
 *     the content-addressable URL, dynamic-imports the React component,
 *     mounts it, never opens WS.
 *   - **system-card** — `kind` + `runtimeUrl`; runtime maps `kind` to
 *     a built-in component via the system-card registry.
 *
 * Required across every mode: `sessionId`, `appId`, `runtimeUrl`. Mode
 * discriminator: at least one of `{wsUrl-with-token, codeUrl, kind}`
 * MUST be present. Half-live (wsUrl without token, or vice versa) is
 * MALFORMED.
 *
 * **Three envelope shapes the runtime extracts from:**
 *
 *   1. `ui/initialize` response — bootstrap nested under
 *      `result.toolOutput._meta.ggui.bootstrap`. Used by first-party
 *      `<McpAppIframe>` Reading-B hosts (Studio, Portal, console).
 *   2. `globalThis.__GGUI_BOOTSTRAP__` — bootstrap inlined synchronously
 *      by the self-contained shell `buildSelfContainedShell` produces.
 *      Read at module load (later writes are too late).
 *   3. `ui/notifications/tool-result` postMessage — bootstrap nested
 *      under `params._meta.ggui.bootstrap` (spec-compliant) or
 *      `params.toolOutput._meta.ggui.bootstrap` (Reading-B hosts).
 *      Spec-compliant Claude Desktop / claude.ai Connector deliveries.
 *
 * Each extractor unwraps its envelope to the raw bootstrap object,
 * then defers to {@link validateBootstrapMeta} for the shared mode +
 * shape validation. The DRY split is the architectural cure for the
 * "shell-side validator lagged the protocol" bug class — only one
 * place to update when the discriminator semantics evolve.
 *
 * **Defensive shape:** every property access that crosses the trust
 * boundary uses `typeof` + literal-key narrowing rather than optional
 * chaining on cast types. Hosts can (and during fuzz testing, do) send
 * back arrays, primitives, null — all rejected by the same code path.
 */
import type {
  McpAppAiGguiMountView,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { PUBLIC_ENV_APP_KEY_RE, projectHostContext } from '@ggui-ai/protocol';
import {
  combineMcpAppAiGguiMeta,
  mergeSlicesIntoMountView,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { BootstrapParseResult } from './types.js';

/**
 * Type guard — true iff `value` is a non-null, non-array plain object.
 * Used as the gate before every property access in this module.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

/**
 * Type guard — true iff `value` is a non-empty string.
 *
 * Empty strings are rejected because they're equivalent to "field
 * missing" semantically — a bootstrap with `appId: ''` will fail
 * server-side validation just as quickly as one with the field absent.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Shared validator core. Accepts an unwrapped bootstrap object (NOT
 * the full `_meta.ggui.bootstrap` envelope — the caller has already
 * stripped envelopes down to this layer).
 *
 * Validates the three-mode discriminator + the optional fields per
 * the {@link McpAppAiGguiMountView} contract. Returns a discriminated
 * {@link BootstrapParseResult} the caller surfaces verbatim.
 *
 * Invariants enforced here (see module docblock for the wire contract):
 *   - `runtimeUrl` MUST be a non-empty string. All three modes need
 *     it because the shell dynamic-script-loads the runtime bundle
 *     from this URL.
 *   - `sessionId` + `appId` MUST be non-empty strings.
 *   - At least one of `{wsUrl-with-token, codeUrl, kind}` MUST be
 *     present as a non-empty string. Half-live (wsUrl without token)
 *     is MALFORMED.
 *   - `expiresAt`, when present + relevant (live mode), MUST parse
 *     to a future timestamp.
 */
export function validateBootstrapMeta(
  raw: unknown,
): BootstrapParseResult {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }

  const sessionId = raw['sessionId'];
  const appId = raw['appId'];
  const runtimeUrl = raw['runtimeUrl'];
  if (
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(appId) ||
    !isNonEmptyString(runtimeUrl)
  ) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }

  // Mode discriminator. Live mode requires wsUrl AND token together;
  // half-live (one without the other) is MALFORMED. Static-component
  // mode keys off `codeUrl` (the content-addressable URL channel; the
  // inline base64 `componentCode` channel was retired in T3-1, 2026-05-13).
  // System-card mode keys off `kind`. Reject any system+code mix as a
  // malformed wire envelope — we don't guess which branch the producer
  // intended.
  const wsUrlRaw = raw['wsUrl'];
  const tokenRaw = raw['token'];
  const codeUrlRawForDisc = raw['codeUrl'];
  const kindRaw = raw['kind'];
  const hasWsUrl = isNonEmptyString(wsUrlRaw);
  const hasToken = isNonEmptyString(tokenRaw);
  const hasCodeUrl = isNonEmptyString(codeUrlRawForDisc);
  const hasKind = isNonEmptyString(kindRaw);
  if (hasWsUrl !== hasToken) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  if (!hasWsUrl && !hasCodeUrl && !hasKind) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  // System-card mode is mutually exclusive with codeUrl.
  if (hasKind && hasCodeUrl) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }

  // expiresAt validation + auth-degraded fallback. When absent we
  // synthesize the unbounded sentinel so downstream consumers don't
  // have to special-case `undefined`.
  //
  // Auth-degraded fallback: `expiresAt` gates the live-mode
  // `wsUrl`/`token` pair only — `bootSelfContained` mounts the static
  // UI from `codeUrl`/`kind` + `propsJson` and never reads the auth
  // fields. So when the token has expired but static renderable
  // content is present (e.g., chat-history rehydrate after the 2-min
  // bootstrap-token TTL), DEGRADE to static-only mode — drop
  // `wsUrl`/`token`/`expiresAt`, keep everything else. The runtime
  // mounts the card from the inline view; live updates (WS
  // subscriptions, server-pushed streams) silently no-op until a fresh
  // push refreshes the bootstrap. Without this fallback, rehydrate
  // produces a hard `MISSING_TOOL_OUTPUT` instead of a visible static
  // UI.
  const expiresRaw = raw['expiresAt'];
  let expiresAt: string | undefined;
  let authDegraded = false;
  if (expiresRaw === undefined) {
    expiresAt = '9999-12-31T23:59:59.999Z';
  } else {
    if (!isNonEmptyString(expiresRaw)) {
      return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
    }
    const ts = Date.parse(expiresRaw);
    if (Number.isNaN(ts)) {
      return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
    }
    if (ts <= Date.now()) {
      // Expired — only fail when no static content is present. With
      // static content (codeUrl / system kind), we can still mount the
      // UI; we just lose live mode.
      if (!hasCodeUrl && !hasKind) {
        return { ok: false, reason: 'EXPIRED_BOOTSTRAP' };
      }
      authDegraded = true;
      expiresAt = undefined;
    } else {
      expiresAt = expiresRaw;
    }
  }

  // Optional shape-preserving fields. Each block keeps the same
  // posture as the original parseBootstrap: malformed shapes default
  // to absent / empty rather than failing the whole parse. Producers
  // MAY add new optional fields without forcing a parser bump; older
  // renderers legitimately render as if the new field were absent.
  const stackItemIdRaw = raw['stackItemId'];
  const stackItemId =
    typeof stackItemIdRaw === 'string' && stackItemIdRaw.length > 0
      ? stackItemIdRaw
      : undefined;

  const themeIdRaw = raw['themeId'];
  const themeId =
    typeof themeIdRaw === 'string' && themeIdRaw.length > 0
      ? themeIdRaw
      : undefined;

  const themeModeRaw = raw['themeMode'];
  const themeMode: 'light' | 'dark' | undefined =
    themeModeRaw === 'dark' || themeModeRaw === 'light'
      ? themeModeRaw
      : undefined;

  const propsJsonRaw = raw['propsJson'];
  const propsJson =
    typeof propsJsonRaw === 'string' ? propsJsonRaw : undefined;

  const codeUrl = hasCodeUrl ? (codeUrlRawForDisc as string) : undefined;

  const codeHashRaw = raw['codeHash'];
  const codeHash =
    typeof codeHashRaw === 'string' && codeHashRaw.length > 0
      ? codeHashRaw
      : undefined;

  // canvasMode — discriminator for the canvas-mount path in
  // `runtime.ts` (consumed at the `parsed.bootstrap.canvasMode === true`
  // gate). Mutually exclusive with stackItemId per the
  // `McpAppAiGguiMountView` contract; the validator does not enforce the
  // exclusion here because (a) producers already gate it
  // server-side, and (b) the consumer branches on canvasMode FIRST so
  // a stray stackItemId is harmless. Defensive parse: strictly boolean
  // true ⇒ true; everything else ⇒ undefined (matches the runtime's
  // `=== true` check exactly).
  const canvasModeRaw = raw['canvasMode'];
  const canvasMode: true | undefined =
    canvasModeRaw === true ? true : undefined;

  // appCallableTools — shape-preserving: legacy / malformed shapes
  // default to `[]`.
  const appCallableToolsRaw = raw['appCallableTools'];
  const appCallableTools: readonly string[] =
    Array.isArray(appCallableToolsRaw) &&
    appCallableToolsRaw.every((s): s is string => typeof s === 'string')
      ? appCallableToolsRaw
      : [];

  // actionNextSteps — defaults to `{}` on absent / malformed shapes.
  const actionNextStepsRaw = raw['actionNextSteps'];
  let actionNextSteps: Readonly<Record<string, string>> = {};
  if (
    isPlainObject(actionNextStepsRaw) &&
    Object.values(actionNextStepsRaw).every(
      (v): v is string => typeof v === 'string',
    )
  ) {
    actionNextSteps = actionNextStepsRaw as Record<string, string>;
  }

  // contextSlots — per-slot data the runtime turns into one
  // `React.createContext(default)` each at boot. Optional on the wire;
  // legacy bootstraps without the field default to `[]`. Each entry
  // MUST have non-empty `name`/`contextName` strings + an object
  // `schema` + a present `default`. Malformed entries cause the WHOLE
  // field to default to `[]` rather than partially trusting it.
  const contextSlotsRaw = raw['contextSlots'];
  type ContextSlot = NonNullable<McpAppAiGguiMountView['contextSlots']>[number];
  const contextSlots: ReadonlyArray<ContextSlot> = (() => {
    if (!Array.isArray(contextSlotsRaw)) return [];
    const collected: ContextSlot[] = [];
    for (const entry of contextSlotsRaw) {
      if (!isPlainObject(entry)) return [];
      const name = entry['name'];
      const contextName = entry['contextName'];
      const schema = entry['schema'];
      if (!isNonEmptyString(name)) return [];
      if (!isNonEmptyString(contextName)) return [];
      if (!isPlainObject(schema)) return [];
      const debounceMsRaw = entry['debounceMs'];
      if (debounceMsRaw !== undefined && typeof debounceMsRaw !== 'number') {
        return [];
      }
      // `default` is required (the runtime owns useState per slot,
      // so the seed is load-bearing). Discriminate via `in` so a
      // literal `null` passes while truly-missing fails.
      if (!('default' in entry)) return [];
      const slot: ContextSlot = {
        name,
        contextName,
        schema: schema as ContextSlot['schema'],
        default: entry['default'] as ContextSlot['default'],
        ...(debounceMsRaw !== undefined ? { debounceMs: debounceMsRaw } : {}),
      };
      collected.push(slot);
    }
    return collected;
  })();

  // `permissionsPolicy` — Permissions-Policy directive list
  // mirrored from the active stack item's
  // `clientCapabilities.gadgets[*].permission`. Defensive parse:
  // malformed payload defaults to undefined rather than failing the
  // whole bootstrap (informational field). Browser-enforced gates
  // come from the HTTP `Permissions-Policy` header (public-render
  // path) or iframe `allow=""` attribute (MCP-Apps host path) — the
  // iframe-runtime surfaces this list for in-iframe inspection only.
  const permissionsPolicyRaw = raw['permissionsPolicy'];
  let permissionsPolicy: readonly string[] | undefined;
  if (
    Array.isArray(permissionsPolicyRaw) &&
    permissionsPolicyRaw.every(
      (s): s is string => typeof s === 'string' && s.length > 0,
    )
  ) {
    permissionsPolicy = permissionsPolicyRaw;
  }

  // `publicEnv` — operator-stamped public values the
  // iframe-runtime installs at `globalThis.__ggui__.publicEnv` for
  // wrapper hooks to read via `getPublicEnv(key)`. Defensive parse:
  // EVERY key MUST match `PUBLIC_ENV_APP_KEY_RE`; one bad key (or
  // a non-string value, or the field itself being non-object)
  // collapses the WHOLE field to undefined. Matches the parser
  // posture of `gadgets` / `contextSlots`.
  const publicEnvRaw = raw['publicEnv'];
  const publicEnv: Readonly<Record<string, string>> | undefined = (() => {
    if (publicEnvRaw === undefined) return undefined;
    if (!isPlainObject(publicEnvRaw)) return undefined;
    const collected: Record<string, string> = {};
    for (const [key, value] of Object.entries(publicEnvRaw)) {
      if (!PUBLIC_ENV_APP_KEY_RE.test(key)) return undefined;
      if (typeof value !== 'string') return undefined;
      collected[key] = value;
    }
    return collected;
  })();

  // `gadgets` — resolved gadget-package catalog the iframe-runtime
  // dynamically imports at boot to populate
  // `globalThis.__ggui__.gadgets`. One entry per registered package
  // (GG.8.2 — per-package, not per-hook). Defensive parse: malformed
  // entries cause the WHOLE field to default to undefined rather than
  // partially trusting it (an unreachable package at boot is better
  // than a half-populated registry with a corrupted entry).
  const gadgetsRaw = raw['gadgets'];
  type GadgetPackageEntry = NonNullable<
    McpAppAiGguiMountView['gadgets']
  >[number];
  const gadgets: ReadonlyArray<GadgetPackageEntry> | undefined = (() => {
    if (gadgetsRaw === undefined) return undefined;
    if (!Array.isArray(gadgetsRaw)) return undefined;
    const collected: GadgetPackageEntry[] = [];
    for (const entry of gadgetsRaw) {
      if (!isPlainObject(entry)) return undefined;
      // `package` is the registry key the runtime stores the loaded
      // namespace under — REQUIRED. A missing package makes the entry
      // unkeyable; reject the whole field.
      const pkgRaw = entry['package'];
      if (!isNonEmptyString(pkgRaw)) return undefined;
      const bundleRaw = entry['bundleUrl'];
      const sriRaw = entry['bundleSri'];
      const bundleUrl = isNonEmptyString(bundleRaw) ? bundleRaw : undefined;
      // The SRI gate only kicks in when a bundleUrl is present (bare
      // `package` import has no SRI surface). A stray SRI on a
      // package-only entry is dropped silently — better than rejecting
      // the whole field for a benign producer mismatch.
      const bundleSri =
        isNonEmptyString(sriRaw) && bundleUrl !== undefined
          ? sriRaw
          : undefined;
      collected.push({
        package: pkgRaw,
        ...(bundleUrl !== undefined ? { bundleUrl } : {}),
        ...(bundleSri !== undefined ? { bundleSri } : {}),
      });
    }
    return collected;
  })();

  // `contractHash` + `validatorsUrl` — content-addressable pointer to
  // the compiled contract validators. The renderer iframe's strict
  // CSP blocks runtime `ajv.compile()`, so the server compiles +
  // bundles validators at push time and serves them under a
  // sha256-keyed immutable URL. The iframe fetches the URL +
  // dynamic-imports to resolve validators. Defensive parse: malformed
  // payload (one field set without the other, empty strings, wrong
  // type) collapses BOTH fields to undefined; degrades to no
  // client-side validation (server-side `assertActionContract` stays
  // authoritative).
  const contractHashRaw = raw['contractHash'];
  const validatorsUrlRaw = raw['validatorsUrl'];
  const contractHash =
    isNonEmptyString(contractHashRaw) && isNonEmptyString(validatorsUrlRaw)
      ? contractHashRaw
      : undefined;
  const validatorsUrl =
    isNonEmptyString(contractHashRaw) && isNonEmptyString(validatorsUrlRaw)
      ? validatorsUrlRaw
      : undefined;

  // `streamWebSocketLocalTools` — mirror of the handshake's
  // `serverCapabilities.streamWebSocketLocalTools` so the
  // channel-transport router can decide WS-subscribe vs iframe-polling
  // per channel without re-querying the handshake. Defensive parse:
  // malformed payload defaults to undefined (universal iframe-poll).
  // An empty array is a meaningful value ("server supports the field,
  // no tool is local") and preserved verbatim.
  const streamWebSocketLocalToolsRaw = raw['streamWebSocketLocalTools'];
  let streamWebSocketLocalTools: readonly string[] | undefined;
  if (
    Array.isArray(streamWebSocketLocalToolsRaw) &&
    streamWebSocketLocalToolsRaw.every(
      (s): s is string => typeof s === 'string' && s.length > 0,
    )
  ) {
    streamWebSocketLocalTools = streamWebSocketLocalToolsRaw;
  }

  // When auth is degraded (expired token + static content), drop the
  // live-mode fields so downstream readers (e.g. `readGguiBootstrap-
  // MetaShape`) don't shortcut into `runBootProduction`. The static
  // mount path in `bootSelfContained` doesn't need them.
  const result: McpAppAiGguiMountView = {
    sessionId,
    appId,
    runtimeUrl,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    appCallableTools,
    actionNextSteps,
    contextSlots,
    ...(hasWsUrl && hasToken && !authDegraded
      ? { wsUrl: wsUrlRaw as string, token: tokenRaw as string }
      : {}),
    ...(hasKind ? { kind: kindRaw as string } : {}),
    ...(stackItemId !== undefined ? { stackItemId } : {}),
    ...(themeId !== undefined ? { themeId } : {}),
    ...(themeMode !== undefined ? { themeMode } : {}),
    ...(propsJson !== undefined ? { propsJson } : {}),
    ...(codeUrl !== undefined ? { codeUrl } : {}),
    ...(codeHash !== undefined ? { codeHash } : {}),
    ...(permissionsPolicy !== undefined ? { permissionsPolicy } : {}),
    ...(streamWebSocketLocalTools !== undefined
      ? { streamWebSocketLocalTools }
      : {}),
    ...(gadgets !== undefined ? { gadgets } : {}),
    ...(publicEnv !== undefined ? { publicEnv } : {}),
    ...(canvasMode !== undefined ? { canvasMode } : {}),
    ...(contractHash !== undefined && validatorsUrl !== undefined
      ? { contractHash, validatorsUrl }
      : {}),
  };

  return { ok: true, bootstrap: result };
}

/**
 * Parse a bootstrap from a `ui/initialize` postMessage response. The
 * argument is the JSON-RPC `result` field — typically
 * `{ toolOutput: { _meta: { "ai.ggui/bootstrap": {...} }, structuredContent: ... } }`.
 *
 * Used by the runtime's legacy `bootProduction` path (live-mode WS
 * subscription). Spec-canonical for first-party `<McpAppIframe>`
 * Reading-B hosts (Studio, Portal, console).
 */
export function parseBootstrapFromUiInitialize(
  uiInitializeResult: unknown,
): BootstrapParseResult {
  if (!isPlainObject(uiInitializeResult)) {
    return { ok: false, reason: 'MISSING_TOOL_OUTPUT' };
  }
  const toolOutput = uiInitializeResult['toolOutput'];
  if (!isPlainObject(toolOutput)) {
    return { ok: false, reason: 'MISSING_TOOL_OUTPUT' };
  }
  const meta = toolOutput['_meta'];
  if (!isPlainObject(meta)) {
    return { ok: false, reason: 'MISSING_META_GGUI_BOOTSTRAP' };
  }
  // #109 — combine the two per-window `_meta` keys
  // (`ai.ggui/session` / `ai.ggui/stack-item`) into slices, then merge
  // into the flat MountView the iframe consumes. Map failure modes:
  //   - combiner MALFORMED_* → MALFORMED_BOOTSTRAP
  //   - merge MISSING_SESSION → MISSING_META_GGUI_BOOTSTRAP
  //   - validateMountView surfaces field-level reasons
  const combined = combineMcpAppAiGguiMeta(meta);
  if (!combined.ok) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  const merged = mergeSlicesIntoMountView(combined.slices);
  if (!merged.ok) {
    return { ok: false, reason: 'MISSING_META_GGUI_BOOTSTRAP' };
  }
  const validated = validateBootstrapMeta(merged.view);
  if (!validated.ok) return validated;

  // opportunistically capture HostContext from
  // the sibling `result.hostContext` field. Per the MCP Apps spec
  // (`McpUiInitializeResult.hostContext`), this carries
  // availableDisplayModes / containerDimensions / platform /
  // deviceCapabilities — the data canvas-mode display-mode
  // escalation and the agent (via handshake/consume echo) rely on.
  //
  // Best-effort: a malformed or absent HostContext never affects the
  // bootstrap parse. `projectHostContext` returns undefined for
  // non-object input and an empty projection for "object but no
  // recognized fields" — both are passed through as-is.
  const hostContext = projectHostContext(uiInitializeResult['hostContext']);
  return hostContext !== undefined
    ? { ok: true, bootstrap: validated.bootstrap, hostContext }
    : validated;
}

/**
 * Back-compat alias for {@link parseBootstrapFromUiInitialize}.
 *
 * `parseBootstrap` was the original name when the iframe-runtime
 * accepted only the ui/initialize envelope. The parser was later
 * generalized to three envelope shapes (ui/initialize,
 * `__GGUI_BOOTSTRAP__` global, postMessage tool-result), each with its
 * own thin extractor; the shared {@link validateBootstrapMeta} core
 * does the per-envelope shape validation. The original function name
 * is kept exported so downstream consumers (`@ggui-ai/react`, runtime
 * call sites) don't need a sweep — the name still resolves to the
 * same behavior.
 */
export const parseBootstrap = parseBootstrapFromUiInitialize;

/**
 * Parse a bootstrap from `globalThis.__GGUI_BOOTSTRAP__` — the
 * synchronous self-contained shell delivery channel. Returns
 * `MALFORMED_BOOTSTRAP` when the global is absent OR not an object;
 * the caller falls through to a postMessage path on either signal.
 *
 * Used by the runtime's autostart resolver as the highest-priority
 * boot source: per-session shells (`/r/<shortCode>`,
 * `ui://ggui/session/<sessionId>`) populate this synchronously
 * BEFORE the runtime bundle's `<script type="module">` evaluates,
 * so the runtime can mount without any postMessage round-trip.
 */
export function parseBootstrapFromGlobal(): BootstrapParseResult {
  if (typeof globalThis === 'undefined') {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  const raw = (globalThis as unknown as { __GGUI_BOOTSTRAP__?: unknown })
    .__GGUI_BOOTSTRAP__;
  return validateBootstrapMeta(raw);
}

/**
 * Parse a bootstrap from a `ui/notifications/tool-result` postMessage
 * params payload. Looks at BOTH the spec-canonical location
 * (`params._meta.ggui.bootstrap`) and the Reading-B `<McpAppIframe>`
 * convention (`params.toolOutput._meta.ggui.bootstrap`) — Claude
 * Desktop / claude.ai Connector use the first; first-party hosts the
 * second.
 *
 * Used by the runtime's autostart resolver as the second / third
 * boot source (drained from the pre-runtime-load buffer or caught by
 * the live message listener).
 */
export function parseBootstrapFromToolResult(
  params: unknown,
): BootstrapParseResult {
  if (!isPlainObject(params)) {
    return { ok: false, reason: 'MISSING_TOOL_OUTPUT' };
  }
  // Spec-canonical: params IS the CallToolResult; _meta is at the top.
  let meta: Record<string, unknown> | undefined;
  const topMeta = params['_meta'];
  if (isPlainObject(topMeta)) {
    meta = topMeta;
  } else {
    // Reading-B: bootstrap nested under params.toolOutput._meta.
    const toolOutput = params['toolOutput'];
    if (isPlainObject(toolOutput)) {
      const nestedMeta = toolOutput['_meta'];
      if (isPlainObject(nestedMeta)) {
        meta = nestedMeta;
      }
    }
  }
  if (meta === undefined) {
    return { ok: false, reason: 'MISSING_META_GGUI_BOOTSTRAP' };
  }
  // #109 — combine the two per-window `_meta` keys, merge into view,
  // then validate. Same MISSING/MALFORMED mapping as
  // parseBootstrapFromUiInitialize.
  const combined = combineMcpAppAiGguiMeta(meta);
  if (!combined.ok) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  const merged = mergeSlicesIntoMountView(combined.slices);
  if (!merged.ok) {
    return { ok: false, reason: 'MISSING_META_GGUI_BOOTSTRAP' };
  }
  return validateBootstrapMeta(merged.view);
}
