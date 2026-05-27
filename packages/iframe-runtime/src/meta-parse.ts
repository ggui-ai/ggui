/**
 * Slice-meta extraction — three thin envelope extractors that all
 * funnel into one shared validator + projector.
 *
 * The runtime accepts slices from three envelope shapes, in
 * spec-canonical priority order:
 *
 *   1. `ui/notifications/tool-result` postMessage — spec-canonical
 *      per MCP-Apps SEP-1865. `params` is a `CallToolResult` per the
 *      spec, so slices live under `params._meta`. We also accept
 *      `params.toolOutput._meta` as a Reading-B back-compat aliased
 *      shape (some in-house emitters wrap the CallToolResult inside
 *      a `toolOutput` field). Spec-strict hosts (`<AppRenderer>`
 *      from `@mcp-ui/client`, ChatGPT MCP-Apps connector, claude.ai)
 *      deliver slice meta ONLY through this channel — they do NOT
 *      echo `toolOutput` on `ui/initialize.result`.
 *   2. `globalThis.__GGUI_META__` — slice envelope inlined
 *      synchronously by `buildSelfContainedShell`. Same slice shape
 *      as the wire `_meta` (just hoisted out of the JSON-RPC frame).
 *      Used by self-contained shells (`/r/` shells pre-R5, console
 *      embeds, anywhere a per-session HTML shell can inline JSON
 *      before this bundle loads). Fastest path — no async wait, no
 *      JSON-RPC round-trip.
 *   3. `ui/initialize` response Reading-B — slices under
 *      `result.toolOutput._meta["ai.ggui/session"]` /
 *      `_meta["ai.ggui/stack-item"]`. This is an OUR-CONVENTION
 *      echo on top of `McpUiInitializeResult` — the MCP-Apps spec
 *      `McpUiInitializeResult` type defines only
 *      `{protocolVersion, hostInfo, hostCapabilities, hostContext}`
 *      and does NOT carry `toolOutput`. Kept here for back-compat
 *      with `<McpAppIframe>` (RN; web copy deleted in spec-mig P2)
 *      + claude.ai's bonus echo.
 *
 * Each extractor reaches the `_meta` object and calls the protocol's
 * {@link parseMcpAppAiGguiMeta} to partition into
 * {@link McpAppAiGguiMeta} (`session` + `stackItem`). The combiner
 * does STRUCTURAL slice-shape validation; this module's
 * {@link validateSlices} layers in cross-slice business rules
 * (mode discriminator, expiresAt expiration, stackItemId
 * mutual exclusion) and field-level defensive parsing for the
 * optional containers (`contextSlots`, `gadgets`, `publicEnv`,
 * `permissionsPolicy`, `appCallableTools`, `actionNextSteps`,
 * `streamWebSocketLocalTools`).
 *
 * **Three boot modes** (discriminated across slices):
 *
 *   - **live** — session has `wsUrl` + `token`; runtime opens
 *     live-channel WS and renders agent-driven frames.
 *   - **static-component** — stack-item has `codeUrl`; runtime fetches
 *     the content-addressable URL, dynamic-imports the React
 *     component, mounts it, never opens WS.
 *   - **system-card** — stack-item has `kind`; runtime maps to a
 *     built-in component via the system-card registry.
 *
 * At least one mode MUST be present. Half-live (wsUrl without token)
 * is structurally rejected by the combiner.
 */
import { PUBLIC_ENV_APP_KEY_RE, projectHostContext } from '@ggui-ai/protocol';
import type {
  McpAppAiGguiMeta,
  McpAppAiGguiSessionMeta,
  McpAppAiGguiStackItemMeta,
  McpAppContextSlot,
  McpAppGadgetRef,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { parseMcpAppAiGguiMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
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
 * Apply field-level defensive parsing to an optional stack-item
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
 * Apply field-level defensive parsing to the session-slice `gadgets`
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
 * Apply field-level defensive parsing to the session-slice `publicEnv`
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
 * Apply field-level defensive parsing + business rules to the session
 * slice. Returns a freshly-projected session, OR a failure reason that
 * the parser surfaces verbatim.
 *
 * Invariants enforced here that the combiner doesn't:
 *   - `expiresAt` (when present) MUST parse to a valid timestamp. If
 *     in the past AND the active stack-item carries static content
 *     (codeUrl / kind), DEGRADE to static-only (drop `wsUrl` / `token`
 *     / `expiresAt`); otherwise return EXPIRED_BOOTSTRAP.
 *   - `gadgets` / `publicEnv` / `appCallableTools` /
 *     `permissionsPolicy` / `streamWebSocketLocalTools` get
 *     defensive entry-level validation; malformed → defaulted.
 */
function projectSession(
  session: McpAppAiGguiSessionMeta,
  hasStaticContent: boolean,
):
  | { ok: true; session: McpAppAiGguiSessionMeta }
  | { ok: false; reason: 'MALFORMED_BOOTSTRAP' | 'EXPIRED_BOOTSTRAP' } {
  let expiresAt = session.expiresAt;
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

  const gadgets = projectGadgets(session.gadgets);
  const publicEnv = projectPublicEnv(session.publicEnv);

  const appCallableToolsRaw = session.appCallableTools;
  const appCallableTools: readonly string[] =
    Array.isArray(appCallableToolsRaw) &&
    appCallableToolsRaw.every((s): s is string => typeof s === 'string')
      ? appCallableToolsRaw
      : [];

  const permissionsPolicyRaw = session.permissionsPolicy;
  const permissionsPolicy: readonly string[] | undefined =
    Array.isArray(permissionsPolicyRaw) &&
    permissionsPolicyRaw.every(
      (s): s is string => typeof s === 'string' && s.length > 0,
    )
      ? permissionsPolicyRaw
      : undefined;

  const streamRaw = session.streamWebSocketLocalTools;
  const streamWebSocketLocalTools: readonly string[] | undefined =
    Array.isArray(streamRaw) &&
    streamRaw.length > 0 &&
    streamRaw.every((s): s is string => typeof s === 'string' && s.length > 0)
      ? streamRaw
      : undefined;

  // themeMode is a closed `'light' | 'dark'` enum at the type level;
  // unknown values collapse to undefined (consumers fall back to the
  // host-context default).
  const themeModeRaw = session.themeMode;
  const themeMode: 'light' | 'dark' | undefined =
    themeModeRaw === 'light' || themeModeRaw === 'dark'
      ? themeModeRaw
      : undefined;

  const projected: McpAppAiGguiSessionMeta = {
    sessionId: session.sessionId,
    appId: session.appId,
    runtimeUrl: session.runtimeUrl,
    appCallableTools,
    ...(dropLiveCreds
      ? {}
      : {
          ...(session.wsUrl !== undefined && session.wsToken !== undefined
            ? { wsUrl: session.wsUrl, wsToken: session.wsToken }
            : {}),
        }),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(session.pollingUrl !== undefined
      ? { pollingUrl: session.pollingUrl }
      : {}),
    ...(session.themeId !== undefined ? { themeId: session.themeId } : {}),
    ...(themeMode !== undefined ? { themeMode } : {}),
    ...(gadgets !== undefined ? { gadgets } : {}),
    ...(publicEnv !== undefined ? { publicEnv } : {}),
    ...(streamWebSocketLocalTools !== undefined
      ? { streamWebSocketLocalTools }
      : {}),
    ...(permissionsPolicy !== undefined ? { permissionsPolicy } : {}),
  };
  return { ok: true, session: projected };
}

/**
 * Apply field-level defensive parsing to the stack-item slice.
 * `actionNextSteps` defaults to `{}`, `contextSlots` to `[]`.
 */
function projectStackItem(
  stackItem: McpAppAiGguiStackItemMeta,
): McpAppAiGguiStackItemMeta {
  const actionNextStepsRaw = stackItem.actionNextSteps;
  let actionNextSteps: Readonly<Record<string, string>> = {};
  if (
    isPlainObject(actionNextStepsRaw) &&
    Object.values(actionNextStepsRaw).every(
      (v): v is string => typeof v === 'string',
    )
  ) {
    actionNextSteps = actionNextStepsRaw as Record<string, string>;
  }

  const contextSlots = projectContextSlots(stackItem.contextSlots) ?? [];

  return {
    ...(stackItem.stackItemId !== undefined
      ? { stackItemId: stackItem.stackItemId }
      : {}),
    ...(stackItem.propsJson !== undefined
      ? { propsJson: stackItem.propsJson }
      : {}),
    actionNextSteps,
    contextSlots,
    ...(stackItem.codeUrl !== undefined ? { codeUrl: stackItem.codeUrl } : {}),
    ...(stackItem.codeHash !== undefined
      ? { codeHash: stackItem.codeHash }
      : {}),
    ...(stackItem.kind !== undefined ? { kind: stackItem.kind } : {}),
    ...(stackItem.contractHash !== undefined &&
    stackItem.validatorsUrl !== undefined
      ? {
          contractHash: stackItem.contractHash,
          validatorsUrl: stackItem.validatorsUrl,
        }
      : {}),
  };
}

/**
 * Validate the {@link McpAppAiGguiMeta} pair coming out of the
 * combiner. Enforces cross-slice business rules + applies field-level
 * defensive parsing. Returns a discriminated
 * {@link McpAppAiGguiMetaParseResult} the caller surfaces verbatim.
 *
 * Cross-slice invariants:
 *   - `session` MUST be present (no session = nothing to mount).
 *   - At least one of `{live mode (session.wsUrl+wsToken),
 *     stack-item codeUrl, stack-item kind}` MUST be present.
 *   - If session has neither live nor stack-item has static content,
 *     the envelope is unmountable.
 */
export function validateMeta(
  meta: McpAppAiGguiMeta,
): McpAppAiGguiMetaParseResult {
  const { session, stackItem } = meta;

  if (!session) {
    return { ok: false, reason: 'MISSING_META_GGUI_BOOTSTRAP' };
  }

  // `runtimeUrl` is a hard wire-required field on every session slice
  // (no mode discriminator escapes this — the iframe needs to know
  // where to fetch the runtime bundle to mount anything at all). The
  // protocol-level `parseMcpAppAiGguiMeta` already enforces this for
  // the envelope-driven extractors, but `validateMeta` is also called
  // directly with pre-built slices (tests, `parseMetaFromGlobal`),
  // so we re-assert here.
  if (!isNonEmptyString(session.runtimeUrl)) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }

  const hasLive =
    isNonEmptyString(session.wsUrl) && isNonEmptyString(session.wsToken);
  const hasCodeUrl =
    stackItem !== undefined && isNonEmptyString(stackItem.codeUrl);
  const hasKind = stackItem !== undefined && isNonEmptyString(stackItem.kind);
  const hasStaticContent = hasCodeUrl || hasKind;

  if (!hasLive && !hasStaticContent) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }

  const sessionResult = projectSession(session, hasStaticContent);
  if (!sessionResult.ok) return sessionResult;

  const projectedStackItem =
    stackItem !== undefined ? projectStackItem(stackItem) : undefined;

  return {
    ok: true,
    meta: {
      session: sessionResult.session,
      ...(projectedStackItem !== undefined
        ? { stackItem: projectedStackItem }
        : {}),
    } as const,
  };
}

/**
 * Parse slices from a `ui/initialize` postMessage response — the
 * "Reading-B" extractor, an OUR-CONVENTION shape on top of
 * `McpUiInitializeResult`.
 *
 * The argument is the JSON-RPC `result` field — typically
 * `{ toolOutput: { _meta: { "ai.ggui/session": {...}, "ai.ggui/stack-item": {...} } } }`.
 *
 * **Back-compat only.** The MCP-Apps spec
 * (`McpUiInitializeResult`) defines `{protocolVersion, hostInfo,
 * hostCapabilities, hostContext}` and does NOT carry `toolOutput`.
 * Spec-strict hosts (`<AppRenderer>` from `@mcp-ui/client`, ChatGPT
 * MCP-Apps connector) return `MISSING_TOOL_OUTPUT` from this
 * extractor by design; they deliver slice meta via the spec-canonical
 * `ui/notifications/tool-result` postMessage instead — see
 * {@link parseMetaFromToolResult}.
 *
 * Kept exported because:
 *
 *   - RN's `<McpAppIframe>` host (the only surviving in-house
 *     iframe wrapper post-spec-mig P2) still echoes here.
 *   - claude.ai's host echoes here as a bonus alongside its
 *     spec-canonical postMessage, so the synchronous read can win
 *     the race against the postMessage listener.
 *   - HostContext is captured opportunistically from the surrounding
 *     `result.hostContext` field per spec (Reading-B + spec-canonical
 *     hostContext live on the same object).
 */
export function parseMetaFromUiInitialize(
  uiInitializeResult: unknown,
): McpAppAiGguiMetaParseResult {
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
  const parsed = parseMcpAppAiGguiMeta(meta);
  if (!parsed.ok) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  const validated = validateMeta(parsed.meta);
  if (!validated.ok) return validated;

  // Opportunistically project HostContext from the sibling
  // `result.hostContext` field. Per the MCP Apps spec
  // (`McpUiInitializeResult.hostContext`), this carries
  // availableDisplayModes / containerDimensions / platform /
  // deviceCapabilities — the data canvas-mode display-mode
  // escalation and the agent (via handshake/consume echo) rely on.
  //
  // Best-effort: malformed / absent HostContext never affects the
  // slice parse.
  const hostContext = projectHostContext(uiInitializeResult['hostContext']);
  return hostContext !== undefined
    ? { ok: true, meta: validated.meta, hostContext }
    : validated;
}

/**
 * Back-compat alias for {@link parseMetaFromUiInitialize}.
 *
 * Kept exported so call sites that still grep / import the old name
 * don't need a sweep — the alias resolves to the same behavior. New
 * code should prefer the canonical `parseMetaFromUiInitialize`.
 */
export const parseBootstrap = parseMetaFromUiInitialize;

/**
 * Parse slices from `globalThis.__GGUI_META__` — the
 * synchronous self-contained shell delivery channel.
 *
 * The global carries the SAME slice envelope shape as the wire `_meta`
 * (`{ "ai.ggui/session": {...}, "ai.ggui/stack-item": {...} }`), so we
 * can defer to the same combiner.
 *
 * Used by the runtime's autostart resolver as the highest-priority
 * boot source: per-session shells (`/r/<shortCode>`,
 * `ui://ggui/session/<sessionId>`) populate this synchronously
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
  const parsed = parseMcpAppAiGguiMeta(raw);
  if (!parsed.ok) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  return validateMeta(parsed.meta);
}

/**
 * Parse slices from a `ui/notifications/tool-result` postMessage
 * params payload. Looks at BOTH the spec-canonical location
 * (`params._meta`) and the Reading-B `<McpAppIframe>` convention
 * (`params.toolOutput._meta`) — Claude Desktop / claude.ai Connector
 * use the first; first-party hosts the second.
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
  const parsed = parseMcpAppAiGguiMeta(meta);
  if (!parsed.ok) {
    return { ok: false, reason: 'MALFORMED_BOOTSTRAP' };
  }
  return validateMeta(parsed.meta);
}
