/**
 * Liveness / readiness / authenticated-probe routes.
 *
 *   GET /ggui/live       — process-alive probe (200 whenever the event
 *                          loop can run a handler, regardless of
 *                          readiness).
 *   GET /ggui/health     — readiness probe; runs the operator-supplied
 *                          readiness checks and reports per-check
 *                          results, live-channel counts, and the
 *                          thread-transport durability claim.
 *   GET /ggui/auth-check — authenticated liveness. 204 when the bearer
 *                          resolves via the configured AuthAdapter,
 *                          401 otherwise (with `WWW-Authenticate` when
 *                          OAuth is enabled).
 *
 * Why live and health are separate: K8s livenessProbe + readinessProbe
 * have distinct semantics. Liveness asks "is the process alive?" and
 * a failure tells the kubelet to RESTART the pod. Readiness asks "is
 * the pod ready to receive traffic?" and a failure tells the service
 * to STOP ROUTING. Tying both probes to a single endpoint that gates
 * on dependency health (Redis, DDB, RAG) means a transient upstream
 * blip kills the pod entirely instead of just removing it from
 * rotation.
 *
 * Self-hoster wiring (K8s):
 *
 *   livenessProbe:  { httpGet: { path: '/ggui/live',   port } }
 *   readinessProbe: { httpGet: { path: '/ggui/health', port } }
 */

import type { AuthAdapter } from "@ggui-ai/mcp-server-core";
import type { Express, Request, Response } from "express";
import { resolveIdentity, UnauthenticatedError } from "./auth.js";
import type { ServerInfo } from "./build-mcp.js";
import type { GguiSessionChannelServer } from "./ggui-session-channel.js";
import type { Logger } from "./logger.js";
import { buildWwwAuthenticate, resolveIssuerUrl } from "./oauth.js";

/**
 * 1s per-check timeout — a hung dependency must not block the K8s
 * liveness probe, which itself runs on a short period. A timeout is
 * treated as a failed check; the dependency is degraded either way.
 */
const READINESS_CHECK_TIMEOUT_MS = 1_000;

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** Server identity — `/ggui/health` reports name + version. */
  readonly info: ServerInfo;
  /** Registered tool count reported on `/ggui/health`. */
  readonly toolCount: number;
  /** Operator-supplied readiness checks (empty = always ready). */
  readonly readinessChecks: ReadonlyArray<{
    readonly name: string;
    readonly check: () => boolean | Promise<boolean>;
  }>;
  /**
   * Late-bound live-channel reference. The channel is constructed
   * AFTER these routes mount (declaration-order in the composer), so
   * the health route reads through a getter on every request.
   */
  readonly getChannel: () => GguiSessionChannelServer | null;
  /**
   * Thread-transport presence + durability claim. Absent when the
   * server was booted without `threads:` (no persistent-chat routes
   * mounted).
   */
  readonly threads?: { readonly durability?: "durable" | "ephemeral" };
  /** Auth adapter `/ggui/auth-check` resolves bearers against. */
  readonly auth: AuthAdapter;
  /** Whether OAuth is enabled (adds `WWW-Authenticate` on 401). */
  readonly oauthEnabled: boolean;
  /** Operator-configured issuer URL override (OAuth). */
  readonly oauthIssuerUrl?: string;
  /** Structured logger for unexpected auth-check failures. */
  readonly logger: Logger;
}

/**
 * Mount `/ggui/live` + `/ggui/health` + `/ggui/auth-check` onto the
 * express app. Returns nothing — the routes self-register.
 */
export function mountHealthRoutes(opts: MountOptions): void {
  const { app, info, toolCount, readinessChecks, getChannel, threads, auth, oauthEnabled, logger } =
    opts;

  async function runReadinessChecks(): Promise<{
    readonly allReady: boolean;
    readonly results: Record<string, boolean>;
  }> {
    if (readinessChecks.length === 0) {
      return { allReady: true, results: {} };
    }
    const results: Record<string, boolean> = {};
    let allReady = true;
    await Promise.all(
      readinessChecks.map(async ({ name, check }) => {
        try {
          const ready = await Promise.race<boolean>([
            Promise.resolve().then(() => check()),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), READINESS_CHECK_TIMEOUT_MS)
            ),
          ]);
          results[name] = ready;
          if (!ready) allReady = false;
        } catch {
          results[name] = false;
          allReady = false;
        }
      })
    );
    return { allReady, results };
  }

  // No body needed for the kubelet's HTTP check (status code is the
  // signal), but a tiny JSON keeps the endpoint debuggable from a
  // shell. No `readinessChecks` invoked — keeping this probe cheap
  // is the point; any heavier work belongs in `/ggui/health`.
  app.get("/ggui/live", (_req, res) => {
    res.status(200).json({ status: "alive", server: info.name });
  });

  app.get("/ggui/health", (_req, res) => {
    void (async () => {
      const { allReady, results } = await runReadinessChecks();
      const body: Record<string, unknown> = {
        status: allReady ? "ok" : "degraded",
        server: info.name,
        version: info.version,
        tools: toolCount,
      };
      const channel = getChannel();
      if (channel) {
        body.channel = {
          path: channel.path,
          subscribers: channel.subscriberCount,
          renders: channel.renderCount,
        };
      }
      // Thread-transport presence + durability claim. When present,
      // `durability` is exactly what the caller declared — 'ephemeral'
      // by default so Portal does not silently hide its non-durable
      // caveat.
      if (threads) {
        body.threads = {
          enabled: true,
          durability: threads.durability ?? "ephemeral",
        };
      }
      if (Object.keys(results).length > 0) {
        body.checks = results;
      }
      res.status(allReady ? 200 : 503).json(body);
    })();
  });

  /**
   * Authenticated liveness probe.
   *
   * Identical auth semantics to `/mcp` (same AuthAdapter, same Bearer-
   * parsing) but with a flat 204 / 401 response shape, no body, no
   * render state. Designed for clients that need to distinguish
   * "server is up but my token is stale" from "server is unreachable".
   *
   * A Settings → Servers probe in a host client is the canonical
   * consumer: it hits `/ggui/health` first (open), then
   * `/ggui/auth-check` with the pairing token, and reports
   * `token-invalid` when the first succeeds but the second returns 401.
   *
   * No response body to keep the endpoint cheap — a 401 is the signal.
   * We deliberately skip the MCP error envelope shape used by `/mcp`
   * because this route is explicitly NOT part of the MCP wire.
   */
  app.get("/ggui/auth-check", async (req: Request, res: Response) => {
    try {
      await resolveIdentity(auth, req);
      res.status(204).end();
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        if (oauthEnabled) {
          // Auth-check is universal-only — no per-app variant route is
          // mounted, so the WWW-Authenticate always points at the
          // universal resource metadata. Symmetric with the universal
          // /mcp handler's 401 behavior.
          res.setHeader(
            "WWW-Authenticate",
            buildWwwAuthenticate(resolveIssuerUrl(req, opts.oauthIssuerUrl))
          );
        }
        res.status(401).end();
        return;
      }
      logger.error("auth_check_unexpected_error", { error: String(err) });
      res.status(500).end();
    }
  });
}
