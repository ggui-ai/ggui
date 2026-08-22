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
 *   An advertises-but-refuses helper makes the runtime's confirmed-
 *   failure latch structurally unreachable — the worst dead-tap shape.
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
 * A helper that refuses the relay honestly is graded **tier
 * `read-only`** — a LEGAL grade, with the R cases skipped, never
 * failed. `nonconforming` means a dishonesty case failed.
 */

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

export interface HostHelperConformanceOptions {
  /**
   * How long a refusal may take before it counts as a hang (H4 /
   * silent-drop detection). Refusals are immediate by nature; the
   * default absorbs slow transports, not slow decisions.
   */
  readonly refusalTimeoutMs?: number;
  /**
   * Chrome audit for the C-grades. Absent ⇒ C cases report `skip`
   * (self-certification pending) — the tier is decided by H/R alone.
   */
  readonly chromeAudit?: ChromeAudit;
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

function isContainmentStyle(property: string): boolean {
  return CONTAINMENT_STYLE_ALLOWLIST.has(
    property.toLowerCase().replace(/-/g, ''),
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

  // ── relay probe (feeds H2 and R1) ─────────────────────────────────
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

  // ── H2: advertisement truthfulness ────────────────────────────────
  if (capabilities === undefined) {
    cases.push({
      id: 'H2-advertisement-truthful',
      outcome: 'skip',
      detail: 'no capabilities captured (H1 failed)',
    });
  } else if (!advertisesServerTools) {
    cases.push({
      id: 'H2-advertisement-truthful',
      outcome: 'pass',
      detail: 'nothing advertised beyond the probe map — vacuously truthful',
    });
  } else {
    cases.push(
      relayAnswered
        ? {
            id: 'H2-advertisement-truthful',
            outcome: 'pass',
            detail: 'serverTools advertised and tools/call answered',
          }
        : {
            id: 'H2-advertisement-truthful',
            outcome: 'fail',
            detail:
              'serverTools advertised but tools/call was refused or dropped — the runtime latch is structurally unreachable on this shape (ggui#596)',
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
      for (const prop of Object.keys(styles)) {
        if (!isContainmentStyle(prop)) {
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
