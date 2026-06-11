/**
 * Admin-gated keys plane.
 *
 *   POST /ggui/console/admin-login    — bearer → cookie exchange.
 *   GET  /ggui/console/keys           — list pairings + plaintext token.
 *   POST /ggui/console/keys           — mint a new pairing programmatically.
 *   DELETE /ggui/console/keys/:id     — revoke a pairing (idempotent).
 *
 * Why the gate exists: the keys plane renders plaintext bearer
 * tokens minted by the pairing service. The persistence file
 * (`~/.ggui/keys.json` typically) already stores them in plaintext
 * — single-operator local-host threat model — so showing them in
 * a same-origin admin page is a UX, not a posture, change. BUT
 * operators expose `ggui serve` over Cloudflare tunnels for
 * claude.ai connector use, which removes "URL is unreachable from
 * the open internet" from the threat model. The admin token gates
 * the keys plane against random URL discovery.
 *
 * Scope discipline: the gate covers `/ggui/console/keys*` +
 * `/ggui/console/admin-login` ONLY. Other console routes
 * (registry, renders, cached blueprints, oauth-clients) are not
 * re-gated here — that's a separate audit slice. Adding a single-
 * path-prefix middleware avoids re-litigating the whole console
 * posture in one go.
 *
 * Auth shape: `Authorization: Bearer <admin-token>` header OR the
 * `ggui_console_admin` cookie (HttpOnly, sameSite=Lax, Secure when
 * the request arrived over TLS). Cookie is minted by
 * POST /ggui/console/admin-login on a successful token paste.
 */

import type { PairingService } from "@ggui-ai/mcp-server-core";
import type { Express, Request } from "express";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";

const ADMIN_COOKIE_NAME = "ggui_console_admin";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Resolved admin token gating the plane. */
  readonly adminToken: string;
  /** Pairing service the keys CRUD operates on. */
  readonly pairing: PairingService;
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * Mount the admin-login + keys routes onto the express app. Returns
 * nothing — the routes self-register.
 */
export function mountConsoleKeysRoutes(opts: MountOptions): void {
  const { app, adminToken, pairing, logger } = opts;

  const requestHasAdminAuth = (req: Request): boolean => {
    // Header path — `Authorization: Bearer <token>`. Constant-time
    // compare not needed: this is single-tenant local-host with a
    // local network attacker model; the token also has 72 bits of
    // entropy, so a timing-side-channel attack would still need
    // ~2^36 attempts on average to materialize. Skip the cost.
    const authHeader = req.headers["authorization"];
    if (typeof authHeader === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (match && match[1] === adminToken) return true;
    }
    // Cookie path — same name the admin-login route sets.
    const cookieHeader = req.headers["cookie"];
    if (typeof cookieHeader === "string") {
      for (const raw of cookieHeader.split(";")) {
        const trimmed = raw.trim();
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const name = trimmed.slice(0, eq);
        if (name !== ADMIN_COOKIE_NAME) continue;
        const value = decodeURIComponent(trimmed.slice(eq + 1));
        if (value === adminToken) return true;
      }
    }
    return false;
  };

  // Same-origin posture for cookie minting: req.secure is true when
  // the connecting socket is TLS, OR when an upstream proxy set
  // `X-Forwarded-Proto: https` AND express trust-proxy is enabled.
  // For zero-config local-host, trust-proxy is OFF and req.secure
  // reflects the literal socket. Operators behind a tunnel with
  // TLS termination at the edge get the cookie WITHOUT Secure
  // (intended — the in-pod request is plaintext HTTP). Browsers
  // still scope it to the origin via SameSite, which is the
  // primary CSRF protection here; Secure is a defense-in-depth
  // attribute, not load-bearing for this token.
  const buildAdminCookie = (req: Request, value: string): string => {
    const attrs = [
      `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}`,
      "Path=/",
      // 8-hour TTL — same posture as the console session cookie.
      // Operators staying in the keys page longer than that just
      // re-paste the admin token (printed on the boot banner).
      "Max-Age=28800",
      "SameSite=Lax",
      "HttpOnly",
    ];
    if (req.secure) attrs.push("Secure");
    return attrs.join("; ");
  };

  // POST /ggui/console/admin-login — bearer-paste → cookie exchange.
  // No auth gate: the request body IS the credential. On match,
  // we set the cookie and 204; on mismatch we 401. Pre-launch no-
  // backcompat: there's no rate-limiter wired in — this is a
  // local-host route, lock-out via wider posture (tunnel access
  // control, Cloudflare WAF) belongs to the operator.
  app.post("/ggui/console/admin-login", (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const body = req.body as { token?: unknown } | undefined;
    const candidate = typeof body?.token === "string" ? body.token : "";
    if (candidate.length === 0 || candidate !== adminToken) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    res.setHeader("Set-Cookie", buildAdminCookie(req, adminToken));
    res.status(204).end();
  });

  // Path-prefix gate. `app.use(path, mw)` runs `mw` for every
  // request whose path starts with `path` — express normalizes
  // trailing slashes / sub-paths so `/keys/abc` + `/keys` both
  // hit. We only mount the keys routes BELOW this so the gate is
  // genuinely the only ingress.
  app.use("/ggui/console/keys", (req, res, next) => {
    if (requestHasAdminAuth(req)) return next();
    applyDevtoolSecurityHeaders(res);
    res.status(401).json({ error: "admin_auth_required" });
  });

  // GET /ggui/console/keys — list pairings + plaintext bearer.
  // Wire shape: `{ keys: [{pairingId, deviceName, createdAt,
  // lastUsedAt?, token}] }`. Plaintext exposure is intentional;
  // see PairingWithToken JSDoc for the threat model.
  app.get("/ggui/console/keys", async (_req, res) => {
    applyDevtoolSecurityHeaders(res);
    try {
      const rows = await pairing.listPairingsWithTokens();
      res.json({
        keys: rows.map((row) => ({
          pairingId: row.pairingId,
          deviceName: row.deviceName,
          createdAt: row.createdAt,
          ...(row.lastUsedAt !== undefined ? { lastUsedAt: row.lastUsedAt } : {}),
          token: row.token,
        })),
      });
    } catch (err) {
      logger.warn("console_keys_list_failed", {
        error: String(err),
      });
      res.status(500).json({
        error: "list_failed",
        message:
          err instanceof Error
            ? `Keys list failed — ${err.message}`
            : `Keys list failed — ${String(err)}`,
      });
    }
  });

  // POST /ggui/console/keys — mint a fresh pairing without
  // round-tripping `initPairing` + `completePairing` from the SPA.
  // We do both server-side here: (1) initPairing to get a code,
  // (2) completePairing to consume it. Idiomatic for an admin-only
  // surface — the operator doesn't need a 6-digit-code typed in,
  // they're already authenticated by the admin token. Returns the
  // full `PairingCompletion` so the SPA can show the plaintext
  // bearer in a one-time copy callout.
  app.post("/ggui/console/keys", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const body = req.body as { deviceName?: unknown } | undefined;
    const deviceName = typeof body?.deviceName === "string" ? body.deviceName.trim() : "";
    if (deviceName.length === 0 || deviceName.length > 256) {
      res.status(400).json({
        error: "invalid_device_name",
        message: "`deviceName` is required (non-empty string, ≤256 chars).",
      });
      return;
    }
    try {
      const init = await pairing.initPairing();
      const completion = await pairing.completePairing({
        code: init.code,
        deviceName,
      });
      res.json({
        pairingId: completion.pairingId,
        token: completion.token,
        serverName: completion.serverName,
        deviceName: completion.deviceName,
      });
    } catch (err) {
      logger.warn("console_keys_mint_failed", {
        error: String(err),
      });
      res.status(500).json({
        error: "mint_failed",
        message:
          err instanceof Error ? `Mint failed — ${err.message}` : `Mint failed — ${String(err)}`,
      });
    }
  });

  // DELETE /ggui/console/keys/:pairingId — revoke (idempotent).
  app.delete("/ggui/console/keys/:pairingId", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const pairingId = req.params["pairingId"];
    if (typeof pairingId !== "string" || pairingId.length === 0) {
      res.status(400).json({
        error: "missing_pairing_id",
        message: "pairingId required in path segment (e.g. DELETE /ggui/console/keys/pair-1).",
      });
      return;
    }
    try {
      await pairing.revokePairing(pairingId);
      res.status(204).end();
    } catch (err) {
      logger.warn("console_keys_revoke_failed", {
        error: String(err),
        pairingId,
      });
      res.status(500).json({
        error: "revoke_failed",
        message:
          err instanceof Error
            ? `Revoke failed — ${err.message}`
            : `Revoke failed — ${String(err)}`,
      });
    }
  });
}
