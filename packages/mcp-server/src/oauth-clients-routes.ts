/**
 * Console OAuth-client management routes (the "Connected Apps"
 * surface). Phase 1 of the Connected Apps slice — list + revoke, no
 * manual create yet.
 *
 *   GET    /ggui/console/oauth-clients       — list (oldest-first by createdAt)
 *   DELETE /ggui/console/oauth-clients/:id   — revoke (idempotent)
 *
 * Mounted only when both console + OAuth are enabled — there's
 * nothing to manage if OAuth is off, and the management surface
 * belongs to the operator-facing console plane (not the public
 * OAuth metadata endpoints). Same-origin posture: no bearer auth,
 * matches sibling console routes (`/ggui/console/registry`,
 * `/ggui/console/blueprints/cached/...`).
 *
 * Revoke caveat — see OAuthStorage.deleteClient JSDoc: revoke
 * deletes the registration but doesn't invalidate in-flight
 * access tokens (the current paste-key flow has access_token ===
 * paired bearer).
 */

import type { Express } from "express";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";
import type { OAuthStorage } from "./oauth.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** OAuth storage the management surface lists/revokes against. */
  readonly oauthStorage: OAuthStorage;
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * Mount `GET /ggui/console/oauth-clients` +
 * `DELETE /ggui/console/oauth-clients/:clientId` onto the express
 * app. Returns nothing — the routes self-register.
 */
export function mountOAuthClientsRoutes(opts: MountOptions): void {
  const { app, oauthStorage, logger } = opts;

  app.get("/ggui/console/oauth-clients", async (_req, res) => {
    applyDevtoolSecurityHeaders(res);
    try {
      const clients = await oauthStorage.listClients();
      // Project to a wire shape: explicitly list every field we
      // intend to expose so an unrelated `ClientRecord` field
      // addition doesn't accidentally leak through this endpoint.
      res.json({
        clients: clients.map((c) => ({
          clientId: c.clientId,
          clientName: c.clientName ?? null,
          redirectUris: c.redirectUris,
          createdAt: c.createdAt,
        })),
      });
    } catch (err) {
      logger.warn("console_oauth_clients_list_failed", {
        error: String(err),
      });
      res.status(500).json({
        error: "list_failed",
        message:
          err instanceof Error
            ? `Client list failed — ${err.message}`
            : `Client list failed — ${String(err)}`,
      });
    }
  });

  app.delete("/ggui/console/oauth-clients/:clientId", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const clientId = req.params["clientId"];
    if (typeof clientId !== "string" || clientId.length === 0) {
      res.status(400).json({
        error: "missing_client_id",
        message:
          "clientId required in path segment (e.g. DELETE /ggui/console/oauth-clients/abc123).",
      });
      return;
    }
    try {
      await oauthStorage.deleteClient(clientId);
      // 204 whether the id was present or not — `deleteClient`
      // is idempotent at the storage layer (matches DELETE
      // /blueprints/cached/:id semantics).
      res.status(204).end();
    } catch (err) {
      logger.warn("console_oauth_clients_delete_failed", {
        error: String(err),
        clientId,
      });
      res.status(500).json({
        error: "delete_failed",
        message:
          err instanceof Error
            ? `Client delete failed — ${err.message}`
            : `Client delete failed — ${String(err)}`,
      });
    }
  });
}
