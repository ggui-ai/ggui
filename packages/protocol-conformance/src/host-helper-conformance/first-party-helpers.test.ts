/**
 * First-party adapter runs (ggui#600 leg 2) — the catalog driven at
 * the two in-repo first-party helpers, plus the historical guuey-kit
 * pre-0.12 shape preserved as a regression vector.
 *
 * ## Reference models, not live drives — and why (read before trusting)
 *
 * Every port below is a REFERENCE MODEL: a transcription of the
 * helper's protocol switch, kept in lockstep with its source by
 * review. None of these grades ran against the live module:
 *
 * - `iframe-runtime/src/mcp-app-iframe-host.ts` — the protocol
 *   machine (`handleHostBridgeRequest`) is an UNEXPORTED closure
 *   inside `mountMcpAppIframe`, bound to the mounted iframe element:
 *   the `ev.source === iframe.contentWindow` trust guard, responses
 *   via `contentWindow.postMessage`, `tools/call` via `fetch` to the
 *   server's `/mcp-apps/tools-call` proxy. Irreducibly DOM-bound —
 *   driving it live needs a browser-ish environment plus a mount,
 *   which this kit deliberately does not carry. If the machine is
 *   ever factored out (the RN sibling's `dispatchHostBridgeRequest`
 *   shape), swap the model for the export and delete this caveat.
 *
 * - `mcp-apps-react-native/src/McpAppIframe/dispatch.ts` — its
 *   `dispatchHostBridgeRequest` IS exported and pure, but importing
 *   the RN package here would add the react/react-native type family
 *   to the kit's dependency surface — the same class of dependency
 *   decision the T-grade resolved by callback injection. Modeled
 *   instead, pinning the CURRENT source truth including its open
 *   finding (below).
 *
 * ## Pinned findings (flip these pins when the source moves)
 *
 * 1. RN under-advertising: `dispatch.ts` hardcodes
 *    `hostCapabilities: {}` on `ui/initialize` even when a
 *    `tools/call` handler is wired — the helper RELAYS but never
 *    advertises `serverTools`. The catalog grades that R2 `fail`
 *    (under-advertising costs the runtime a failed-gesture probe per
 *    boot) → tier `nonconforming`. The fix belongs at source:
 *    advertise `serverTools` when `ctx.onToolCall` is wired (#440's
 *    advertise-exactly-what-you-implement rule, which the web helper
 *    follows); then flip this pin.
 *
 * 2. Web-helper hardcoded chrome: `mcp-app-iframe-host.ts` paints
 *    `border: '1px solid #e5e5e5'` + `borderRadius: '8px'` on the
 *    mounted iframe — the round-6 class on the WEB helper. The chrome
 *    audit below is a STATIC TRANSCRIPTION of those literal style
 *    assignments (no DOM run claimed); C1 fails naming them. When the
 *    helper's chrome moves under theme governance, flip this pin.
 */
import { describe, expect, it } from 'vitest';
import {
  runHostHelperConformance,
  type HostHelperPort,
  type JsonRpcResponse,
} from './index.js';

const METHOD_NOT_SUPPORTED = -32601;
const INVALID_PARAMS = -32602;

function response(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(
  id: number | string,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Structural read of `params.name` — no casts, `in`-narrowed. */
function toolName(params: unknown): string {
  if (typeof params !== 'object' || params === null || !('name' in params)) {
    return '';
  }
  const { name } = params;
  return typeof name === 'string' ? name : '';
}

/**
 * The ggui server's `/mcp-apps/tools-call` proxy, as both first-party
 * helpers see it: a sink returning a `CallToolResult`-shaped body the
 * helper must pass through VERBATIM — modeled with a FAILURE envelope
 * so the round-trip pin covers the shape that matters (`{ok:false}`
 * passes through unmodified; re-shaping breaks runtime self-healing).
 */
function proxySinkEnvelope(): Record<string, unknown> {
  return { content: [], structuredContent: { ok: false, code: 'PIPE_NOT_FOUND' } };
}

/**
 * REFERENCE MODEL of `mountMcpAppIframe`'s host-bridge switch
 * (`@ggui-ai/iframe-runtime`, `mcp-app-iframe-host.ts`) — see the
 * header for why this is a model, not the live closure. Transcribed:
 *
 * - `ui/initialize` → spec-canonical `McpUiInitializeResult`;
 *   `hostCapabilities: { serverTools: {} }` (the source advertises
 *   exactly what its switch implements, per #440).
 * - `tools/call` → requires `params.name` (`-32602` otherwise), then
 *   forwards to the proxy and returns its JSON body verbatim.
 * - anything else → bare `-32601 method_not_supported` (the source
 *   message does NOT name the method — pinned below).
 */
function iframeRuntimeEmbedHostModel(): HostHelperPort {
  return {
    async send(req): Promise<JsonRpcResponse | null> {
      switch (req.method) {
        case 'ui/initialize':
          return response(req.id, {
            protocolVersion: '2026-01-26',
            hostInfo: { name: 'ggui-iframe-runtime-embed-host', version: 'dev' },
            hostCapabilities: { serverTools: {} },
            hostContext: {
              locale: 'en-US',
              containerDimensions: { maxWidth: 480 },
            },
          });
        case 'tools/call': {
          const tool = toolName(req.params);
          if (tool.length === 0) {
            return errorResponse(
              req.id,
              INVALID_PARAMS,
              'tools/call requires params.name',
            );
          }
          return response(req.id, proxySinkEnvelope());
        }
        default:
          return errorResponse(req.id, METHOD_NOT_SUPPORTED, 'method_not_supported');
      }
    },
  };
}

/**
 * STATIC TRANSCRIPTION of the literal style assignments
 * `mountMcpAppIframe` makes on the mounted iframe (the slot element).
 * No empty/fallback slot exists — the container is cleared and the
 * iframe is its sole child.
 */
const IFRAME_RUNTIME_SLOT_STYLES: Record<string, string> = {
  width: '100%',
  height: '480px',
  maxWidth: '100%',
  border: '1px solid #e5e5e5',
  borderRadius: '8px',
  display: 'block',
};

/**
 * REFERENCE MODEL of `dispatchHostBridgeRequest`
 * (`@ggui-ai/mcp-apps-react-native`, `McpAppIframe/dispatch.ts`) in
 * the assembled RELAYING posture — a `tools/call` handler wired (the
 * component's caller supplies the server-proxy sink, per
 * `mcp-apps-bridge.ts`). Transcribed:
 *
 * - `ping` → `{ok: true, pong: true}`.
 * - `ui/initialize` → spec-canonical result with
 *   `hostCapabilities: {}` — HARDCODED empty even though the relay is
 *   wired: pinned finding 1 (under-advertising).
 * - `tools/call` → handler result object returned as-is (verbatim
 *   envelope pass-through).
 * - anything else → bare `-32601 method_not_supported`.
 */
function rnMcpAppIframeModel(): HostHelperPort {
  return {
    async send(req): Promise<JsonRpcResponse | null> {
      switch (req.method) {
        case 'ping':
          return response(req.id, { ok: true, pong: true });
        case 'ui/initialize':
          return response(req.id, {
            protocolVersion: '2026-01-26',
            hostInfo: { name: 'ggui-react-native', version: 'unstamped' },
            hostCapabilities: {},
            hostContext: { locale: 'en-US', containerDimensions: {} },
          });
        case 'tools/call': {
          const tool = toolName(req.params);
          if (tool.length === 0) {
            return errorResponse(
              req.id,
              INVALID_PARAMS,
              'tools/call requires params.name',
            );
          }
          return response(req.id, proxySinkEnvelope());
        }
        default:
          return errorResponse(req.id, METHOD_NOT_SUPPORTED, 'method_not_supported');
      }
    },
  };
}

/**
 * REFERENCE MODEL of the guuey-kit PRE-0.12 host shape — the
 * historical trimly posture: initialize-only, every other method
 * refused with the kit's verbatim naming template. Preserved as a
 * regression vector: this exact shape is the reason the catalog
 * exists, and it grades tier `read-only` with ZERO failures — the
 * honest declared tier an assembler reads instead of discovering it
 * with a user's dead tap.
 */
function guueyKitPre012Model(): HostHelperPort {
  return {
    async send(req): Promise<JsonRpcResponse | null> {
      if (req.method === 'ui/initialize') {
        return response(req.id, {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'guuey-kit-view-host', version: 'pre-0.12.0' },
          hostCapabilities: {},
          hostContext: { locale: 'en-US' },
        });
      }
      return errorResponse(
        req.id,
        METHOD_NOT_SUPPORTED,
        `method_not_supported: ${req.method} — this host answers ui/initialize only`,
      );
    },
  };
}

describe('first-party helpers — iframe-runtime embed host (reference model)', () => {
  it('grades tier "relaying" with every H and R case passing', async () => {
    const report = await runHostHelperConformance(iframeRuntimeEmbedHostModel());
    expect(report.tier).toBe('relaying');
    expect(report.failures).toEqual([]);
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c.outcome]));
    expect(byId['H1-initialize-well-formed']).toBe('pass');
    expect(byId['H2-advertisement-truthful']).toBe('pass');
    expect(byId['H3-refusal-honest']).toBe('pass');
    expect(byId['H4-refusal-bounded']).toBe('pass');
    expect(byId['R1-relay-round-trip']).toBe('pass');
    expect(byId['R2-relay-advertised']).toBe('pass');
    // Ungraded optional classes stay skipped — no audit, no theme.
    expect(byId['C1-containment-only']).toBe('skip');
    expect(byId['T1-theme-coverage']).toBe('skip');
  });

  it('pins the source refusal shape: bare -32601 that does not name the method', async () => {
    const report = await runHostHelperConformance(iframeRuntimeEmbedHostModel());
    const h3 = report.cases.find((c) => c.id === 'H3-refusal-honest');
    expect(h3?.outcome).toBe('pass');
    expect(h3?.detail).toContain('does not name the method');
  });

  it('OPEN FINDING (pinned): the transcribed hardcoded chrome fails C1 — border + borderRadius', async () => {
    const report = await runHostHelperConformance(iframeRuntimeEmbedHostModel(), {
      chromeAudit: {
        slotStyles: IFRAME_RUNTIME_SLOT_STYLES,
        emptySlotStyles: {},
      },
    });
    const c1 = report.cases.find((c) => c.id === 'C1-containment-only');
    expect(c1?.outcome).toBe('fail');
    expect(c1?.detail).toContain('slot.border');
    expect(c1?.detail).toContain('slot.borderRadius');
    // Containment styles are NOT named as offenders.
    expect(c1?.detail).not.toContain('slot.width');
    expect(c1?.detail).not.toContain('slot.display');
    expect(report.tier).toBe('nonconforming');
  });
});

describe('first-party helpers — RN McpAppIframe dispatcher (reference model)', () => {
  it('OPEN FINDING (pinned): relays but under-advertises — R2 fails, tier nonconforming', async () => {
    const report = await runHostHelperConformance(rnMcpAppIframeModel());
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c.outcome]));
    // The relay itself is healthy…
    expect(byId['H1-initialize-well-formed']).toBe('pass');
    expect(byId['H3-refusal-honest']).toBe('pass');
    expect(byId['H4-refusal-bounded']).toBe('pass');
    expect(byId['R1-relay-round-trip']).toBe('pass');
    // …and H2 passes VACUOUSLY (nothing advertised means nothing to
    // contradict) — which is exactly why R2 exists: the empty
    // advertisement over a live relay is the under-advertising shape.
    expect(byId['H2-advertisement-truthful']).toBe('pass');
    expect(byId['R2-relay-advertised']).toBe('fail');
    const r2 = report.cases.find((c) => c.id === 'R2-relay-advertised');
    expect(r2?.detail).toContain('under-advertising');
    expect(report.failures).toEqual(['R2-relay-advertised']);
    expect(report.tier).toBe('nonconforming');
  });
});

describe('historical shapes — guuey-kit pre-0.12 (reference model)', () => {
  it('grades tier "read-only" with zero failures — the honest declared tier', async () => {
    const report = await runHostHelperConformance(guueyKitPre012Model());
    expect(report.tier).toBe('read-only');
    expect(report.failures).toEqual([]);
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c.outcome]));
    expect(byId['H1-initialize-well-formed']).toBe('pass');
    expect(byId['H2-advertisement-truthful']).toBe('pass');
    expect(byId['H3-refusal-honest']).toBe('pass');
    expect(byId['H4-refusal-bounded']).toBe('pass');
    expect(byId['R1-relay-round-trip']).toBe('skip');
    expect(byId['R2-relay-advertised']).toBe('skip');
  });

  it('pins the verbatim refusal template — the method-naming reference shape', async () => {
    const report = await runHostHelperConformance(guueyKitPre012Model());
    const h3 = report.cases.find((c) => c.id === 'H3-refusal-honest');
    expect(h3?.detail).toBe('in-band -32601 naming the method');
  });
});
