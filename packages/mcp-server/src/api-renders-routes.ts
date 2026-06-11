/**
 * wsToken-gated render read routes (R6 + R7).
 *
 * R6 — GET /api/sessions/:sessionId/state?wsToken=<token>
 *
 * Auth'd snapshot read of the current render state, returning the
 * same slice envelope as the wire `_meta` (a single
 * `{"ai.ggui/render": {...}}` slice — Phase B collapsed the prior
 * session + stack-item pair). Polling clients call this on a fixed
 * interval (registry-level polling — see R6 library refactor) to
 * pick up changes when WS is blocked at the host's CSP layer.
 *
 * wsToken-gated: same credential as the live-channel WS upgrade
 * (`?wsToken=<token>` on `/ws`). Drift-free with the WS surface —
 * the iframe-runtime already has the token from the bootstrap
 * envelope; no separate refresh path needed.
 *
 * Distinct from `/r/:shortCode` (JSON branch):
 *   - `/r/...` was shortCode-gated (bearer-by-obscurity; anyone with
 *     the URL could read). R5 deleted that surface entirely.
 *   - `/api/sessions/.../state` is wsToken-gated (HMAC-signed,
 *     short-TTL, scoped to sessionId+appId). Survives R5.
 *
 * R7 — GET /api/sessions/:sessionId/events?wsToken=&sinceSequence=N&limit=M
 *
 * Cursor-replay read from the GguiSessionEvent ledger. Returns events
 * with `seq > sinceSequence`, up to `limit` (default 100, max 500).
 *
 * Unification: WS subscribe's `sinceSequence` cursor and this HTTP
 * endpoint read from the SAME ledger via the same `listEventsSince`
 * GguiSessionStore method. Different transports, same cursor model —
 * that's R7's payoff.
 *
 * Auth: wsToken-gated, identical posture to /state.
 *
 * Responses (/events):
 *   - 200 — `{events, lastSequence, hasMore}` (matches
 *     `EventsResponse` from @ggui-ai/protocol/integrations/mcp-apps).
 *   - 401 — wsToken missing / invalid / wrong-scope.
 *   - 404 — sessionId does not resolve.
 *   - 410 — `{reason: 'REPLAY_HORIZON_PASSED', currentSequence}` when
 *     `sinceSequence` is below the server's replay horizon OR strictly
 *     greater than `lastSequence` (cursor is from a stale deployment
 *     or the render was reset). Clients re-mount from /state.
 */

import type { AppMetadataStore, CodeStore, GguiSessionStore } from "@ggui-ai/mcp-server-core";
import { verifyToken } from "@ggui-ai/mcp-server-core";
import {
  deriveContractBundle,
  derivePublicEnvProjection,
  deriveRenderMeta,
} from "@ggui-ai/mcp-server-handlers/renders";
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  type McpAppAiGguiRenderMeta,
} from "@ggui-ai/protocol/integrations/mcp-apps";
import type { Express } from "express";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** GguiSession store both routes read from. */
  readonly renderStore: GguiSessionStore;
  /** Shared HMAC secret the wsToken query credential verifies against. */
  readonly secret: string;
  /** Per-app metadata store for the publicEnv projection (optional). */
  readonly appMetadataStore?: AppMetadataStore;
  /** Operator-picked theme preset id stamped on /state reads. */
  readonly themeId?: string;
  /** Operator-picked theme mode stamped on /state reads. */
  readonly themeMode?: McpAppAiGguiRenderMeta["themeMode"];
  /** Content-addressable store for codeUrl / validatorsUrl emission. */
  readonly codeStore?: CodeStore;
  /** Operator-configured public origin for absolute URL composition. */
  readonly publicBaseUrl?: string;
  /** Live-mode credential minter — fresh trio on every /state read. */
  readonly mintBootstrap?: (
    sessionId: string,
    appId: string
  ) => { wsUrl: string; token: string; expiresAt: string };
  /** Per-request runtime-bundle URL resolver (tunnel/proxy aware). */
  readonly resolveRuntimeUrl: () => string;
  /** Structured logger for store-read failures. */
  readonly logger: Logger;
}

/**
 * Mount `GET /api/sessions/:sessionId/state` +
 * `GET /api/sessions/:sessionId/events` onto the express app.
 * Returns nothing — the routes self-register.
 */
export function mountApiRendersRoutes(opts: MountOptions): void {
  const {
    app,
    renderStore,
    secret,
    appMetadataStore,
    themeId,
    themeMode,
    codeStore,
    publicBaseUrl,
    mintBootstrap,
    resolveRuntimeUrl,
    logger,
  } = opts;

  app.get("/api/sessions/:sessionId/state", async (req, res) => {
    const sessionId = req.params["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      res.status(400).type("text/plain").send("sessionId required");
      return;
    }
    const wsTokenRaw = req.query["wsToken"];
    const wsToken = typeof wsTokenRaw === "string" ? wsTokenRaw : "";
    if (wsToken.length === 0) {
      res.status(401).type("text/plain").send("wsToken query required");
      return;
    }
    const verify = verifyToken(wsToken, secret, "ws");
    if (!verify.ok) {
      // 410 Gone for expired (matches the `BOOTSTRAP_EXPIRED`
      // semantics on the WS upgrade): the envelope was once valid
      // but has aged out; the iframe-runtime branches on this to
      // surface a refresh-vs-rehandshake prompt instead of treating
      // it as a hostile request.
      if (verify.reason === "expired") {
        res.status(410).type("text/plain").send("wsToken expired");
        return;
      }
      // 401 for tamper / wrong-kind / malformed / invalid-format —
      // the caller is broken or hostile; no info leak.
      res.status(401).type("text/plain").send("wsToken invalid");
      return;
    }
    // Tenancy gate: the wsToken's claimed sessionId MUST match the
    // URL's sessionId. A wsToken minted for render A MUST NOT read
    // render B's state.
    if (verify.claims.sessionId !== sessionId) {
      res.status(401).type("text/plain").send("wsToken scope mismatch");
      return;
    }
    let stored;
    try {
      stored = await renderStore.get(sessionId);
    } catch (err) {
      logger.warn("state_read_failed", {
        sessionId,
        error: String(err),
      });
      res.status(500).type("text/plain").send("internal error");
      return;
    }
    if (!stored) {
      // 404: render evicted / never existed. Polling clients fold
      // this into "stop polling" — distinct from 410 which signals
      // "credential aged out, refresh".
      res.status(404).type("text/plain").send("render not found");
      return;
    }
    // Tenancy gate (round 2): the wsToken's appId MUST match the
    // render's appId. Closes the case where a render is created
    // under a different appId than the token was minted for.
    if (verify.claims.appId !== stored.appId) {
      res.status(401).type("text/plain").send("wsToken scope mismatch");
      return;
    }
    // Phase B: a render IS the addressable unit. Pick directly from
    // the resolved GguiSession (no stack walk).
    const render = stored.render;
    const isMcpApps = render.type === "mcpApps";
    const isSystem = !isMcpApps && render.type === "system";
    const renderKind =
      isSystem && typeof (render as { kind?: string }).kind === "string"
        ? (render as { kind: string }).kind
        : undefined;
    // Build render-slice meta. Mirror render.resultMeta's shape so
    // the iframe-runtime parser admits identical envelopes regardless
    // of which surface served them. `lastSequence` is the load-bearing
    // R6 addition: polling clients use it to initialize the R7 /events
    // cursor (`?sinceSequence=N`) aligned with the WS stream.
    const view = !isMcpApps ? deriveRenderMeta(render) : undefined;
    let statePublicEnv: Readonly<Record<string, string>> | undefined;
    if (appMetadataStore && !isMcpApps) {
      try {
        const appRecord = await appMetadataStore.get(stored.appId);
        statePublicEnv = derivePublicEnvProjection(render, appRecord?.publicEnv);
      } catch {
        // Silent — wrappers calling getPublicEnv throw clearly.
      }
    }
    // Live-mode credential trio. Always minted fresh on /state reads
    // so the iframe-runtime gets a long-TTL token + the host learns
    // `wsUrl` (the CSP-permitted WebSocket origin). Without this,
    // any caller of /state — including the restore-bootstrap path in
    // every host (claude.ai, ChatGPT, our sample-agent) — receives a
    // render slice missing `wsUrl`. CSP `connect-src` then omits the
    // `ws://` scheme, the browser blocks the upgrade, and props_update
    // never reaches the iframe. The render-commit handler already
    // stamps this trio on its resultMeta; mirroring here closes the
    // drift.
    const liveTrio = mintBootstrap ? mintBootstrap(stored.id, stored.appId) : undefined;
    // Polling URL — the iframe-runtime's R6 polling-fallback path
    // composes its fetch URL from `render.pollingUrl`. The /state
    // endpoint IS that URL, so we stamp it here; without it the
    // iframe-runtime can't fall back when the WS upgrade fails.
    const requestHostForPolling = req.get("host") ?? "";
    const pollingBase = publicBaseUrl
      ? publicBaseUrl.replace(/\/$/, "")
      : `${req.protocol}://${requestHostForPolling}`;
    const pollingUrl = `${pollingBase}/api/sessions/${encodeURIComponent(stored.id)}/state`;
    // Static-component delivery via codeUrl (the same content-addressable
    // channel the code routes serve). Polling clients are render-capable
    // and need the URL to mount/refresh the static-component variant.
    let renderCodeUrl: string | undefined;
    let renderCodeHash: string | undefined;
    let renderContractHash: string | undefined;
    let renderValidatorsUrl: string | undefined;
    if (!isSystem && !isMcpApps && codeStore) {
      const code = (render as { componentCode?: string }).componentCode;
      if (typeof code === "string" && code.length > 0) {
        try {
          const hash = codeStore.hashOf(code);
          await codeStore.put(hash, code);
          renderCodeHash = hash;
          const requestHost = req.get("host") ?? "";
          const base = publicBaseUrl
            ? publicBaseUrl.replace(/\/$/, "")
            : `${req.protocol}://${requestHost}`;
          renderCodeUrl = `${base}/code/${hash}.js`;
        } catch {
          // Silent — caller falls back to live-mode delivery.
        }
        try {
          const bundle = await deriveContractBundle(render);
          if (bundle) {
            await codeStore.put(bundle.contractHash, bundle.bundleSource);
            renderContractHash = bundle.contractHash;
            const requestHost = req.get("host") ?? "";
            const base = publicBaseUrl
              ? publicBaseUrl.replace(/\/$/, "")
              : `${req.protocol}://${requestHost}`;
            renderValidatorsUrl = `${base}/contract/${bundle.contractHash}.js`;
          }
        } catch {
          // Silent — server-side gate remains authoritative.
        }
      }
    }
    // Phase B: single flat ai.ggui/render slice — render + visible-
    // bits surface fields merged into one shape.
    const renderMeta: McpAppAiGguiRenderMeta = {
      sessionId: stored.id,
      appId: stored.appId,
      runtimeUrl: resolveRuntimeUrl(),
      ...(liveTrio !== undefined
        ? {
            wsUrl: liveTrio.wsUrl,
            wsToken: liveTrio.token,
            expiresAt: liveTrio.expiresAt,
          }
        : {}),
      pollingUrl,
      ...(themeId !== undefined ? { themeId } : {}),
      ...(themeMode !== undefined ? { themeMode } : {}),
      // Per-app theme overlay projected by `deriveRenderMeta` from the
      // render's `theme` sidecar — same field the render result-meta
      // carries, so a /state read returns the identical overlay.
      ...(view?.theme !== undefined ? { theme: view.theme } : {}),
      ...(view?.gadgets !== undefined && view.gadgets.length > 0 ? { gadgets: view.gadgets } : {}),
      ...(statePublicEnv !== undefined && Object.keys(statePublicEnv).length > 0
        ? { publicEnv: statePublicEnv }
        : {}),
      ...(view?.permissionsPolicy !== undefined && view.permissionsPolicy.length > 0
        ? { permissionsPolicy: view.permissionsPolicy }
        : {}),
      // R6 — load-bearing ledger cursor. Always stamped on /state
      // reads so polling clients can position the R7 /events cursor.
      lastSequence: stored.eventSequence,
      // Visible-bits surface merged onto the single render slice.
      ...(renderKind !== undefined ? { kind: renderKind } : {}),
      ...(renderCodeUrl !== undefined
        ? {
            codeUrl: renderCodeUrl,
            ...(renderCodeHash !== undefined ? { codeHash: renderCodeHash } : {}),
          }
        : {}),
      ...(view?.propsJson !== undefined ? { propsJson: view.propsJson } : {}),
      ...(view?.contextSlots !== undefined ? { contextSlots: view.contextSlots } : {}),
      ...(renderContractHash !== undefined && renderValidatorsUrl !== undefined
        ? {
            contractHash: renderContractHash,
            validatorsUrl: renderValidatorsUrl,
          }
        : {}),
    };
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: renderMeta,
    });
  });

  app.get("/api/sessions/:sessionId/events", async (req, res) => {
    const sessionId = req.params["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      res.status(400).type("text/plain").send("sessionId required");
      return;
    }
    const wsTokenRaw = req.query["wsToken"];
    const wsToken = typeof wsTokenRaw === "string" ? wsTokenRaw : "";
    if (wsToken.length === 0) {
      res.status(401).type("text/plain").send("wsToken query required");
      return;
    }
    const verify = verifyToken(wsToken, secret, "ws");
    if (!verify.ok) {
      if (verify.reason === "expired") {
        res.status(410).type("text/plain").send("wsToken expired");
        return;
      }
      res.status(401).type("text/plain").send("wsToken invalid");
      return;
    }
    if (verify.claims.sessionId !== sessionId) {
      res.status(401).type("text/plain").send("wsToken scope mismatch");
      return;
    }
    // Parse + validate sinceSequence (required, non-negative integer)
    // and limit (optional, 1..500, default 100).
    //
    // sinceSequence is REQUIRED — explicit cursor reads only. A missing
    // query is a caller bug (no sensible default; `0` means "replay
    // everything" which we don't want to fire unintentionally).
    const sinceSequenceRaw = req.query["sinceSequence"];
    if (typeof sinceSequenceRaw !== "string" || sinceSequenceRaw.length === 0) {
      res
        .status(400)
        .type("text/plain")
        .send("sinceSequence query required (non-negative integer)");
      return;
    }
    const sinceSequence = Number(sinceSequenceRaw);
    if (!Number.isInteger(sinceSequence) || sinceSequence < 0) {
      res.status(400).type("text/plain").send("sinceSequence must be a non-negative integer");
      return;
    }
    const limitRaw = req.query["limit"];
    let limit = 100;
    if (typeof limitRaw === "string" && limitRaw.length > 0) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        res.status(400).type("text/plain").send("limit must be an integer in [1, 500]");
        return;
      }
      limit = parsed;
    }
    let result;
    try {
      result = await renderStore.listEventsSince(sessionId, sinceSequence, limit);
    } catch (err) {
      logger.warn("events_read_failed", {
        sessionId,
        error: String(err),
      });
      res.status(500).type("text/plain").send("internal error");
      return;
    }
    if (result === null) {
      // 404 — render not found. Distinct from 410 (cursor stale on
      // a live render) so polling clients can branch.
      res.status(404).type("text/plain").send("render not found");
      return;
    }
    // Tenancy gate (round 2): the wsToken's appId MUST match the
    // render's appId. We need the render record to check — fetch
    // it. listEventsSince validated the render exists.
    const stored = await renderStore.get(sessionId);
    if (!stored) {
      res.status(404).type("text/plain").send("render not found");
      return;
    }
    if (verify.claims.appId !== stored.appId) {
      res.status(401).type("text/plain").send("wsToken scope mismatch");
      return;
    }
    // Replay-horizon gate. Two cases collapse to REPLAY_HORIZON_PASSED:
    //   (a) sinceSequence < horizonSeq — events evicted (cloud TTL,
    //       in-mem never).
    //   (b) sinceSequence > lastSequence — cursor from a different
    //       deployment / reset render; the server has no events
    //       beyond what it knows, and we can't safely advance.
    if (sinceSequence > result.lastSequence) {
      res.status(410).type("application/json").json({
        reason: "REPLAY_HORIZON_PASSED",
        currentSequence: result.lastSequence,
      });
      return;
    }
    if (sinceSequence < result.horizonSeq) {
      res.status(410).type("application/json").json({
        reason: "REPLAY_HORIZON_PASSED",
        currentSequence: result.lastSequence,
      });
      return;
    }
    // GguiSessionEvent is now the unified wire-shape ledger primitive
    // (Wave 7 of flatten-render-identity, 2026-05-28). The store
    // returns events in protocol-canonical shape (seq + type +
    // timestamp[ISO] + data); no projection needed.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      events: result.events,
      lastSequence: result.lastSequence,
      hasMore: result.hasMore,
    });
  });
}
