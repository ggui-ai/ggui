/**
 * Host-helper conformance catalog (ggui#600) — grades the library that
 * mounts a ggui view and answers the MCP-Apps bridge (a "host helper"):
 * does it answer `ui/initialize` well-formed, advertise truthfully,
 * refuse honestly and boundedly, and either relay the runtime tool
 * family or stand as a declared read-only tier?
 *
 * ## Why this catalog exists
 *
 * The 2026-08-21 production incident (ggui#596): a chat-rail host
 * mounted interactive cards with its `tools/call` relay off — legal
 * under the external MCP Apps spec (relay is an optional capability),
 * invisible to every test, discovered by a user's dead tap. This
 * catalog is the structural catch: a helper vendor runs it in CI and
 * the scorecard names the tier — `relaying` or `read-only` — so an
 * assembler reads the grade instead of shipping the discovery.
 *
 * ## Driver contract
 *
 * The kit drives JSON-RPC messages through a {@link HostHelperPort}
 * the implementer supplies — the same implementation-as-callbacks
 * pattern as the props-schema catalog. No DOM, no postMessage plumbing:
 * an adapter binds the port to the helper's real transport (window
 * messaging, an in-process machine, a WebView bridge).
 *
 * ## Grades
 *
 * - `H1-initialize-well-formed` — `ui/initialize` answers a result
 *   carrying a `hostCapabilities` object (empty is legal).
 * - `H2-advertisement-truthful` — every advertised capability with a
 *   probe mapping answers its method family (advertised ⊆ answered).
 *   The map: `serverTools` → `tools/call`, and `serverResources` →
 *   `resources/read` (ggui#1304). An advertises-but-refuses helper
 *   makes the runtime's confirmed-failure latch structurally
 *   unreachable — the worst dead-tap shape. For the read, an answer is
 *   a `ReadResourceResult` (a `contents` array) or the server's own
 *   error forwarded in-band; a refusal, a drop, or a re-shaped result
 *   fails, because the declaration-level shell mounts only from what
 *   that read returns (the read-plane door, SPEC §7.1). Only an
 *   ADVERTISED `serverResources` is probed: a helper that does not
 *   advertise it is never sent `resources/read` and stays legal.
 * - `H3-refusal-honest` — an unsupported request is refused IN-BAND
 *   with JSON-RPC `-32601` naming the method. Silent drops fail: a
 *   refusal is recoverable, a hang leaves the runtime guessing.
 * - `H4-refusal-bounded` — the refusal arrives within the probe
 *   timeout (a refusal is immediate by nature; only delivery is slow).
 * - `R1-relay-round-trip` — a relaying helper forwards `tools/call`
 *   for the runtime tool family and returns the result envelope
 *   UNMODIFIED — including failure result envelopes (`{ok:false}`
 *   passes through; re-shaping breaks the runtime's self-healing).
 * - `R2-relay-advertised` — a relaying helper advertises
 *   `serverTools` (truthful positive advertisement).
 *
 * - `T1-theme-coverage` — OPTIONAL (like the C-class chrome audit):
 *   when a theme registration is supplied, it covers the consumed-
 *   token manifest or declares explicit inherit (ggui#598's
 *   registration gate, graded at the helper's door). The kit carries
 *   no theme machinery — the option takes the VALIDATOR AS A CALLBACK
 *   (implementation-as-callbacks, the kit's own pattern); the
 *   reference validate is `@ggui-ai/design`'s `validateThemeCoverage`
 *   bound to the shipped `consumed-tokens.manifest.json` tokens.
 *
 * - `M1-model-tool-set` — OPTIONAL like T1, graded when the host supplies
 *   the filter it uses to derive the MODEL's tool list from a served
 *   `tools/list` (ggui#1414): the result must withhold every tool whose
 *   `_meta.ui.visibility` lacks `'model'` (ggui's six `ggui_runtime_*`
 *   app-only tools) and keep every other tool. SEP-1865 assigns this door
 *   to the host, and the server cannot observe a violation — a
 *   view-issued and a model-issued call are indistinguishable on the wire
 *   — so the kit is where a host proves it. Absent ⇒ `skip`.
 *
 * - `V1-view-material-withheld` — OPTIONAL (ggui#1415, SPEC §4.7): the
 *   host keeps view-delivered material out of the model's context. The
 *   kit feeds the host's own context rules a render result and a render
 *   read body whose `_meta["ai.ggui/render"]` slice carries a unique
 *   marker in every string value, and requires none of them (raw,
 *   JSON-escaped, percent-encoded, or inside a base64 / base64url run) in
 *   what the model sees, while the
 *   model still sees the result's model-visible marker; and the host's
 *   model-facing resource list, when it has one, must withhold
 *   `ui://ggui/render/*` while keeping an ordinary resource. Absent ⇒
 *   `skip`.
 * - `L1-view-locator-binding` — OPTIONAL (ggui#1415, SPEC §4.7): the host
 *   binds a view's calls and reads to its own locator. The kit feeds the
 *   host's own relay decision a view mounted for one session, and reads
 *   (every locator form) and every session-naming call a view may make,
 *   for that session (relay) and another (refuse). Absent ⇒ `skip`.
 *
 * The three host-rule grades (M1, V1, L1) grade the host's RULE, fed
 * fixtures: they prove the rule is right, not that a running host applies
 * it (self-certification; the V1 and L1 pass details say so).
 *
 * A helper that refuses the relay honestly is graded **tier
 * `read-only`** — a LEGAL grade, with the R cases skipped, never
 * failed. `nonconforming` means a dishonesty case failed.
 */

import {
  toolVisibleToModel,
  type McpAppsToolVisibility,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { renderLocatorUri } from '../resource-read-conformance/index.js';

/** Minimal JSON-RPC request the driver sends through the port. */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

/** Minimal JSON-RPC response the port returns (null = no answer). */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/**
 * The implementation under test, as a message port: deliver one
 * request to the helper, resolve with its response — or `null` when
 * the helper produced none (a drop). Adapters own transports.
 */
export interface HostHelperPort {
  send(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
}

/**
 * Style inventory of the helper's mount surfaces, collected by the
 * vendor (computed styles on web, style objects on RN) and graded by
 * the kit — the pure-node split that keeps DOM out of the catalog.
 * The helper OWNS containment only; every visual property beyond it is
 * chrome the theme contract cannot reach (the round-6 class:
 * `McpAppIframe` hardcoded borderWidth/#e5e5e5/radius on both slots,
 * present in every #589 rejection round). Silhouette (rim, clip,
 * radius) belongs to the EMBEDDING host outside the helper; tokens
 * belong to the theme; the helper paints nothing.
 */
export interface ChromeAudit {
  /** Styles the helper applies to the mounted view's slot element. */
  readonly slotStyles: Record<string, string>;
  /** Styles the helper applies to its empty/fallback slot. */
  readonly emptySlotStyles: Record<string, string>;
}

/**
 * What the theme-coverage callback returns — structurally identical
 * to `@ggui-ai/design`'s `ThemeCoverageResult`, declared here so the
 * kit's dependency surface stays `@ggui-ai/protocol` + `ws` (the
 * validator is injected, never imported).
 */
export interface ThemeCoverageValidationResult {
  /** True iff every obligated manifest token is covered in both modes. */
  readonly covered: boolean;
  /** Obligated tokens not covered, per mode. */
  readonly uncovered: {
    readonly light: readonly string[];
    readonly dark: readonly string[];
  };
  /** Tokens satisfied via explicit inherit declarations. */
  readonly inheritMatched: readonly string[];
  /** Manifest tokens excluded from the obligation (non-definable). */
  readonly excluded: readonly string[];
}

/**
 * Theme-coverage grading input (T1). `registration` is the helper's
 * theme registration document pair, OPAQUE to the kit — only the
 * supplied `validate` callback reads it. The reference callback is
 * `@ggui-ai/design`'s `validateThemeCoverage` bound to the shipped
 * `consumed-tokens.manifest.json` `tokens` array:
 *
 * ```ts
 * const docs: ThemeRegistrationDocs = { light, dark };
 * themeCoverage: {
 *   registration: docs,
 *   validate: () => validateThemeCoverage(docs, manifest.tokens),
 * }
 * ```
 */
export interface ThemeCoverageOptions {
  readonly registration: unknown;
  readonly validate: (registration: unknown) => ThemeCoverageValidationResult;
}

/**
 * A tool as a host sees it on a served `tools/list` — the two fields the
 * visibility door reads. Nothing else on a tool declaration decides who may
 * call it.
 */
export interface ServedToolDeclaration {
  readonly name: string;
  readonly _meta?: {
    readonly ui?: { readonly visibility?: readonly McpAppsToolVisibility[] };
  };
}

/** The M1 grade's input: the host's own model-facing filter. */
export interface ModelToolSetOptions {
  /**
   * The function the host uses to derive the MODEL's tool list from a
   * served `tools/list` (names only). The kit feeds
   * {@link MODEL_TOOL_SET_FIXTURE} and grades the result against
   * `toolVisibleToModel`.
   */
  readonly offeredToModel: (
    served: readonly ServedToolDeclaration[],
  ) => readonly string[];
}

/**
 * A served-equivalent shape the M1 grade feeds a host's filter (ggui#1414):
 * agent tools as ggui declares them — `ggui_render` and `ggui_update` stamp
 * `visibility: ['model']`, the others carry no marker (the spec's default)
 * — and ggui's six app-only `ggui_runtime_*` tools. The list is static and
 * the names are the protocol's own, so it grades the FILTER a host applies,
 * never the host's live `tools/list`: a host that filters by name rather
 * than by visibility passes only as long as this list matches what its
 * server lists, which is why the grade wants the filter and the SPEC
 * points at the predicate.
 */
export const MODEL_TOOL_SET_FIXTURE: readonly ServedToolDeclaration[] = [
  { name: 'ggui_handshake' },
  { name: 'ggui_render', _meta: { ui: { visibility: ['model'] } } },
  { name: 'ggui_update', _meta: { ui: { visibility: ['model'] } } },
  { name: 'ggui_consume' },
  { name: 'ggui_amend' },
  { name: 'ggui_runtime_submit_action', _meta: { ui: { visibility: ['app'] } } },
  { name: 'ggui_runtime_pull', _meta: { ui: { visibility: ['app'] } } },
  { name: 'ggui_runtime_sync_context', _meta: { ui: { visibility: ['app'] } } },
  { name: 'ggui_runtime_refresh_ws_token', _meta: { ui: { visibility: ['app'] } } },
  { name: 'ggui_runtime_telemetry', _meta: { ui: { visibility: ['app'] } } },
  { name: 'ggui_runtime_declare_tool_catalog', _meta: { ui: { visibility: ['app'] } } },
];

/** A tool result as a host receives it: what the model may see, and the `_meta` the view gets. */
export interface ToolResultFixture {
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly _meta: Readonly<Record<string, unknown>>;
}

/** A resource or resource template as a host sees it on the server's lists. */
export interface ServedResourceDeclaration {
  readonly name: string;
  readonly uri?: string;
  readonly uriTemplate?: string;
}

/** The V1 grade's input: the host's own rules for what the model sees. */
export interface ModelContextOptions {
  /** What the host places in the MODEL's context for one tool result, in any shape, sync or async. */
  readonly modelContextOf: (result: ToolResultFixture) => unknown;
  /**
   * What the host places in the MODEL's context for one `resources/read`
   * result of a render locator (a view's read, or one the host made), in any
   * shape, sync or async. A host that never shows the model a read body
   * returns nothing.
   */
  readonly modelContextOfRead: (read: ReadResultFixture) => unknown;
  /**
   * The resource URIs or templates the host offers the model to read.
   * Absent: the host offers the model no resource reads at all, which
   * meets the obligation by construction.
   */
  readonly resourcesOfferedToModel?: (served: readonly ServedResourceDeclaration[]) => readonly string[];
}

/** A `resources/read` result as a host receives it. */
export interface ReadResultFixture {
  readonly contents: readonly { readonly uri: string; readonly mimeType: string; readonly text: string }[];
}

/** The view a request comes from: the locator it mounted and its session. */
export interface MountedView {
  readonly locator: string;
  readonly sessionId: string;
}

/** One request a view makes through its host. */
export type ViewRequestFixture =
  | { readonly kind: 'resources/read'; readonly uri: string }
  | { readonly kind: 'tools/call'; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> };

/** The L1 grade's input: the host's own decision for one request a view makes. */
export interface ViewBindingOptions {
  readonly decide: (mounted: MountedView, request: ViewRequestFixture) => 'relay' | 'refuse';
}

/**
 * The render result V1 feeds a host's context builder (ggui#1415). Every
 * string value in the `_meta["ai.ggui/render"]` slice is a unique marker
 * ({@link VIEW_MATERIAL_CANARIES}); the model-visible parts carry values of
 * their own, so a host that shows them cannot trip a canary, and one marker
 * ({@link VIEW_MATERIAL_VISIBLE_MARKER}) the model must still see.
 */
export const VIEW_MATERIAL_RESULT_FIXTURE: ToolResultFixture = {
  structuredContent: { sessionId: 'vmx-visible-session-2a7d', status: 'rendered', note: 'vmx-visible-marker-5e1b' },
  content: [{ type: 'text', text: 'Rendered the card (vmx-visible-marker-5e1b).' }],
  _meta: {
    'ai.ggui/render': {
      sessionId: 'vmx-slice-session-3f9a1c',
      appId: 'vmx-slice-app-8b2e',
      runtimeUrl: 'https://vmx-slice-runtime.invalid/iframe-runtime.js',
      wsUrl: 'wss://vmx-slice-wsurl-4c2d.invalid/ws',
      wsToken: 'vmx-slice-wstoken-6d41e0a7',
      viewKey: 'vmx-slice-viewkey-Q2FuYXJ5S2V5',
      expiresAt: '2099-07-07T07:07:07.707Z',
      propsJson: '{"vmxSliceProp":"vmx-slice-props-91c2"}',
    },
  },
};

/**
 * The marker V1 requires in the model's context: the result itself is not
 * withheld. Both model-visible parts carry it, so a host that shows either
 * one passes.
 */
export const VIEW_MATERIAL_VISIBLE_MARKER = 'vmx-visible-marker-5e1b';

/**
 * Every string a value holds, walked deep: object values and keys, arrays,
 * Map entries, Set members, and byte views read as UTF-8 text. Cycles are
 * walked once.
 */
function stringValuesIn(value: unknown, out: string[] = [], seen: Set<object> = new Set()): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return out;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    out.push(new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
  } else if (value instanceof ArrayBuffer) {
    out.push(new TextDecoder().decode(new Uint8Array(value)));
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      stringValuesIn(k, out, seen);
      stringValuesIn(v, out, seen);
    }
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) stringValuesIn(item, out, seen);
  } else {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringValuesIn(v, out, seen);
    }
  }
  return out;
}

/**
 * One canary per string value of the fixture's `ai.ggui/render` slice: the
 * value's unique `vmx-slice-…` mark, which survives JSON escaping and
 * encoding, or the whole value when it carries none. None may reach the model.
 */
export const VIEW_MATERIAL_CANARIES: readonly string[] = Object.values(
  VIEW_MATERIAL_RESULT_FIXTURE._meta['ai.ggui/render'] as Readonly<Record<string, unknown>>,
)
  .filter((value): value is string => typeof value === 'string')
  .map((value) => /vmx-slice-[A-Za-z0-9-]+/.exec(value)?.[0] ?? value);

/** The resources V1 feeds a host's model-facing resource list: the render template and one ordinary resource. */
export const MODEL_RESOURCE_FIXTURE: readonly ServedResourceDeclaration[] = [
  { name: 'ggui render', uriTemplate: 'ui://ggui/render/{sessionId}' },
  { name: 'notes', uri: 'file:///vmx-notes.md' },
];

/**
 * A render locator's `resources/read` result as a server answers it: the
 * self-contained shell, with the view's slice inlined, canaries included.
 */
export const VIEW_MATERIAL_READ_FIXTURE: ReadResultFixture = {
  contents: [
    {
      uri: 'ui://ggui/render/vmx-slice-session-3f9a1c',
      mimeType: 'text/html;profile=mcp-app',
      text: `<!doctype html><html><body><script>globalThis.__GGUI_META__ = ${JSON.stringify(VIEW_MATERIAL_RESULT_FIXTURE._meta)};</script></body></html>`,
    },
  ],
};

/** The view L1's requests come from. */
export const VIEW_BINDING_MOUNT: MountedView = { locator: 'ui://ggui/render/vmx-s1/bk-vmx1', sessionId: 'vmx-s1' };

const OTHER_SESSION = 'vmx-s2';

/**
 * Every tool a view may call (no `model`-only marker) that names a session in
 * its arguments, with arguments its input schema accepts. Left out:
 * `ggui_runtime_declare_tool_catalog` (app-scoped, names none),
 * `ggui_runtime_refresh_ws_token` (its session is inside the envelope, and
 * the server admits the caller to it), `ggui_handshake` and
 * `ggui_list_sessions` (name none), and `ggui_render` / `ggui_update`
 * (model-only).
 */
export const VIEW_SESSION_BOUND_CALLS: readonly { readonly name: string; readonly args: (sessionId: string) => Readonly<Record<string, unknown>> }[] = [
  {
    name: 'ggui_runtime_submit_action',
    args: (sessionId) => ({
      kind: 'dispatch',
      payload: { intent: 'confirm', actionData: null, uiContext: {} },
      sessionId,
      appId: 'vmx-app',
      actionId: 'a3f2b1d4',
      firedAt: '2026-09-29T00:00:00.000Z',
    }),
  },
  { name: 'ggui_runtime_sync_context', args: (sessionId) => ({ sessionId, appId: 'vmx-app', snapshot: {} }) },
  { name: 'ggui_runtime_pull', args: (sessionId) => ({ sessionId }) },
  { name: 'ggui_runtime_telemetry', args: (sessionId) => ({ sessionId, events: [{ at: 0, kind: 'boot.path' }] }) },
  { name: 'ggui_consume', args: (sessionId) => ({ sessionId }) },
  { name: 'ggui_amend', args: (sessionId) => ({ sessionId, kind: 'merge', patch: { count: 1 } }) },
  { name: 'ggui_emit', args: (sessionId) => ({ sessionId, channel: 'status', payload: { text: 'hi' } }) },
  { name: 'ggui_get_session', args: (sessionId) => ({ sessionId }) },
  { name: 'ggui_get_render_source', args: (sessionId) => ({ sessionId }) },
];

/**
 * L1's requests and the decision each must get (ggui#1415). A view's own
 * session relays and another's refuses, for a read of either locator form
 * (`{sessionId}`, `{sessionId}/{blueprintKey}`, and an epoch pin `#N`) and
 * for every call in {@link VIEW_SESSION_BOUND_CALLS}.
 */
export const VIEW_BINDING_CASES: readonly { readonly request: ViewRequestFixture; readonly expect: 'relay' | 'refuse' }[] = [
  { request: { kind: 'resources/read', uri: VIEW_BINDING_MOUNT.locator }, expect: 'relay' },
  { request: { kind: 'resources/read', uri: `ui://ggui/render/${VIEW_BINDING_MOUNT.sessionId}` }, expect: 'relay' },
  { request: { kind: 'resources/read', uri: `ui://ggui/render/${VIEW_BINDING_MOUNT.sessionId}#2` }, expect: 'relay' },
  { request: { kind: 'resources/read', uri: `ui://ggui/render/${OTHER_SESSION}` }, expect: 'refuse' },
  { request: { kind: 'resources/read', uri: `ui://ggui/render/${OTHER_SESSION}/bk-vmx2` }, expect: 'refuse' },
  { request: { kind: 'resources/read', uri: `ui://ggui/render/${OTHER_SESSION}/bk-vmx2#1` }, expect: 'refuse' },
  ...VIEW_SESSION_BOUND_CALLS.flatMap((call) => [
    { request: { kind: 'tools/call' as const, name: call.name, arguments: call.args(VIEW_BINDING_MOUNT.sessionId) }, expect: 'relay' as const },
    { request: { kind: 'tools/call' as const, name: call.name, arguments: call.args(OTHER_SESSION) }, expect: 'refuse' as const },
  ]),
];

/** The base64 / base64url runs inside a string, decoded; a run that does not decode yields nothing. */
function decodedBase64Runs(text: string): string[] {
  const runs = text.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? [];
  // A blob can start anywhere in a run (after a URL path, say), and base64
  // decodes in 4-character groups, so each run is decoded from all four
  // offsets: one of them lines up with the blob.
  return runs.flatMap((run) =>
    [0, 1, 2, 3].flatMap((offset) => {
      const normal = run.slice(offset).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
      const usable = normal.slice(0, normal.length - (normal.length % 4 === 1 ? 1 : 0));
      try {
        const binary = atob(usable + '==='.slice((usable.length + 3) % 4));
        return [new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)))];
      } catch {
        // Not base64 from this offset: the run is searched raw already.
        return [];
      }
    }),
  );
}

/**
 * A string with its `%XX` escapes decoded, where it carries any: the form
 * state takes in a URL's query string. A malformed escape is left as is,
 * one escape at a time, so a stray `%` never hides the rest.
 */
function percentDecoded(text: string): string[] {
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return [];
  try {
    return [decodeURIComponent(text)];
  } catch {
    // A malformed escape somewhere: decode the well-formed ones in place.
    return [text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        // Bytes that are not UTF-8 stay escaped; the rest still decode.
        return run;
      }
    })];
  }
}

/**
 * Which canaries appear in a model context: raw (JSON-escaped values
 * included, since every mark is escape-free), or inside a percent-encoded
 * string or a base64 / base64url run, decoded (the first match per canary).
 */
function leakedCanaries(context: unknown): { readonly raw: readonly string[]; readonly encoded: readonly string[] } {
  const strings = stringValuesIn(context);
  const unescaped = strings.flatMap(percentDecoded);
  const decoded = [...unescaped, ...[...strings, ...unescaped].flatMap(decodedBase64Runs)];
  const raw = VIEW_MATERIAL_CANARIES.filter((c) => strings.some((s) => s.includes(c)));
  const encoded = VIEW_MATERIAL_CANARIES.filter((c) => !raw.includes(c) && decoded.some((s) => s.includes(c)));
  return { raw, encoded };
}

/** The slice field a canary is the value of, for a failure detail. */
function canaryField(canary: string): string {
  const slice = VIEW_MATERIAL_RESULT_FIXTURE._meta['ai.ggui/render'];
  const entry =
    typeof slice === 'object' && slice !== null
      ? Object.entries(slice).find(([, v]) => typeof v === 'string' && /vmx-slice-[A-Za-z0-9-]+/.exec(v)?.[0] === canary) ??
        Object.entries(slice).find(([, v]) => v === canary)
      : undefined;
  return entry !== undefined ? entry[0] : canary;
}

export interface HostHelperConformanceOptions {
  /**
   * How long a refusal may take before it counts as a hang (H4 /
   * silent-drop detection). Refusals are immediate by nature; the
   * default absorbs slow transports, not slow decisions.
   */
  readonly refusalTimeoutMs?: number;
  /**
   * Chrome audit for the C-grades. Absent ⇒ C cases report `skip`
   * (self-certification pending) — the tier is decided by H/R and by
   * whichever optional grades (C1, T1, M1, V1, L1) were supplied.
   */
  readonly chromeAudit?: ChromeAudit;
  /**
   * Theme registration + coverage validator for the T-grades. Absent
   * ⇒ T cases report `skip` (no theme registration supplied) — an
   * unthemed helper surface has no coverage obligation.
   */
  readonly themeCoverage?: ThemeCoverageOptions;
  /**
   * The host's model-facing tool filter for the M1 grade (ggui#1414).
   * Absent ⇒ M1 reports `skip` — the door is still the host's obligation;
   * it is just not graded here.
   */
  readonly modelToolSet?: ModelToolSetOptions;
  /**
   * The host's rules for what the model sees, for the V1 grade (ggui#1415).
   * Absent ⇒ V1 reports `skip`.
   */
  readonly modelContext?: ModelContextOptions;
  /**
   * The host's relay decision for a view's requests, for the L1 grade
   * (ggui#1415). Absent ⇒ L1 reports `skip`.
   */
  readonly viewBinding?: ViewBindingOptions;
}

export type HostHelperCaseOutcome = 'pass' | 'fail' | 'skip' | 'warn';

export interface HostHelperCaseResult {
  readonly id: string;
  readonly outcome: HostHelperCaseOutcome;
  readonly detail: string;
}

export type HostHelperTier = 'relaying' | 'read-only' | 'nonconforming';

export interface HostHelperConformanceReport {
  readonly catalog: 'host-helper-conformance';
  readonly tier: HostHelperTier;
  readonly cases: readonly HostHelperCaseResult[];
  /** The failing case ids — empty on a conforming helper of either tier. */
  readonly failures: readonly string[];
}

const METHOD_NOT_SUPPORTED = -32601;
const DEFAULT_REFUSAL_TIMEOUT_MS = 2_000;

/** A method no ggui helper answers — the honest-refusal probe. */
const UNSUPPORTED_PROBE_METHOD = 'ggui-conformance/unsupported-probe';

/**
 * The `resources/read` probe's URI: a well-formed render locator naming
 * a render that does not exist, built with the kit's own locator grammar
 * (one owner, `resource-read-conformance`; the kit compiles against the protocol's published integrations only where a predicate IS the contract (`toolVisibleToModel`), never against live wire types). It is a locator on purpose, so a helper that
 * forwards only `ui://ggui/render/` reads still forwards it; a relaying
 * helper then hands back the server's own classification of the miss,
 * which is an answer (ggui#1304).
 */
const RESOURCE_READ_PROBE_URI = renderLocatorUri({
  kind: 'render',
  session: 'conformance-probe',
});

/**
 * Containment styles a helper may legitimately apply to its mount
 * surfaces: sizing, layout participation, overflow clipping, and
 * stacking — never color, border, radius, shadow, or typography.
 * Vendor-prefixed and camelCase/kebab-case spellings both normalize.
 */
const CONTAINMENT_STYLE_ALLOWLIST = new Set([
  'overflow',
  'overflowx',
  'overflowy',
  'width',
  'height',
  'minwidth',
  'minheight',
  'maxwidth',
  'maxheight',
  'flex',
  'flexgrow',
  'flexshrink',
  'flexbasis',
  'alignself',
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'zindex',
  'contain',
  'aspectratio',
]);

/**
 * Border-family properties whose value can be judged: an EXPLICIT
 * non-painting value (`none` / `0`) is containment — it neutralizes
 * user-agent defaults and paints nothing — while any painting value
 * is chrome. Only the border family gets value-aware treatment; every
 * other visual property is chrome regardless of value.
 */
const BORDER_FAMILY_RE = /^border/;
const NON_PAINTING_VALUES = new Set(['none', '0', '0px']);

function isContainmentStyle(property: string, value: string): boolean {
  const normalized = property.toLowerCase().replace(/-/g, '');
  if (CONTAINMENT_STYLE_ALLOWLIST.has(normalized)) return true;
  return (
    BORDER_FAMILY_RE.test(normalized) &&
    NON_PAINTING_VALUES.has(value.trim().toLowerCase())
  );
}

let nextId = 1;

function request(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id: `hh-${nextId++}`, method, ...(params !== undefined ? { params } : {}) };
}

async function sendWithTimeout(
  port: HostHelperPort,
  req: JsonRpcRequest,
  timeoutMs: number,
): Promise<{ response: JsonRpcResponse | null; timedOut: boolean; ms: number }> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const raced = await Promise.race([port.send(req), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (raced === 'timeout') {
    return { response: null, timedOut: true, ms: Date.now() - started };
  }
  return { response: raced, timedOut: false, ms: Date.now() - started };
}

function isRefusal(resp: JsonRpcResponse | null): boolean {
  return resp?.error !== undefined && resp.error.code === METHOD_NOT_SUPPORTED;
}

/**
 * Why an advertised `serverResources` is untruthful, or `undefined`
 * when the read was answered: a `ReadResourceResult` (a `contents`
 * array) or any in-band error other than the `-32601` refusal (the
 * server's classification of the probe's miss, forwarded).
 */
function readProbeUntruthful(probe: {
  response: JsonRpcResponse | null;
  timedOut: boolean;
}): string | undefined {
  const resp = probe.response;
  if (resp === null) {
    return `serverResources advertised but resources/read was ${probe.timedOut ? 'not answered within the probe timeout' : 'silently dropped'} — a declaration-level shell against a read-plane-only server waits out its bound and fails with READ_DOOR_FAILED`;
  }
  if (isRefusal(resp)) {
    return 'serverResources advertised but resources/read was refused (-32601) — a declaration-level shell against a read-plane-only server has no other way to reach its envelope';
  }
  if (resp.error !== undefined) return undefined;
  const result = resp.result;
  const hasContents =
    typeof result === 'object' &&
    result !== null &&
    'contents' in result &&
    Array.isArray(result.contents);
  return hasContents
    ? undefined
    : 'serverResources advertised and resources/read answered, but not with a ReadResourceResult (no contents array) — the read must be forwarded verbatim; a re-shaped answer leaves the shell nothing to mount';
}

/**
 * Run the catalog against one helper port. Pure protocol driving —
 * safe anywhere node runs; a helper vendor calls this from their CI.
 */
export async function runHostHelperConformance(
  port: HostHelperPort,
  options: HostHelperConformanceOptions = {},
): Promise<HostHelperConformanceReport> {
  const refusalTimeoutMs =
    options.refusalTimeoutMs ?? DEFAULT_REFUSAL_TIMEOUT_MS;
  const cases: HostHelperCaseResult[] = [];

  // ── H1: initialize well-formed ────────────────────────────────────
  const init = await sendWithTimeout(
    port,
    request('ui/initialize', {
      appInfo: { name: 'ggui-conformance-driver', version: '0' },
      appCapabilities: {},
    }),
    refusalTimeoutMs,
  );
  const initResult = init.response?.result as
    | { hostCapabilities?: unknown }
    | undefined;
  const capabilities =
    initResult !== undefined &&
    typeof initResult.hostCapabilities === 'object' &&
    initResult.hostCapabilities !== null
      ? (initResult.hostCapabilities as Record<string, unknown>)
      : undefined;
  cases.push(
    capabilities !== undefined
      ? {
          id: 'H1-initialize-well-formed',
          outcome: 'pass',
          detail: `hostCapabilities: {${Object.keys(capabilities).join(', ')}}`,
        }
      : {
          id: 'H1-initialize-well-formed',
          outcome: 'fail',
          detail: init.timedOut
            ? 'ui/initialize did not answer within the probe timeout'
            : 'ui/initialize result carries no hostCapabilities object',
        },
  );

  const advertisesServerTools =
    capabilities !== undefined && capabilities['serverTools'] !== undefined;
  const advertisesServerResources =
    capabilities !== undefined && capabilities['serverResources'] !== undefined;

  // ── relay probe (feeds H2 and R1) ─────────────────────────────────
  // The probe's `payload: {}` is non-primitive DELIBERATELY: helpers
  // that stage primitive action payloads into a host affordance before
  // relaying (e.g. a chat composer's staging gate) fall THROUGH to the
  // relay on a non-primitive payload — so this probe grades the relay
  // itself, never the staging path. An all-primitive payload against
  // such a helper would legally answer the staged acceptance instead
  // of round-tripping the relay; do not "simplify" this shape.
  // (First observed live on the guuey kit baseline, ggui#600.)
  const relayProbe = await sendWithTimeout(
    port,
    request('tools/call', {
      name: 'ggui_runtime_submit_action',
      arguments: {
        kind: 'dispatch',
        sessionId: 'conformance-probe',
        payload: {},
        actionId: 'probe-1',
        firedAt: 0,
      },
    }),
    refusalTimeoutMs,
  );
  const relayAnswered =
    relayProbe.response !== null && relayProbe.response.error === undefined;
  const relayRefused = isRefusal(relayProbe.response);

  // ── read probe (feeds H2, ggui#1304) ─────────────────────────────
  // Sent only when `serverResources` is advertised: the capability is
  // the spec's "host can proxy resource reads to the MCP server", and a
  // helper that does not claim it owes no answer.
  const readProbe = advertisesServerResources
    ? await sendWithTimeout(
        port,
        request('resources/read', { uri: RESOURCE_READ_PROBE_URI }),
        refusalTimeoutMs,
      )
    : undefined;

  // ── H2: advertisement truthfulness ────────────────────────────────
  // One verdict per advertised capability in the probe map; the grade
  // fails on any untruthful one and names only those.
  const probed: { readonly claim: string; readonly untruthful?: string }[] = [];
  if (advertisesServerTools) {
    probed.push(
      relayAnswered
        ? { claim: 'serverTools advertised and tools/call answered' }
        : {
            claim: 'serverTools',
            untruthful:
              'serverTools advertised but tools/call was refused or dropped — the runtime latch is structurally unreachable on this shape (ggui#596)',
          },
    );
  }
  if (readProbe !== undefined) {
    const untruthful = readProbeUntruthful(readProbe);
    probed.push(
      untruthful === undefined
        ? { claim: 'serverResources advertised and resources/read answered' }
        : { claim: 'serverResources', untruthful },
    );
  }
  const untruthfulClaims = probed.flatMap((p) =>
    p.untruthful === undefined ? [] : [p.untruthful],
  );
  if (capabilities === undefined) {
    cases.push({
      id: 'H2-advertisement-truthful',
      outcome: 'skip',
      detail: 'no capabilities captured (H1 failed)',
    });
  } else if (probed.length === 0) {
    cases.push({
      id: 'H2-advertisement-truthful',
      outcome: 'pass',
      detail: 'nothing advertised beyond the probe map — vacuously truthful',
    });
  } else {
    cases.push(
      untruthfulClaims.length === 0
        ? {
            id: 'H2-advertisement-truthful',
            outcome: 'pass',
            detail: probed.map((p) => p.claim).join('; '),
          }
        : {
            id: 'H2-advertisement-truthful',
            outcome: 'fail',
            detail: untruthfulClaims.join('; '),
          },
    );
  }

  // ── H3 + H4: refusal honesty + boundedness ────────────────────────
  const refusal = await sendWithTimeout(
    port,
    request(UNSUPPORTED_PROBE_METHOD),
    refusalTimeoutMs,
  );
  if (isRefusal(refusal.response)) {
    const namesMethod =
      refusal.response?.error?.message.includes(UNSUPPORTED_PROBE_METHOD) ??
      false;
    cases.push({
      id: 'H3-refusal-honest',
      outcome: 'pass',
      detail: namesMethod
        ? 'in-band -32601 naming the method'
        : 'in-band -32601 (message does not name the method — acceptable, naming recommended)',
    });
    cases.push({
      id: 'H4-refusal-bounded',
      outcome: 'pass',
      detail: `refused in ${refusal.ms}ms`,
    });
  } else {
    cases.push({
      id: 'H3-refusal-honest',
      outcome: 'fail',
      detail: refusal.timedOut
        ? 'unsupported request HUNG — a silent drop leaves the runtime unable to distinguish refusal from loss'
        : 'unsupported request answered without a -32601 refusal',
    });
    cases.push({
      id: 'H4-refusal-bounded',
      outcome: refusal.timedOut ? 'fail' : 'skip',
      detail: refusal.timedOut
        ? 'no answer within the probe timeout'
        : 'not measurable (H3 failed without a timeout)',
    });
  }

  // ── R cases ───────────────────────────────────────────────────────
  if (relayAnswered) {
    const relayResult = relayProbe.response?.result as
      | { structuredContent?: unknown }
      | undefined;
    const envelope = relayResult?.structuredContent;
    cases.push(
      envelope !== undefined && typeof envelope === 'object'
        ? {
            id: 'R1-relay-round-trip',
            outcome: 'pass',
            detail:
              'result envelope returned intact (failure envelopes must pass through unmodified — the runtime self-heals on ANY well-formed result)',
          }
        : {
            id: 'R1-relay-round-trip',
            outcome: 'fail',
            detail:
              'tools/call answered but the result carries no structuredContent envelope',
          },
    );
    cases.push(
      advertisesServerTools
        ? {
            id: 'R2-relay-advertised',
            outcome: 'pass',
            detail: 'relay wired and serverTools advertised',
          }
        : {
            id: 'R2-relay-advertised',
            outcome: 'fail',
            detail:
              'relay answers but serverTools is not advertised — under-advertising costs the runtime a failed-gesture probe on every boot',
          },
    );
  } else if (relayRefused) {
    cases.push({
      id: 'R1-relay-round-trip',
      outcome: 'skip',
      detail: 'read-only tier — relay honestly refused',
    });
    cases.push({
      id: 'R2-relay-advertised',
      outcome: advertisesServerTools ? 'fail' : 'skip',
      detail: advertisesServerTools
        ? 'advertised yet refused (see H2)'
        : 'read-only tier — nothing to advertise',
    });
  } else {
    cases.push({
      id: 'R1-relay-round-trip',
      outcome: 'fail',
      detail: 'tools/call was silently dropped — neither relayed nor refused',
    });
    cases.push({
      id: 'R2-relay-advertised',
      outcome: 'skip',
      detail: 'not gradable over a dropped relay',
    });
  }

  // ── C1: zero ungoverned chrome ────────────────────────────────────
  if (options.chromeAudit === undefined) {
    cases.push({
      id: 'C1-containment-only',
      outcome: 'skip',
      detail:
        'no chrome audit supplied — self-certification pending (collect the slot style inventories and re-run)',
    });
  } else {
    const offending: string[] = [];
    for (const [surface, styles] of [
      ['slot', options.chromeAudit.slotStyles],
      ['emptySlot', options.chromeAudit.emptySlotStyles],
    ] as const) {
      for (const [prop, value] of Object.entries(styles)) {
        if (!isContainmentStyle(prop, value)) {
          offending.push(`${surface}.${prop}`);
        }
      }
    }
    cases.push(
      offending.length === 0
        ? {
            id: 'C1-containment-only',
            outcome: 'pass',
            detail: 'both mount surfaces carry containment styles only',
          }
        : {
            id: 'C1-containment-only',
            outcome: 'fail',
            detail: `ungoverned chrome the theme contract cannot reach: ${offending.join(', ')} — the helper owns containment only (silhouette = embedding host, tokens = theme; round-6 doctrine)`,
          },
    );
  }

  // ── T1: token coverage ────────────────────────────────────────────
  if (options.themeCoverage === undefined) {
    cases.push({
      id: 'T1-theme-coverage',
      outcome: 'skip',
      detail:
        'no theme registration supplied — an unthemed helper surface has no coverage obligation (supply themeCoverage to grade)',
    });
  } else {
    const coverage = options.themeCoverage.validate(
      options.themeCoverage.registration,
    );
    if (coverage.covered) {
      cases.push({
        id: 'T1-theme-coverage',
        outcome: 'pass',
        detail: `manifest covered — ${coverage.inheritMatched.length} inherit-matched, ${coverage.excluded.length} excluded (non-definable)`,
      });
    } else {
      const nameUncovered = (
        mode: 'light' | 'dark',
        tokens: readonly string[],
      ): string | undefined => {
        if (tokens.length === 0) return undefined;
        const named = tokens.slice(0, 10).join(', ');
        const rest = tokens.length - 10;
        return `${mode} uncovered (${tokens.length}): ${named}${rest > 0 ? ` …${rest} more` : ''}`;
      };
      const perMode = [
        nameUncovered('light', coverage.uncovered.light),
        nameUncovered('dark', coverage.uncovered.dark),
      ].filter((part): part is string => part !== undefined);
      cases.push({
        id: 'T1-theme-coverage',
        outcome: 'fail',
        detail: `consumed-token manifest not covered — ${perMode.join('; ')} (cover the tokens or declare explicit inherit; silence is not a legal way to inherit)`,
      });
    }
  }

  // ── M1: the model's tool set withholds app-only tools ─────────────
  if (options.modelToolSet === undefined) {
    cases.push({
      id: 'M1-model-tool-set',
      outcome: 'skip',
      detail:
        'no model-facing filter supplied — the visibility door is still the host\'s obligation (SEP-1865), just not graded here (supply modelToolSet to grade)',
    });
  } else {
    const offered = new Set(
      options.modelToolSet.offeredToModel(MODEL_TOOL_SET_FIXTURE),
    );
    const leaked = MODEL_TOOL_SET_FIXTURE.filter(
      (t) => !toolVisibleToModel(t._meta?.ui?.visibility) && offered.has(t.name),
    ).map((t) => t.name);
    const withheld = MODEL_TOOL_SET_FIXTURE.filter(
      (t) => toolVisibleToModel(t._meta?.ui?.visibility) && !offered.has(t.name),
    ).map((t) => t.name);
    const served = new Set(MODEL_TOOL_SET_FIXTURE.map((t) => t.name));
    const unknown = [...offered].filter((name) => !served.has(name));
    if (leaked.length === 0 && withheld.length === 0 && unknown.length === 0) {
      cases.push({
        id: 'M1-model-tool-set',
        outcome: 'pass',
        detail: `the model's tool set withholds every app-only tool and keeps every model-visible one (${offered.size} offered)`,
      });
    } else {
      const parts = [
        leaked.length > 0
          ? `app-only tools offered to the model (${leaked.length}): ${leaked.join(', ')} — a model holding the app credential can call them`
          : undefined,
        withheld.length > 0
          ? `model-visible tools withheld (${withheld.length}): ${withheld.join(', ')} — the agent cannot run the loop without them`
          : undefined,
        unknown.length > 0
          ? `names offered that the server never listed (${unknown.length}): ${unknown.join(', ')} — the list is not derived from tools/list`
          : undefined,
      ].filter((part): part is string => part !== undefined);
      cases.push({
        id: 'M1-model-tool-set',
        outcome: 'fail',
        detail: parts.join('; '),
      });
    }
  }

  // ── V1: view-delivered material stays out of the model's context ──
  if (options.modelContext === undefined) {
    cases.push({
      id: 'V1-view-material-withheld',
      outcome: 'skip',
      detail: "no model-context rule supplied: keeping view material from the model is still the host's obligation (SPEC §4.7), just not graded here (supply modelContext to grade)",
    });
  } else {
    const rules = options.modelContext;
    try {
      const context: unknown = await rules.modelContextOf(VIEW_MATERIAL_RESULT_FIXTURE);
      const readContext: unknown = await rules.modelContextOfRead(VIEW_MATERIAL_READ_FIXTURE);
      const fromResult = leakedCanaries(context);
      const fromRead = leakedCanaries(readContext);
      const seesResult = stringValuesIn(context).some((s) => s.includes(VIEW_MATERIAL_VISIBLE_MARKER));
      const offered = rules.resourcesOfferedToModel?.(MODEL_RESOURCE_FIXTURE);
      const offersRender = (offered ?? []).filter((u) => u.startsWith('ui://ggui/render'));
      const keepsOrdinary = offered === undefined || offered.includes('file:///vmx-notes.md');
      const parts = [
        fromResult.raw.length > 0 ? `view material from a tool result in the model's context: ${fromResult.raw.map(canaryField).join(', ')}` : undefined,
        fromResult.encoded.length > 0 ? `view material from a tool result inside a percent-encoded or base64 run: ${fromResult.encoded.map(canaryField).join(', ')}` : undefined,
        fromRead.raw.length > 0 ? `a render read body in the model's context: ${fromRead.raw.map(canaryField).join(', ')}` : undefined,
        fromRead.encoded.length > 0 ? `a render read body inside a percent-encoded or base64 run: ${fromRead.encoded.map(canaryField).join(', ')}` : undefined,
        seesResult ? undefined : `the model does not see the result's own marker ${VIEW_MATERIAL_VISIBLE_MARKER}: withholding the result is not withholding the view material`,
        offersRender.length > 0 ? `a render read offered to the model: ${offersRender.join(', ')}` : undefined,
        keepsOrdinary ? undefined : 'the ordinary resource was not offered: a list that hides everything is not a rule (omit resourcesOfferedToModel when the model reads no resources)',
      ].filter((part): part is string => part !== undefined);
      cases.push(
        parts.length === 0
          ? {
              id: 'V1-view-material-withheld',
              outcome: 'pass',
              detail: `none of the slice's ${VIEW_MATERIAL_CANARIES.length} values reaches the model from a tool result or a render read body, raw, JSON-escaped, percent-encoded, base64 or base64url; the result itself does; ${offered === undefined ? 'the host offers the model no resource reads' : 'no render read is offered'} (the host's rule, self-certified)`,
            }
          : { id: 'V1-view-material-withheld', outcome: 'fail', detail: parts.join('; ') },
      );
    } catch (err) {
      cases.push({ id: 'V1-view-material-withheld', outcome: 'fail', detail: `the host's rule threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // ── L1: a view's calls and reads are bound to its own locator ─────
  if (options.viewBinding === undefined) {
    cases.push({
      id: 'L1-view-locator-binding',
      outcome: 'skip',
      detail: "no view-binding rule supplied: binding a view to its own locator is still the host's obligation (SPEC §4.7), just not graded here (supply viewBinding to grade)",
    });
  } else {
    const describe = (r: ViewRequestFixture): string =>
      r.kind === 'resources/read' ? `resources/read ${r.uri}` : `${r.name} for session ${String(r.arguments['sessionId'])}`;
    const decide = options.viewBinding.decide;
    const decided = VIEW_BINDING_CASES.map((c) => {
      try {
        return { ...c, got: decide(VIEW_BINDING_MOUNT, c.request) };
      } catch (err) {
        // A rule that throws decides nothing: the request is neither relayed nor refused, and the case says so.
        return { ...c, got: `threw: ${err instanceof Error ? err.message : String(err)}` };
      }
    });
    const relayedForeign = decided.filter((c) => c.expect === 'refuse' && c.got !== 'refuse').map((c) => describe(c.request));
    const refusedOwn = decided.filter((c) => c.expect === 'relay' && c.got !== 'relay').map((c) => describe(c.request));
    const parts = [
      relayedForeign.length > 0 ? `relayed another view's request (${relayedForeign.length}): ${relayedForeign.join('; ')}` : undefined,
      refusedOwn.length > 0 ? `refused its own view's request (${refusedOwn.length}): ${refusedOwn.join('; ')}` : undefined,
    ].filter((part): part is string => part !== undefined);
    cases.push(
      parts.length === 0
        ? {
            id: 'L1-view-locator-binding',
            outcome: 'pass',
            detail: `the view's own reads and session-bound calls relay and another session's refuse, ${VIEW_BINDING_CASES.length} requests (the host's rule, self-certified)`,
          }
        : { id: 'L1-view-locator-binding', outcome: 'fail', detail: parts.join('; ') },
    );
  }

  const failures = cases
    .filter((c) => c.outcome === 'fail')
    .map((c) => c.id);
  const tier: HostHelperTier =
    failures.length > 0
      ? 'nonconforming'
      : relayAnswered
        ? 'relaying'
        : 'read-only';

  return { catalog: 'host-helper-conformance', tier, cases, failures };
}
