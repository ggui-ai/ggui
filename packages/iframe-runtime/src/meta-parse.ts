/**
 * Slice-meta extraction — two thin envelope extractors that funnel
 * into one shared validator + projector.
 *
 * The runtime accepts the single `ai.ggui/render` slice from two
 * envelope shapes, in spec-canonical priority order:
 *
 *   1. `globalThis.__GGUI_META__` — slice envelope inlined
 *      synchronously by `buildSelfContainedShell`. Same slice shape
 *      as the wire `_meta` (just hoisted out of the JSON-RPC frame).
 *      Used by self-contained shells (per-render HTML shells, console
 *      embeds, anywhere a per-render HTML shell can inline JSON
 *      before this bundle loads). Fastest path — no async wait, no
 *      JSON-RPC round-trip.
 *   2. `ui/notifications/tool-result` postMessage — spec-canonical
 *      per MCP-Apps SEP-1865. `params` is a `CallToolResult` per the
 *      spec, so slices live under `params._meta`. We also accept
 *      `params.toolOutput._meta` as a back-compat aliased shape
 *      (some in-house emitters wrap the CallToolResult inside a
 *      `toolOutput` field). Spec-strict hosts (`<AppRenderer>` from
 *      `@mcp-ui/client`, ChatGPT MCP-Apps connector, claude.ai)
 *      deliver slice meta through this channel exclusively.
 *
 * Each extractor reaches the `_meta` object and calls the protocol's
 * {@link parseMcpAppAiGguiRenderMeta} to produce a typed slice.
 * The combiner does STRUCTURAL slice-shape validation; this module's
 * {@link validateMeta} layers in mode-discriminator + expiresAt
 * expiration checks and field-level defensive parsing for the
 * optional containers (`contextSlots`, `gadgets`, `publicEnv`,
 * `permissionsPolicy`, `appCallableTools`, `actionNextSteps`,
 * `streamWebSocketLocalTools`).
 *
 * Reading-B (`result.toolOutput._meta` on the `ui/initialize`
 * response) was retired in Phase 1.19b.3 — the
 * `@modelcontextprotocol/ext-apps` `App` class drives the handshake
 * via `App.connect(transport)` which does not expose `result.toolOutput`
 * to consumers. HostContext is now captured from
 * `app.getHostContext()` (App's spec-canonical `ui/initialize` capture
 * plus the `hostcontextchanged` notification listener) rather than via
 * a sibling field on the parsed envelope.
 *
 * **Three boot modes** (discriminated by which fields are present):
 *
 *   - **live** — slice has `wsUrl` + `wsToken`; runtime opens
 *     live-channel WS and renders agent-driven frames.
 *   - **static-component** — slice has `codeUrl`; runtime fetches
 *     the content-addressable URL, dynamic-imports the React
 *     component, mounts it, never opens WS.
 *   - **system-card** — slice has `kind`; runtime maps to a
 *     built-in component via the system-card registry.
 *
 * At least one mode MUST be present. Half-live (wsUrl without wsToken)
 * is structurally rejected by the combiner.
 */
import { PUBLIC_ENV_APP_KEY_RE } from '@ggui-ai/protocol';
import type {
  McpAppAiGguiRenderMeta,
  McpAppContextSlot,
  McpAppGadgetRef,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { parseMcpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { McpAppAiGguiMetaParseResult } from './types.js';

/**
 * Type guard — true iff `value` is a non-null, non-array plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Type guard — true iff `value` is a non-empty string. Empty strings
 * are rejected because they're equivalent to "field missing"
 * semantically — server-side validation rejects them just as quickly
 * as it rejects an absent field.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Apply field-level defensive parsing to an optional render
 * `contextSlots` array. Malformed entries collapse the whole field to
 * `[]` rather than partially trusting it — a renderer with a corrupted
 * context registry is worse than a renderer with none.
 */
function projectContextSlots(
  raw: unknown,
): ReadonlyArray<McpAppContextSlot> | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const collected: McpAppContextSlot[] = [];
  for (const entry of raw) {
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
    // `default` is required (runtime owns useState per slot; the seed
    // is load-bearing). `in` discrimination so literal `null` passes
    // while truly-missing fails.
    if (!('default' in entry)) return [];
    const slot: McpAppContextSlot = {
      name,
      contextName,
      schema: schema as McpAppContextSlot['schema'],
      default: entry['default'] as McpAppContextSlot['default'],
      ...(debounceMsRaw !== undefined ? { debounceMs: debounceMsRaw } : {}),
    };
    collected.push(slot);
  }
  return collected;
}

/**
 * Apply field-level defensive parsing to the render-slice `gadgets`
 * catalog. Malformed entries collapse the WHOLE field to `undefined` —
 * an unreachable package at boot is better than a half-populated
 * registry with a corrupted entry.
 */
function projectGadgets(
  raw: unknown,
): ReadonlyArray<McpAppGadgetRef> | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const collected: McpAppGadgetRef[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return undefined;
    const pkgRaw = entry['package'];
    if (!isNonEmptyString(pkgRaw)) return undefined;
    const bundleRaw = entry['bundleUrl'];
    const sriRaw = entry['bundleSri'];
    const bundleUrl = isNonEmptyString(bundleRaw) ? bundleRaw : undefined;
    // SRI gate only kicks in when a bundleUrl is present (bare-package
    // import has no SRI surface). Stray SRI on a package-only entry is
    // dropped silently — better than rejecting the whole field for a
    // benign producer mismatch.
    const bundleSri =
      isNonEmptyString(sriRaw) && bundleUrl !== undefined ? sriRaw : undefined;
    collected.push({
      package: pkgRaw,
      ...(bundleUrl !== undefined ? { bundleUrl } : {}),
      ...(bundleSri !== undefined ? { bundleSri } : {}),
    });
  }
  return collected;
}

/**
 * Apply field-level defensive parsing to the render-slice `publicEnv`
 * map. EVERY key MUST match {@link PUBLIC_ENV_APP_KEY_RE}; one bad
 * key (or non-string value, or non-object container) collapses the
 * WHOLE field to `undefined`. Matches the parser posture of
 * `gadgets` / `contextSlots`.
 */
function projectPublicEnv(
  raw: unknown,
): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) return undefined;
  const collected: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!PUBLIC_ENV_APP_KEY_RE.test(key)) return undefined;
    if (typeof value !== 'string') return undefined;
    collected[key] = value;
  }
  // Empty map = wire-equivalent to absent (per #109 splitter posture).
  // Consumers default at their read site.
  if (Object.keys(collected).length === 0) return undefined;
  return collected;
}

/**
 * Apply field-level defensive parsing + business rules to the render
 * slice. Returns a freshly-projected slice, OR a failure reason that
 * the parser surfaces verbatim.
 *
 * Invariants enforced here that the combiner doesn't:
 *   - `expiresAt` (when present) MUST parse to a valid timestamp. If
 *     in the past AND the slice carries static content (codeUrl / kind),
 *     DEGRADE to static-only (drop `wsUrl` / `wsToken` / `expiresAt`);
 *     otherwise return EXPIRED_BOOTSTRAP.
 *   - `gadgets` / `publicEnv` / `appCallableTools` /
 *     `permissionsPolicy` / `streamWebSocketLocalTools` /
 *     `contextSlots` / `actionNextSteps` get defensive entry-level
 *     validation; malformed → defaulted.
 */
function projectMeta(
  meta: McpAppAiGguiRenderMeta,
  hasStaticContent: boolean,
):
  | { ok: true; meta: McpAppAiGguiRenderMeta }
  | { ok: false; reason: 'MALFORMED_BOOTSTRAP' | 'EXPIRED_BOOTSTRAP' } {
  let expiresAt = meta.expiresAt;
  let dropLiveCreds = false;
  if (expiresAt !== undefined) {
    const ts = Date.parse(expiresAt);
    if (Number.isNaN(ts)) {
      return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
    }
    if (ts <= Date.now()) {
      // Expired — only hard-fail when no static content is present.
      // With static content, mount the UI without live mode.
      if (!hasStaticContent) {
        return { ok: false, reason: 'EXPIRED_BOOTSTRAP' };
      }
      dropLiveCreds = true;
      expiresAt = undefined;
    }
  }

  const gadgets = projectGadgets(meta.gadgets);
  const publicEnv = projectPublicEnv(meta.publicEnv);

  const appCallableToolsRaw = meta.appCallableTools;
  const appCallableTools: readonly string[] =
    Array.isArray(appCallableToolsRaw) &&
    appCallableToolsRaw.every((s): s is string => typeof s === 'string')
      ? appCallableToolsRaw
      : [];

  const permissionsPolicyRaw = meta.permissionsPolicy;
  const permissionsPolicy: readonly string[] | undefined =
    Array.isArray(permissionsPolicyRaw) &&
    permissionsPolicyRaw.every(
      (s): s is string => typeof s === 'string' && s.length > 0,
    )
      ? permissionsPolicyRaw
      : undefined;

  const streamRaw = meta.streamWebSocketLocalTools;
  const streamWebSocketLocalTools: readonly string[] | undefined =
    Array.isArray(streamRaw) &&
    streamRaw.length > 0 &&
    streamRaw.every((s): s is string => typeof s === 'string' && s.length > 0)
      ? streamRaw
      : undefined;

  // themeMode is a closed `'light' | 'dark'` enum at the type level;
  // unknown values collapse to undefined (consumers fall back to the
  // host-context default).
  const themeModeRaw = meta.themeMode;
  const themeMode: 'light' | 'dark' | undefined =
    themeModeRaw === 'light' || themeModeRaw === 'dark'
      ? themeModeRaw
      : undefined;

  const actionNextStepsRaw = meta.actionNextSteps;
  let actionNextSteps: Readonly<Record<string, string>> | undefined;
  if (
    isPlainObject(actionNextStepsRaw) &&
    Object.values(actionNextStepsRaw).every(
      (v): v is string => typeof v === 'string',
    )
  ) {
    actionNextSteps = actionNextStepsRaw as Record<string, string>;
  }

  const contextSlots = projectContextSlots(meta.contextSlots);

  const projected: McpAppAiGguiRenderMeta = {
    sessionId: meta.sessionId,
    appId: meta.appId,
    runtimeUrl: meta.runtimeUrl,
    appCallableTools,
    ...(dropLiveCreds
      ? {}
      : {
          ...(meta.wsUrl !== undefined && meta.wsToken !== undefined
            ? { wsUrl: meta.wsUrl, wsToken: meta.wsToken }
            : {}),
        }),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(meta.pollingUrl !== undefined
      ? { pollingUrl: meta.pollingUrl }
      : {}),
    ...(meta.themeId !== undefined ? { themeId: meta.themeId } : {}),
    ...(themeMode !== undefined ? { themeMode } : {}),
    ...(gadgets !== undefined ? { gadgets } : {}),
    ...(publicEnv !== undefined ? { publicEnv } : {}),
    ...(streamWebSocketLocalTools !== undefined
      ? { streamWebSocketLocalTools }
      : {}),
    ...(permissionsPolicy !== undefined ? { permissionsPolicy } : {}),
    ...(meta.lastSequence !== undefined ? { lastSequence: meta.lastSequence } : {}),
    ...(meta.propsJson !== undefined ? { propsJson: meta.propsJson } : {}),
    ...(actionNextSteps !== undefined ? { actionNextSteps } : {}),
    ...(contextSlots !== undefined ? { contextSlots } : {}),
    ...(meta.contractHash !== undefined && meta.validatorsUrl !== undefined
      ? {
          contractHash: meta.contractHash,
          validatorsUrl: meta.validatorsUrl,
        }
      : {}),
    ...(meta.codeUrl !== undefined ? { codeUrl: meta.codeUrl } : {}),
    ...(meta.codeHash !== undefined ? { codeHash: meta.codeHash } : {}),
    ...(meta.kind !== undefined ? { kind: meta.kind } : {}),
  };
  return { ok: true, meta: projected };
}

/**
 * Validate an {@link McpAppAiGguiRenderMeta} slice. Enforces mode
 * discriminator + applies field-level defensive parsing. Returns a
 * discriminated {@link McpAppAiGguiMetaParseResult} the caller
 * surfaces verbatim.
 *
 * Invariants:
 *   - `runtimeUrl` MUST be a non-empty string (re-asserted for
 *     direct-call callers like `parseMetaFromGlobal` / tests; the
 *     envelope-driven extractors already enforce this in the protocol-
 *     level parser).
 *   - At least one of `{live mode (wsUrl+wsToken), codeUrl, kind}` MUST
 *     be present. Without any mode discriminator the iframe has nothing
 *     to mount.
 */
export function validateMeta(
  meta: McpAppAiGguiRenderMeta,
): McpAppAiGguiMetaParseResult {
  // `runtimeUrl` is a hard wire-required field on every render slice
  // (no mode discriminator escapes this — the iframe needs to know
  // where to fetch the runtime bundle to mount anything at all). The
  // protocol-level `parseMcpAppAiGguiRenderMeta` already enforces this
  // for the envelope-driven extractors, but `validateMeta` is also
  // called directly with pre-built slices (tests, `parseMetaFromGlobal`),
  // so we re-assert here.
  if (!isNonEmptyString(meta.runtimeUrl)) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }

  const hasLive =
    isNonEmptyString(meta.wsUrl) && isNonEmptyString(meta.wsToken);
  const hasCodeUrl = isNonEmptyString(meta.codeUrl);
  const hasKind = isNonEmptyString(meta.kind);
  const hasStaticContent = hasCodeUrl || hasKind;

  if (!hasLive && !hasStaticContent) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }

  const result = projectMeta(meta, hasStaticContent);
  if (!result.ok) return result;

  return { ok: true, meta: result.meta };
}

/**
 * Parse the render slice from `globalThis.__GGUI_META__` — the
 * synchronous self-contained shell delivery channel.
 *
 * The global carries the SAME slice envelope shape as the wire `_meta`
 * (`{ "ai.ggui/render": {...} }`), so we can defer to the same
 * combiner.
 *
 * Used by the runtime's autostart resolver as the highest-priority
 * boot source: per-render shells populate this synchronously
 * BEFORE the runtime bundle's `<script type="module">` evaluates,
 * so the runtime can mount without any postMessage round-trip.
 */
export function parseMetaFromGlobal(): McpAppAiGguiMetaParseResult {
  if (typeof globalThis === 'undefined') {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  const raw = (globalThis as unknown as { __GGUI_META__?: unknown })
    .__GGUI_META__;
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  const parsed = parseMcpAppAiGguiRenderMeta(raw);
  if (!parsed.ok) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  if (parsed.meta === undefined) {
    return { ok: false, reason: 'MISSING_META_GGUI_BOOTSTRAP' };
  }
  return validateMeta(parsed.meta);
}

/**
 * Parse the render slice from a `ui/notifications/tool-result`
 * postMessage params payload. Looks at BOTH the spec-canonical
 * location (`params._meta`) and the Reading-B `<McpAppIframe>`
 * convention (`params.toolOutput._meta`) — Claude Desktop / claude.ai
 * Connector use the first; first-party hosts the second.
 *
 * Used by the runtime's autostart resolver as the second / third boot
 * source (drained from the pre-runtime-load buffer or caught by the
 * live message listener).
 */
export function parseMetaFromToolResult(
  params: unknown,
): McpAppAiGguiMetaParseResult {
  if (!isPlainObject(params)) {
    return { ok: false, reason: 'MISSING_TOOL_OUTPUT' };
  }
  let meta: Record<string, unknown> | undefined;
  const topMeta = params['_meta'];
  if (isPlainObject(topMeta)) {
    meta = topMeta;
  } else {
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
  const parsed = parseMcpAppAiGguiRenderMeta(meta);
  if (!parsed.ok) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  if (parsed.meta === undefined) {
    return { ok: false, reason: 'MISSING_META_GGUI_BOOTSTRAP' };
  }
  return validateMeta(parsed.meta);
}
