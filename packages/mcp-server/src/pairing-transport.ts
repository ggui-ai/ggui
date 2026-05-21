/**
 * Pairing transport — HTTP routes that complete a viewer↔server pairing
 * handshake, mint codes on admin trigger, and revoke active pairings.
 *
 * Three routes (all opt-in via `createGguiServer({ pairing })`):
 *
 *   POST /pair                      — public. Body `{code, deviceName}`.
 *                                     Returns `{pairingId, token, serverName,
 *                                     deviceName}`. No auth — pairing IS
 *                                     the bootstrap for future auth.
 *
 *   POST /admin/pair/init           — admin. Bearer auth → builder only.
 *                                     Returns `{code, codeExpiresAt,
 *                                     serverName}`.
 *
 *   POST /admin/pair/:pairingId/revoke
 *                                   — admin. Bearer auth → builder only.
 *                                     Immediate revocation of a minted
 *                                     pairing. Idempotent — revoking
 *                                     a pairingId that does not exist
 *                                     returns the same `{ok: true}`
 *                                     envelope. Delegates to
 *                                     {@link PairingService.revokePairing};
 *                                     `onTokenRevoked` unregisters the
 *                                     token from the active adapter so
 *                                     subsequent `/mcp` calls fail with
 *                                     401 via the canonical
 *                                     `No valid credentials` envelope.
 *
 * The transport is thin by construction — it delegates every stateful
 * decision to the supplied {@link PairingService}. Error mapping is the
 * only transport-level concern:
 *
 *   - Body validation failure → 400 with `{code: 'bad_request', ...}`.
 *   - Service throws on mismatched / expired / missing code → 401 with
 *     `{code: 'pairing_rejected', ...}`.
 *   - Any other service failure → 500 with `{code: 'internal', ...}`.
 *
 * Routes are mounted on the existing Express app the server already
 * owns — no sub-router, no second server surface.
 */
import type { Express, Request, Response } from 'express';
import type { AuthAdapter, PairingService } from '@ggui-ai/mcp-server-core';
import { resolveIdentity, UnauthenticatedError } from './auth.js';
import type { Logger } from './logger.js';

/** Default URL path the pairing-completion route is mounted at. */
export const DEFAULT_PAIRING_PATH = '/pair';

/**
 * Default URL path the admin-init route is mounted at. Keep prefixed
 * with `/admin/` so operators can firewall the whole family with one
 * rule when fronting the server behind a reverse proxy.
 */
export const DEFAULT_PAIRING_ADMIN_INIT_PATH = '/admin/pair/init';

/**
 * Default URL-template the admin-revoke route is mounted at. `:pairingId`
 * is the Express route parameter consumed by the handler; operators
 * firewalling behind a reverse proxy should match on the prefix
 * `/admin/pair/` — this template sits under that same umbrella as
 * {@link DEFAULT_PAIRING_ADMIN_INIT_PATH}.
 */
export const DEFAULT_PAIRING_ADMIN_REVOKE_PATH =
  '/admin/pair/:pairingId/revoke';

export interface PairingTransportOptions {
  /** Required. The pairing service the routes delegate to. */
  readonly pairing: PairingService;
  /**
   * Required. The same AuthAdapter the `/mcp` and live-channel endpoints
   * use. Gates the admin-init route; MUST resolve to a `builder`
   * identity for init to succeed.
   */
  readonly auth: AuthAdapter;
  /** Structured logger. Child loggers are derived per-route. */
  readonly logger: Logger;
  /**
   * URL path for the public completion route. Defaults to `/pair`.
   */
  readonly path?: string;
  /**
   * URL path for the admin init route. Defaults to
   * `/admin/pair/init`. Pass `null` to disable the route entirely —
   * embedded hosts that trigger `initPairing()` programmatically via
   * `GguiServer.pairingService` may not want an HTTP surface.
   */
  readonly adminInitPath?: string | null;
  /**
   * URL-template for the admin revoke route. Defaults to
   * `/admin/pair/:pairingId/revoke`. Pass `null` to disable the route
   * entirely — embedded hosts that trigger `revokePairing()`
   * programmatically may not want an HTTP surface. Mount symmetry
   * with `adminInitPath`: if a caller disables one, they frequently
   * disable both.
   */
  readonly adminRevokePath?: string | null;
}

/**
 * Mount the pairing routes onto an existing Express app. Idempotent is
 * NOT a goal here — call once per server; mounting twice registers the
 * routes twice.
 */
export function mountPairingTransport(
  app: Express,
  opts: PairingTransportOptions,
): void {
  const path = opts.path ?? DEFAULT_PAIRING_PATH;
  const adminInitPath =
    opts.adminInitPath === undefined
      ? DEFAULT_PAIRING_ADMIN_INIT_PATH
      : opts.adminInitPath;
  const adminRevokePath =
    opts.adminRevokePath === undefined
      ? DEFAULT_PAIRING_ADMIN_REVOKE_PATH
      : opts.adminRevokePath;

  // --- POST /pair ---
  //
  // No auth. Expects JSON `{code, deviceName}`. Either field missing or
  // non-string → 400. Service rejection (bad/expired/consumed code) →
  // 401. Success → 200 with the `PairingCompletion` shape the viewer
  // stores verbatim.
  app.post(path, async (req: Request, res: Response) => {
    const reqLogger = opts.logger.child({ route: 'POST ' + path });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body['code'] === 'string' ? body['code'] : undefined;
    const deviceName =
      typeof body['deviceName'] === 'string' ? body['deviceName'] : undefined;
    const remoteAddress = req.socket.remoteAddress ?? undefined;

    if (!code || !deviceName) {
      reqLogger.debug?.('pair_bad_request', {
        hasCode: code !== undefined,
        hasDeviceName: deviceName !== undefined,
      });
      res.status(400).json({
        error: {
          code: 'bad_request',
          message:
            'POST /pair requires a JSON body with string `code` and `deviceName`.',
        },
      });
      return;
    }

    try {
      const completion = await opts.pairing.completePairing({
        code,
        deviceName,
        ...(remoteAddress ? { remoteAddress } : {}),
      });
      reqLogger.info('pair_completed', {
        pairingId: completion.pairingId,
        deviceName: completion.deviceName,
      });
      res.status(200).json(completion);
    } catch (err) {
      // The service's thrown Error messages describe the mismatch
      // precisely but aren't safe to surface verbatim (code values
      // would leak into logs). Collapse to one code + one message.
      reqLogger.warn('pair_rejected', { error: String(err) });
      res.status(401).json({
        error: {
          code: 'pairing_rejected',
          message:
            'Pairing code is invalid, expired, or has already been consumed.',
        },
      });
    }
  });

  // --- POST /admin/pair/init ---
  //
  // Bearer-authenticated. Only builder identities may mint codes — the
  // operator triggering a code mint is by definition the server owner.
  // User identities (if any ever land on the OSS tier) are rejected.
  if (adminInitPath) {
    app.post(adminInitPath, async (req: Request, res: Response) => {
      const reqLogger = opts.logger.child({ route: 'POST ' + adminInitPath });
      try {
        const identity = await resolveIdentity(opts.auth, req);
        if (identity.identity.kind !== 'builder') {
          reqLogger.warn('admin_init_forbidden', {
            identityKind: identity.identity.kind,
          });
          res.status(403).json({
            error: {
              code: 'forbidden',
              message:
                'POST /admin/pair/init requires a builder identity.',
            },
          });
          return;
        }
      } catch (err) {
        if (err instanceof UnauthenticatedError) {
          reqLogger.warn('admin_init_unauthenticated', {
            reason: err.message,
          });
          res.status(401).json({
            error: {
              code: 'unauthenticated',
              message: err.message,
            },
          });
          return;
        }
        reqLogger.error('admin_init_unexpected_error', {
          error: String(err),
        });
        res.status(500).json({
          error: { code: 'internal', message: 'Internal server error' },
        });
        return;
      }

      try {
        const init = await opts.pairing.initPairing();
        reqLogger.info('admin_init_minted', {
          codeExpiresAt: init.codeExpiresAt,
        });
        res.status(200).json(init);
      } catch (err) {
        reqLogger.error('admin_init_failed', { error: String(err) });
        res.status(500).json({
          error: { code: 'internal', message: 'Internal server error' },
        });
      }
    });
  }

  // --- POST /admin/pair/:pairingId/revoke ---
  //
  // Bearer-authenticated builder-only — mirrors `/admin/pair/init`'s
  // identity gate. Delegates to `PairingService.revokePairing`, which
  // the in-memory reference is idempotent about (revoking a missing
  // pairingId is a no-op, NOT a 404 — the HTTP surface preserves that
  // so an admin cleanup loop is safe to re-run). The service's
  // `onTokenRevoked` callback is the load-bearing side-effect: it
  // unregisters the bearer from the active AuthAdapter, so a
  // subsequent `/mcp` call with the revoked token fails at
  // `resolveIdentity` with the canonical JSON-RPC 401 envelope.
  //
  // Response envelope on success: `{ok: true, pairingId}`. Thin by
  // design — the service returns void, so the route asserts the
  // operation completed without surfacing internal state.
  if (adminRevokePath) {
    app.post(adminRevokePath, async (req: Request, res: Response) => {
      const reqLogger = opts.logger.child({
        route: 'POST ' + adminRevokePath,
      });
      const pairingId = req.params['pairingId'];
      if (typeof pairingId !== 'string' || pairingId.length === 0) {
        reqLogger.debug?.('pair_revoke_bad_request', {});
        res.status(400).json({
          error: {
            code: 'bad_request',
            message:
              'POST /admin/pair/:pairingId/revoke requires a non-empty `pairingId` path parameter.',
          },
        });
        return;
      }

      try {
        const identity = await resolveIdentity(opts.auth, req);
        if (identity.identity.kind !== 'builder') {
          reqLogger.warn('admin_revoke_forbidden', {
            identityKind: identity.identity.kind,
            pairingId,
          });
          res.status(403).json({
            error: {
              code: 'forbidden',
              message:
                'POST /admin/pair/:pairingId/revoke requires a builder identity.',
            },
          });
          return;
        }
      } catch (err) {
        if (err instanceof UnauthenticatedError) {
          reqLogger.warn('admin_revoke_unauthenticated', {
            reason: err.message,
            pairingId,
          });
          res.status(401).json({
            error: { code: 'unauthenticated', message: err.message },
          });
          return;
        }
        reqLogger.error('admin_revoke_unexpected_error', {
          error: String(err),
          pairingId,
        });
        res.status(500).json({
          error: { code: 'internal', message: 'Internal server error' },
        });
        return;
      }

      try {
        await opts.pairing.revokePairing(pairingId);
        reqLogger.info('admin_revoke_completed', { pairingId });
        res.status(200).json({ ok: true, pairingId });
      } catch (err) {
        reqLogger.error('admin_revoke_failed', {
          error: String(err),
          pairingId,
        });
        res.status(500).json({
          error: { code: 'internal', message: 'Internal server error' },
        });
      }
    });
  }
}
