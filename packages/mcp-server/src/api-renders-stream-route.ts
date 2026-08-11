/**
 * wsToken-gated SSE live stream (the ladder's middle rung).
 *
 * GET /api/sessions/:sessionId/stream?wsToken=<token>[&sinceSequence=N][&fromSeq=M]
 *
 * Server-Sent Events delivery of the SAME ChannelFrame `{type,
 * payload}` JSON the live-channel WS pushes — for hosts whose CSP
 * blocks WebSocket upgrades but allows same-origin HTTP. The route
 * registers a transport-neutral subscriber into the channel server via
 * `attachExternalSubscriber`, so every fan-out plane WS subscribers
 * ride (StreamFanout live tail, `props_update` / `render` /
 * `drain_ack` walks, external broadcasts) reaches SSE subscribers with
 * zero per-frame branching.
 *
 * Framing contract:
 *   - Every `data:` line is EXACTLY one ChannelFrame JSON — byte-same
 *     shape as the WS push (default event type, so `EventSource`'s
 *     `onmessage` fires).
 *   - `id:` = decimal GguiSessionEvent ledger seq, stamped ONLY on
 *     ledger-backed `render_event` replay frames (and the
 *     REPLAY_HORIZON_PASSED error frame, which carries the fresh
 *     high-water mark). Live frames are id-less — same ephemeral
 *     posture as WS; reconnects re-mount state from the ack snapshot.
 *     The browser's `Last-Event-ID` therefore lands on the exact
 *     cursor space `/events?sinceSequence=N` reads.
 *   - First write after headers: `retry: 3000`.
 *   - Heartbeat: comment line `: hb` every {@link SSE_HEARTBEAT_MS}
 *     (under ALB's 60s idle default); each tick doubles as a render-
 *     expiry probe.
 *
 * Cursor spaces: `Last-Event-ID` (browser-stamped on auto-reconnect)
 * WINS over `?sinceSequence=`; the query seeds the first connect
 * (EventSource cannot set headers). `?fromSeq=` mirrors
 * `SubscribePayload.fromSeq` for the stream-buffer plane — note it is
 * frozen in the EventSource URL, so duplicate `data` frames after an
 * auto-reconnect are expected; ledger + stream deliveries are
 * documented at-least-once and clients dedupe by seq.
 *
 * Auth: wsToken query gate cloned verbatim from `/state`
 * (`api-renders-routes.ts`) — 401 missing/invalid/wrong-scope, 410
 * expired, 404 unknown render, plus 503 when the channel is not yet
 * constructed (pre-listen only). All gates run BEFORE any event-stream
 * byte: EventSource fails the connection permanently on non-200, which
 * is the client ladder's SSE→polling demotion signal.
 */

import type { AuthResult, GguiSessionStore } from "@ggui-ai/mcp-server-core";
import { verifyToken } from "@ggui-ai/mcp-server-core";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import type { Express, Response } from "express";
import type { GguiSessionChannelServer } from "./ggui-session-channel.js";
import type { SubscriberSink } from "./ggui-session-channel/internal-types.js";
import type { Logger } from "./logger.js";

/**
 * Heartbeat cadence (25s). Under ALB's 60s idle default with 2x+
 * headroom; each tick also probes render expiry so an evicted /
 * expired render ends the stream instead of idling forever.
 */
export const SSE_HEARTBEAT_MS = 25_000;

/**
 * SSE-backed {@link SubscriberSink}. Frames serialize to
 * `data: <ChannelFrame JSON>\n\n` (JSON.stringify never emits raw
 * newlines, so a single `data:` line is safe); `resumeId` prepends an
 * `id: <seq>\n` line so the browser's `Last-Event-ID` advances on
 * ledger-backed frames only.
 */
class SseSink implements SubscriberSink {
  private readonly res: Response;
  private readonly logger: Logger;
  /**
   * Invoked exactly once, from `end()`, BEFORE the response closes —
   * the route assigns its teardown (clear heartbeat + detach) here so
   * a channel-initiated `end` (pod shutdown, expiry probe) tears the
   * subscriber down through the same single path as a client close.
   */
  onEnd: (() => void) | undefined;

  constructor(res: Response, logger: Logger) {
    this.res = res;
    this.logger = logger;
  }

  isOpen(): boolean {
    return !this.res.writableEnded && !this.res.destroyed;
  }

  write(frame: WebSocketMessage, opts?: { readonly resumeId?: string }): void {
    if (!this.isOpen()) return;
    try {
      const idLine = opts?.resumeId !== undefined ? `id: ${opts.resumeId}\n` : "";
      this.res.write(`${idLine}data: ${JSON.stringify(frame)}\n\n`);
    } catch (err) {
      // Same posture as the WS send guard: per-frame write failures
      // are logged, never propagated — a dead transport must not fail
      // the fan-out caller.
      this.logger.warn("sse_write_failed", { error: String(err) });
    }
  }

  end(reason: "service_restart" | "session_expired"): void {
    const teardown = this.onEnd;
    this.onEnd = undefined;
    teardown?.();
    this.logger.info("sse_stream_ended", { reason });
    if (!this.res.writableEnded && !this.res.destroyed) {
      this.res.end();
    }
  }
}

/** Strict non-negative decimal integer parse; `null` on anything else. */
function parseNonNegativeInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export interface MountApiRendersStreamRouteOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /** GguiSession store the gate + expiry probe read from. */
  readonly renderStore: GguiSessionStore;
  /** Shared HMAC secret the wsToken query credential verifies against. */
  readonly secret: string;
  /**
   * Late-bound channel accessor — `createGguiSessionChannelServer`
   * runs after route mounting, so the route resolves the channel per
   * request (same pattern as `stream.channelProvider`). `null` is
   * possible pre-listen only; the route answers 503.
   */
  readonly channelProvider: () => GguiSessionChannelServer | null;
  /** Heartbeat override for tests. Defaults to {@link SSE_HEARTBEAT_MS}. */
  readonly heartbeatMs?: number;
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * Mount `GET /api/sessions/:sessionId/stream` onto the express app.
 * Returns nothing — the route self-registers.
 */
export function mountApiRendersStreamRoute(opts: MountApiRendersStreamRouteOptions): void {
  const { app, renderStore, secret, channelProvider, logger } = opts;
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS;

  app.get("/api/sessions/:sessionId/stream", async (req, res) => {
    // ── Phase 1: plain-HTTP gates, BEFORE any event-stream byte ──
    // (EventSource fails permanently on non-200 — the demotion signal.)
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
      // 410 Gone for expired (matches `BOOTSTRAP_EXPIRED` semantics on
      // the WS upgrade): once-valid but aged out — refresh, don't
      // treat as hostile. 401 for tamper / wrong-kind / malformed.
      if (verify.reason === "expired") {
        res.status(410).type("text/plain").send("wsToken expired");
        return;
      }
      res.status(401).type("text/plain").send("wsToken invalid");
      return;
    }
    // Tenancy gate: the wsToken's claimed sessionId MUST match the
    // URL's sessionId.
    if (verify.claims.sessionId !== sessionId) {
      res.status(401).type("text/plain").send("wsToken scope mismatch");
      return;
    }
    // Cursor queries — validated pre-headers so a caller bug is an
    // honest 400, not a silently-ignored replay.
    const sinceSequenceRaw = req.query["sinceSequence"];
    let sinceSequence: number | undefined;
    if (typeof sinceSequenceRaw === "string" && sinceSequenceRaw.length > 0) {
      const parsed = parseNonNegativeInt(sinceSequenceRaw);
      if (parsed === null) {
        res.status(400).type("text/plain").send("sinceSequence must be a non-negative integer");
        return;
      }
      sinceSequence = parsed;
    }
    const fromSeqRaw = req.query["fromSeq"];
    let fromSeq: number | undefined;
    if (typeof fromSeqRaw === "string" && fromSeqRaw.length > 0) {
      const parsed = parseNonNegativeInt(fromSeqRaw);
      if (parsed === null) {
        res.status(400).type("text/plain").send("fromSeq must be a non-negative integer");
        return;
      }
      fromSeq = parsed;
    }
    // Last-Event-ID (browser-stamped on auto-reconnect) WINS over the
    // query seed. Malformed header → warn + fall back to the query
    // (never a 4xx: the header is browser-controlled, and failing the
    // reconnect permanently over a polyfill quirk would strand the
    // client on a working credential).
    const lastEventIdRaw = req.get("last-event-id");
    if (typeof lastEventIdRaw === "string" && lastEventIdRaw.length > 0) {
      const parsed = parseNonNegativeInt(lastEventIdRaw);
      if (parsed === null) {
        logger.warn("sse_last_event_id_malformed", {
          sessionId,
          lastEventId: lastEventIdRaw,
        });
      } else {
        sinceSequence = parsed;
      }
    }
    let stored;
    try {
      stored = await renderStore.get(sessionId);
    } catch (err) {
      logger.warn("sse_stream_read_failed", { sessionId, error: String(err) });
      res.status(500).type("text/plain").send("internal error");
      return;
    }
    if (!stored) {
      // 404: render evicted / never existed — the browser's
      // auto-reconnect lands here after an expiry-probe stream end,
      // failing the EventSource permanently (clean rung exit).
      res.status(404).type("text/plain").send("render not found");
      return;
    }
    // Tenancy gate (round 2): the wsToken's appId MUST match the
    // render's appId.
    if (verify.claims.appId !== stored.appId) {
      res.status(401).type("text/plain").send("wsToken scope mismatch");
      return;
    }
    const channel = channelProvider();
    if (channel === null) {
      // Pre-listen only: mcpApps ⇒ renderChannel is enforced at
      // composition, so a running server always has a channel. Honest
      // guard rather than a crash on a boot-race request.
      logger.warn("sse_stream_channel_unavailable", { sessionId });
      res.status(503).type("text/plain").send("live channel not ready");
      return;
    }

    // ── Phase 2: open the event stream ──
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Connection", "keep-alive");
    // Parity with /state — the iframe fetches cross-origin from the
    // host page's origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    // Tell nginx-family proxies not to buffer the stream. Self-hosters
    // behind proxies that ignore this must configure pass-through.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write("retry: 3000\n\n");

    const sink = new SseSink(res, logger);

    // Single idempotent teardown shared by every exit path: client
    // close, channel-initiated sink.end (pod shutdown / expiry probe),
    // attach failure.
    let detachFn: (() => void) | null = null;
    let torn = false;
    const teardown = (): void => {
      if (torn) return;
      torn = true;
      clearInterval(heartbeat);
      detachFn?.();
    };
    sink.onEnd = teardown;
    res.on("close", teardown);

    // Heartbeat: `: hb` comment (invisible to the EventSource JS API,
    // visible to proxies/ALBs) + render-expiry probe. A vanished or
    // expired render ends the stream; the auto-reconnect then hits the
    // 404 pre-gate for the permanent verdict. Store-read failure on a
    // tick keeps streaming (availability over freshness; next tick
    // retries).
    const heartbeat = setInterval(() => {
      if (!sink.isOpen()) {
        teardown();
        return;
      }
      res.write(": hb\n\n");
      void (async () => {
        let probe;
        try {
          probe = await renderStore.get(sessionId);
        } catch (err) {
          logger.warn("sse_expiry_probe_failed", { sessionId, error: String(err) });
          return;
        }
        if (!probe || probe.expiresAt <= Date.now()) {
          sink.end("session_expired");
        }
      })();
    }, heartbeatMs);
    heartbeat.unref?.();

    // Identity synthesized from the verified wsToken claims — the same
    // bootstrap shape the WS subscribe path builds: a render-scoped
    // credential, not a person (see subscribe.ts on why it must never
    // become the row's subject).
    const identity: AuthResult = {
      identity: {
        kind: "user",
        userId: sessionId,
        workspaceId: stored.appId,
        roles: [],
      },
      source: "apikey",
    };
    try {
      const { detach } = await channel.attachExternalSubscriber({
        sessionId,
        appId: stored.appId,
        identity,
        sink,
        ...(sinceSequence !== undefined ? { sinceSequence } : {}),
        ...(fromSeq !== undefined ? { fromSeq } : {}),
      });
      detachFn = detach;
      if (torn) {
        // Client disconnected while the attach was in flight — the
        // teardown ran with no handle; undo the registration now.
        detach();
      }
    } catch (err) {
      // Lost race with render eviction (the pre-gate passed moments
      // ago) or a store failure inside the subscribe tail. Headers are
      // out, so no status rewrite — end the stream; the reconnect gets
      // the authoritative pre-gate verdict.
      logger.warn("sse_attach_failed", { sessionId, error: String(err) });
      teardown();
      sink.end("service_restart");
    }
  });
}
