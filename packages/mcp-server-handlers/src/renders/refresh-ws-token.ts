/**
 * `ggui_runtime_refresh_ws_token` — an AUTHORIZED re-mint of a view's live
 * credential (ggui#1496 part B).
 *
 * Registered with `_meta.ui.visibility: ['app']` per MCP Apps spec §401:
 * the view calls it through its host's `tools/call` relay, which is the
 * same relay the view's bridge rung (`ggui_runtime_pull`) already depends
 * on. The agent never sees it on its `tools/list`.
 *
 * **Wire shape:** `{ envelope }` in; `{ ok: true, envelope, expiresAt }`,
 * or `{ ok: false, code, message }` for a deployment-level or envelope-level
 * refusal. A refusal about the SESSION is thrown, not returned.
 *
 * **Answers, in order:**
 *   1. The deployment wires no render store, verifier or minter:
 *      `BOOTSTRAP_NOT_SUPPORTED`. This is decided before the envelope is
 *      read, because it is deployment-wide and leaks nothing.
 *   2. The envelope fails its signature, shape or kind (it may be of ANY
 *      age): `BOOTSTRAP_INVALID`.
 *   3. The envelope's session is missing, belongs to another app, or
 *      belongs to another subject: the SAME `GguiSessionNotFoundError`
 *      `ggui_runtime_pull` throws, byte-identical. The gate is the read
 *      door's own predicate ({@link renderReadAllowed}) on the LIVE row.
 *      An evicted session answers not-found here; only a host-driven
 *      `resources/read` re-mints one.
 *   4. The store read throws: that error propagates. It is never folded
 *      into the not-found, and nothing is minted.
 *   5. Otherwise the deployment's minter mints a fresh ROOT credential for
 *      the session.
 *
 * Every call is authorized by the caller's own connection, so no refresh
 * window bounds this path. A holder of an envelope who is not admitted to
 * its session gets nothing. The advertised output schema is pinned byte for
 * byte in `@ggui-ai/mcp-server` (ggui#1510).
 */
import { z } from 'zod';
import type { GguiSessionStore } from '@ggui-ai/mcp-server-core';
import { defineHandler, type HandlerContext } from '../types.js';
import { GguiSessionNotFoundError } from './errors.js';
import { renderReadAllowed } from './render-read-gate.js';

const inputSchema = {
  envelope: z
    .string()
    .min(1, 'envelope is required')
    .describe(
      'The view\'s current WS auth envelope (the `wsToken` of its `_meta["ai.ggui/render"]` slice), at any age. The server verifies its signature, then admits the CALLER to the envelope\'s session before minting a fresh one.',
    ),
} as const;

const outputSchema = {
  /** `true` on a successful refresh; `false` on any rejection. */
  ok: z.boolean(),
  /**
   * On `ok:false`, the canonical rejection code:
   *   - `'BOOTSTRAP_INVALID'` — signature mismatch, malformed envelope,
   *     or the wrong kind (e.g. a session token submitted here).
   *   - `'BOOTSTRAP_NOT_SUPPORTED'` — the deployment wires no render
   *     store, envelope verifier or minter.
   *   A session the caller cannot see is NOT answered here: it throws the
   *   same not-found `ggui_runtime_pull` throws.
   */
  code: z
    .enum([
      'BOOTSTRAP_INVALID',
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

export interface RefreshAccepted {
  readonly ok: true;
  readonly envelope: string;
  readonly expiresAt: string;
}

export interface RefreshRejected {
  readonly ok: false;
  readonly code: 'BOOTSTRAP_INVALID' | 'BOOTSTRAP_NOT_SUPPORTED';
  readonly message: string;
}

/**
 * The `ggui_runtime_refresh_ws_token` output union: the wire shape
 * `structuredContent` carries. Exported so callers (the iframe runtime,
 * e2e specs) type their reads against the handler's own contract.
 */
export type GguiRefreshWsTokenOutput = RefreshAccepted | RefreshRejected;

/**
 * A ws envelope's signature-and-kind verdict, at ANY age: the claims the
 * refresh needs. `rootIat` is the issued-at of the envelope's chain root: its
 * `rootIat` claim when a `/state` renewal minted it, else its own `iat`.
 */
export type WsEnvelopeVerdict =
  | { readonly ok: true; readonly sessionId: string; readonly appId: string; readonly rootIat: number }
  | { readonly ok: false };

export interface GguiRefreshWsTokenHandlerDeps {
  /** The session store the gate reads the LIVE row from. */
  readonly renderStore?: GguiSessionStore;
  /**
   * Verify an envelope's signature, shape and kind at any age. Wired over
   * the deployment's ws-token secret (`verifyWsTokenSignature` in
   * `@ggui-ai/mcp-server-core`).
   */
  readonly verify?: (envelope: string) => WsEnvelopeVerdict;
  /**
   * The deployment's ROOT minter for a session's live credential: the same
   * one the render result and the read door stamp with.
   */
  readonly mint?: (sessionId: string, appId: string) => { readonly token: string; readonly expiresAt: string };
}

/** One structured line per outcome, ids only. Handlers carry no logger. */
function logRefreshed(fields: { sessionId: string; appId: string; source: string | null; rootAgeSec: number }): void {
  // eslint-disable-next-line no-console -- operator-visible structured line; handlers carry no logger
  console.info(`[ggui] ws_token_refreshed ${JSON.stringify(fields)}`);
}
function logRefused(fields: { reason: 'not_supported' | 'invalid' | 'not_found' | 'read_failed'; source: string | null }): void {
  // eslint-disable-next-line no-console -- operator-visible structured line; handlers carry no logger
  console.warn(`[ggui] ws_token_refresh_refused ${JSON.stringify(fields)}`);
}

/**
 * Build the `ggui_runtime_refresh_ws_token` handler. Without all three
 * deps it answers `BOOTSTRAP_NOT_SUPPORTED` on every call.
 */
export function createGguiRefreshWsTokenHandler(deps: GguiRefreshWsTokenHandlerDeps = {}) {
  return defineHandler({
    name: 'ggui_runtime_refresh_ws_token',
    title: '[runtime] Refresh WS Token',
    audience: ['runtime'],
    description:
      "Re-mints a view's live-channel credential for a caller admitted to its session. The view sends its current envelope, at any age; the server verifies the envelope's signature, admits the caller to the envelope's session exactly as the render read door does (the app, then the subject), and mints a fresh credential. A session the caller cannot see answers not-found, as `ggui_runtime_pull` does. Called by the view (`_meta.ui.visibility: ['app']`, MCP Apps §401), never by the agent.",
    inputSchema,
    outputSchema,
    _meta: {
      ui: {
        // Spec §401: only an MCP Apps view (iframe) can call. The agent
        // does NOT see this tool on its tools/list.
        visibility: ['app'] as const,
      },
    },
    async handler(input, ctx: HandlerContext): Promise<GguiRefreshWsTokenOutput> {
      const source = ctx.authSource ?? null;
      // 1. Deployment-level: decided before the envelope is read.
      if (!deps.renderStore || !deps.verify || !deps.mint) {
        logRefused({ reason: 'not_supported', source });
        return {
          ok: false,
          code: 'BOOTSTRAP_NOT_SUPPORTED',
          message: 'refresh_ws_token: this server wires no live-credential refresh. The view keeps its current channel.',
        };
      }
      // 2. The envelope: signature, shape and kind, at any age.
      const parsed = z.object(inputSchema).safeParse(input);
      const verdict = parsed.success ? deps.verify(parsed.data.envelope) : { ok: false as const };
      if (!verdict.ok) {
        logRefused({ reason: 'invalid', source });
        return {
          ok: false,
          code: 'BOOTSTRAP_INVALID',
          message: 'refresh_ws_token: the envelope failed verification (tampered, malformed, or wrong kind).',
        };
      }
      // 3–4. The caller against the LIVE row: the read door's predicate.
      let stored: Awaited<ReturnType<GguiSessionStore['get']>>;
      try {
        stored = await deps.renderStore.get(verdict.sessionId);
      } catch (err) {
        logRefused({ reason: 'read_failed', source });
        throw err;
      }
      if (!stored || stored.appId !== verdict.appId || !renderReadAllowed(stored, ctx)) {
        logRefused({ reason: 'not_found', source });
        throw new GguiSessionNotFoundError(verdict.sessionId);
      }
      // 5. A fresh root credential for the session.
      const minted = deps.mint(stored.id, stored.appId);
      logRefreshed({
        sessionId: stored.id,
        appId: stored.appId,
        source,
        rootAgeSec: Math.max(0, Math.floor(Date.now() / 1000) - verdict.rootIat),
      });
      return { ok: true, envelope: minted.token, expiresAt: minted.expiresAt };
    },
  });
}
