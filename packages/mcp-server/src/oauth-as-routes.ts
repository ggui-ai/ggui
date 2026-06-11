/**
 * OAuth 2.1 + PKCE + DCR route family (per MCP spec 2025-06-18+).
 *
 *   GET  /.well-known/oauth-protected-resource           — RFC 9728 metadata
 *   GET  <pathPrefix>/:appId/.well-known/oauth-protected-resource
 *        — per-app metadata (mounted only with `perAppRouting`)
 *   GET  /.well-known/oauth-authorization-server         — RFC 8414 metadata
 *   POST /oauth/register                                 — RFC 7591 DCR
 *   GET  /oauth/authorize                                — consent page
 *   POST /oauth/authorize                                — consent submit
 *   POST /oauth/token                                    — token exchange
 *
 * The handlers themselves live in `./oauth.ts`; this module owns the
 * Express mounting only. Mounted when the composer enables OAuth —
 * without it, pure-bearer clients still work but OAuth-discovery
 * clients (Claude Desktop, claude.ai, Goose, etc.) bail with
 * "couldn't reach".
 */

import type { AuthAdapter, PairingService } from "@ggui-ai/mcp-server-core";
import type { Express } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import {
  handleAuthorizationServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleProtectedResourceMetadata,
  handleRegister,
  handleToken,
  type OAuthConfig,
  type OAuthStorage,
} from "./oauth.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Resolved OAuth config (issuer override, validateResource, …). */
  readonly oauthConfig: OAuthConfig;
  /** Client / code / token storage the handlers persist into. */
  readonly oauthStorage: OAuthStorage;
  /** Universal MCP endpoint path — the default RFC 9728 resource. */
  readonly universalMcpPath: string;
  /**
   * Per-tenant URL routing shape. When configured, a second
   * well-known endpoint mounts under the same path prefix the
   * per-app `/mcp` handler lives on.
   */
  readonly perAppRouting?: {
    readonly paramName: string;
    readonly pathPrefix?: string;
  };
  /** Auth adapter the consent-submit handler resolves bearers against. */
  readonly auth: AuthAdapter;
  /**
   * Late-bound pairing-service reference. The pairing service is
   * constructed AFTER these routes mount (declaration-order in the
   * composer), so the consent-submit handler reads through a getter
   * on every request. Safe because requests only arrive after
   * `listen()`, which is strictly after composition completes.
   */
  readonly getPairingService: () => PairingService | null;
}

/**
 * Mount the OAuth discovery + auth + token endpoints onto the express
 * app. Also flips `trust proxy` on — nginx-ingress + ALB both
 * terminate TLS upstream; without trust-proxy the metadata advertises
 * `http://` instead of `https://` which breaks PKCE (browsers refuse
 * insecure flows). Returns nothing — the routes self-register.
 */
export function mountOAuthAuthorizationServerRoutes(opts: MountOptions): void {
  const {
    app,
    oauthConfig,
    oauthStorage,
    universalMcpPath,
    perAppRouting,
    auth,
    getPairingService,
  } = opts;

  // `trust proxy` so req.protocol + req.host honor X-Forwarded-Proto +
  // X-Forwarded-Host.
  app.set("trust proxy", true);

  app.get("/.well-known/oauth-protected-resource", (req, res) =>
    handleProtectedResourceMetadata(req, res, oauthConfig, universalMcpPath)
  );
  // Per-app protected-resource metadata (RFC 9728 per-resource
  // discovery). When `perAppRouting` is configured,
  // mount a second well-known endpoint under the same path prefix
  // the per-app `/mcp` handler lives on. Each `appId` gets its own
  // metadata document with `resource: ${issuer}${pathPrefix}/${appId}`
  // so claude.ai's discovery flow against `mcp.ggui.ai/apps/<appId>`
  // sees a per-app resource rather than the universal one. The
  // shared `authorization_servers: [issuer]` lets the auth server
  // (also us) issue tokens bound to either resource via RFC 8707
  // resource indicators.
  if (perAppRouting !== undefined) {
    const { paramName, pathPrefix = "" } = perAppRouting;
    // `path-to-regexp` v8 (express@5) removed the `:param(pattern)`
    // inline-regex route syntax — registering one throws at startup.
    // Per-app routes now mount with a PLAIN named param; `paramPattern`
    // is enforced by a single `app.param` validator (registered with
    // the per-app MCP route in the MCP-endpoint family) that 404s any
    // value failing a full-anchored match. Express resolves `app.param`
    // callbacks at dispatch time for any route declaring the param,
    // regardless of registration order, so this well-known route
    // inherits the check even though the validator is wired elsewhere.
    //
    // `req.params` can't be indexed by the runtime `paramName` under
    // the v8 param-key inference, so pin the params type to the plain
    // string dictionary (`ParamsDictionary`) — the legitimate
    // single-value param shape — so the `paramName` lookup resolves
    // to `string`.
    app.get<ParamsDictionary>(
      `${pathPrefix}/:${paramName}/.well-known/oauth-protected-resource`,
      (req, res) => {
        const appId = req.params[paramName];
        if (typeof appId !== "string" || appId.length === 0) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        handleProtectedResourceMetadata(req, res, oauthConfig, `${pathPrefix}/${appId}`);
      }
    );
  }
  app.get("/.well-known/oauth-authorization-server", (req, res) =>
    handleAuthorizationServerMetadata(req, res, oauthConfig)
  );
  app.post("/oauth/register", (req, res) => {
    void handleRegister(req, res, oauthConfig, oauthStorage);
  });
  app.get("/oauth/authorize", (req, res) => {
    void handleAuthorizeGet(req, res, oauthConfig, oauthStorage);
  });
  app.post("/oauth/authorize", (req, res) => {
    void handleAuthorizePost(req, res, oauthConfig, oauthStorage, auth, getPairingService());
  });
  app.post("/oauth/token", (req, res) => {
    void handleToken(req, res, oauthStorage);
  });
}
