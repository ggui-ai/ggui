/**
 * `ggui_runtime_refresh_ws_token` — iframe-internal MCP tool that
 * swaps a (possibly-expired-but-signature-valid) WS auth envelope
 * for a fresh one without a re-handshake.
 *
 * Registered with `_meta.ui.visibility: ['app']` per MCP Apps spec
 * §401: only the iframe (view) may call. The agent never sees it on
 * its `tools/list` — the agent has no business in the live-channel
 * auth lifecycle.
 *
 * **Wire shape** (iframe-runtime postMessages via `tools/call`, host
 * relays to the MCP server):
 *
 * ```jsonc
 * {
 *   "method": "tools/call",
 *   "params": {
 *     "name": "ggui_runtime_refresh_ws_token",
 *     "arguments": {
 *       "envelope": "<base64url(payload)>.<base64url(hmac)>"
 *     }
 *   }
 * }
 * ```
 *
 * **Behavior:**
 *   - Signature OK + inside refresh window → returns
 *     `{ok:true, envelope:"...", expiresAt:"<ISO-8601>"}`. The iframe
 *     swaps in `envelope` for subsequent WS subscribes.
 *   - Refresh window closed (envelope older than
 *     `iat + refreshWindowSec`) → returns
 *     `{ok:false, code:"REFRESH_WINDOW_CLOSED"}`. Client MUST
 *     re-handshake (the matcher cache makes this cheap by design).
 *   - Tamper / format / kind failure → returns
 *     `{ok:false, code:"BOOTSTRAP_INVALID"}`. Client MUST
 *     re-handshake; the exact breakage is logged server-side.
 *   - No refresh seam wired on this deployment → returns
 *     `{ok:false, code:"BOOTSTRAP_NOT_SUPPORTED"}`.
 *
 * The `BOOTSTRAP_*` error codes are wire-frozen host-observable
 * lifecycle signals — host integrations pattern-match on them. They
 * stay spelled "BOOTSTRAP_" for back-compat with the previous naming;
 * the credential field itself is now `wsToken` everywhere internally.
 *
 * Stateless on the server side: validation is HMAC + claim arithmetic
 * only, no per-envelope state lookup. The cloud pod's
 * `runtime-refresh-ws-token.ts` composes this with the same
 * `MCP_BOOTSTRAP_SECRET` the render handler signs against.
 */

import { z } from 'zod';
import type { SharedHandler } from '../types.js';

const inputSchema = {
  envelope: z
    .string()
    .min(1, 'envelope is required')
    .describe(
      'The current WS auth envelope (e.g. `_meta["ai.ggui/render"].token` from the original `ggui_render` result). May be expired (within the refresh window). MUST NOT be tampered with — the server HMAC-verifies the signature against the same secret used at mint.',
    ),
} as const;

const outputSchema = {
  /** `true` on a successful refresh; `false` on any rejection. */
  ok: z.boolean(),
  /**
   * On `ok:false`, the canonical contract-error code:
   *   - `'BOOTSTRAP_INVALID'` — signature mismatch, malformed envelope,
   *     wrong kind (e.g. a session token submitted for ws-token
   *     refresh). Iframe MUST re-handshake.
   *   - `'REFRESH_WINDOW_CLOSED'` — signature valid, but the envelope
   *     is older than `iat + refreshWindowSec`. Iframe MUST re-handshake.
   *   - `'BOOTSTRAP_NOT_SUPPORTED'` — this deployment didn't wire a
   *     refresh seam (no signing secret configured). Iframe MUST
   *     re-handshake.
   */
  code: z
    .enum([
      'BOOTSTRAP_INVALID',
      'REFRESH_WINDOW_CLOSED',
      'BOOTSTRAP_NOT_SUPPORTED',
    ])
    .optional(),
  /** Human-readable diagnostic on `ok:false`. */
  message: z.string().optional(),
  /** On `ok:true`, the fresh WS auth envelope to swap in. */
  envelope: z.string().optional(),
  /**
   * On `ok:true`, the new `expiresAt` (ISO-8601). The iframe MAY use
   * this to schedule a pre-emptive next refresh just before expiry —
   * or it may simply wait for the next `BOOTSTRAP_EXPIRED` and refresh
   * lazily. Both postures are valid; the server enforces neither.
   */
  expiresAt: z.string().optional(),
} as const;

interface RefreshAccepted {
  readonly ok: true;
  readonly envelope: string;
  readonly expiresAt: string;
}

interface RefreshRejected {
  readonly ok: false;
  readonly code:
    | 'BOOTSTRAP_INVALID'
    | 'REFRESH_WINDOW_CLOSED'
    | 'BOOTSTRAP_NOT_SUPPORTED';
  readonly message: string;
}

type RefreshOutput = RefreshAccepted | RefreshRejected;

/**
 * Refresh seam — implementations receive the inbound envelope and
 * return either the freshly-minted envelope or a discriminated failure.
 * The OSS server wires this against `refreshWsToken` from
 * `@ggui-ai/mcp-server-core` (same HMAC secret as the render minter).
 *
 * Defined here (not imported from `mcp-server-core`) to keep the
 * handler package free of an extra dep — the cloud pod composes the
 * seam in its own tool wrapper, and the OSS factory composes one too.
 */
export interface WsTokenRefreshSeam {
  refresh(envelope: string):
    | { ok: true; token: string; expiresAt: string }
    | { ok: false; reason: 'window_closed' | 'invalid' };
}

export interface GguiRefreshWsTokenHandlerDeps {
  /**
   * The refresh seam — typically the same `channelWsToken.refresh`
   * the render-channel server wires for WS upgrade validation, so
   * both code paths share one HMAC secret and one refresh-window
   * policy. Absence is tolerated (`BOOTSTRAP_NOT_SUPPORTED` on every
   * call); same fail-closed posture as the other ws-token-aware
   * handlers.
   */
  readonly refreshSeam?: WsTokenRefreshSeam;
}

/**
 * Build the `ggui_runtime_refresh_ws_token` handler.
 *
 * The handler IS the contract: stateless, single I/O envelope, no DB,
 * no render-state lookup, no log spam on per-call success. The only
 * server-side state it touches is the HMAC secret captured by the
 * refresh seam at construction time.
 */
export function createGguiRefreshWsTokenHandler(
  deps: GguiRefreshWsTokenHandlerDeps = {},
): SharedHandler<typeof inputSchema, typeof outputSchema, RefreshOutput> {
  return {
    name: 'ggui_runtime_refresh_ws_token',
    title: '[runtime] Refresh WS Token',
    audience: ['runtime'],
    description:
      'Refreshes a (possibly-expired-but-signature-valid) WS auth envelope into a fresh one without a re-handshake. Stateless on the server — HMAC verify + refresh-window arithmetic only. iframe calls this when its WS subscribe returns `BOOTSTRAP_EXPIRED`; on `ok:true`, the iframe swaps in `envelope` and reconnects. On `ok:false`, the iframe MUST re-handshake (cheap via the matcher cache). Never invoked by the agent directly — `_meta.ui.visibility: [\'app\']` restricts callers to MCP Apps views per spec §401; the agent has no business in the live-channel auth lifecycle.',
    inputSchema,
    outputSchema,
    _meta: {
      ui: {
        // Spec §401: only an MCP Apps view (iframe) can call. Outer
        // agent does NOT see this tool on its tools/list.
        visibility: ['app'] as const,
      },
    },
    async handler(input): Promise<RefreshOutput> {
      const parsed = z.object(inputSchema).safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          code: 'BOOTSTRAP_INVALID',
          message: `refresh_ws_token: envelope rejected at input validation: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
        };
      }
      if (!deps.refreshSeam) {
        return {
          ok: false,
          code: 'BOOTSTRAP_NOT_SUPPORTED',
          message:
            'refresh_ws_token: this deployment did not wire a ws-token-refresh seam. The iframe MUST re-handshake.',
        };
      }
      const result = deps.refreshSeam.refresh(parsed.data.envelope);
      if (result.ok) {
        return {
          ok: true,
          envelope: result.token,
          expiresAt: result.expiresAt,
        };
      }
      if (result.reason === 'window_closed') {
        return {
          ok: false,
          code: 'REFRESH_WINDOW_CLOSED',
          message:
            'refresh_ws_token: envelope is past its refresh window (iat + refreshWindowSec). The iframe MUST re-handshake — the matcher cache makes this cheap.',
        };
      }
      return {
        ok: false,
        code: 'BOOTSTRAP_INVALID',
        message:
          'refresh_ws_token: envelope failed HMAC verification (tampered, malformed, or wrong kind). The iframe MUST re-handshake.',
      };
    },
  };
}
