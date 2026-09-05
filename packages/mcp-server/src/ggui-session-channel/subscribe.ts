/**
 * Subscribe / credential-path family for the live channel — upgrade-
 * time identity resolution across the three auth planes (bearer via
 * the AuthAdapter, ws-token bootstrap, console cookie) and the
 * `subscribe` handler itself: version handshake, bootstrap verify +
 * reconnect-credential mint, identity-default appId resolution,
 * dev-mode render provisioning, replay, registration, and the ack.
 */

import type {
  AuthAdapter,
  AuthResult,
  GguiSessionStore,
  GguiSessionStreamBuffer,
  StoredGguiSession,
  StreamFanout,
} from "@ggui-ai/mcp-server-core";
import type { AckPayload, SubscribePayload } from "@ggui-ai/protocol";
import { PROTOCOL_SCHEMA_VERSION, UPGRADE_REQUIRED } from "@ggui-ai/protocol";
import type { WebSocketMessage } from "@ggui-ai/protocol/transport/websocket";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import {
  defaultAppIdFromIdentity,
  resolveIdentityFromHeaders,
  UnauthenticatedError,
} from "../auth.js";
import type { Logger } from "../logger.js";
import type {
  ChannelSubscriptionState,
  Subscriber,
  SubscriberSink,
  UpgradeBindings,
} from "./internal-types.js";
import { createWsSink, type Outbound } from "./outbound.js";
import type { SubscriberLifecycle } from "./subscriber-lifecycle.js";

/**
 * Bootstrap-auth plumbing for the live-channel endpoint.
 *
 * The channel accepts a bootstrap credential on the `subscribe`
 * message (`SubscribePayload.wsToken`). When present:
 *
 *   1. `verify(token)` is called. Must return the bound
 *      `{sessionId, appId}` on success, or `null` on any failure
 *      (invalid sig, expired, wrong kind, replayed, etc.).
 *   2. The bound `sessionId` MUST match the one on the subscribe
 *      payload. Mismatches are rejected with a clean error.
 *   3. On success, the server mints a reconnect credential via
 *      `issueSessionToken(sessionId, appId)` and returns it in
 *      `AckPayload.sessionToken`. The iframe stores this for WS
 *      reconnects via the normal bearer path.
 *
 * Bootstrap auth is MUTUALLY EXCLUSIVE with the upstream `AuthAdapter`
 * bearer path at subscribe time — when a bootstrap token is present,
 * the identity resolved at the HTTP upgrade is IGNORED in favor of
 * the bootstrap-derived identity. This is intentional: MCP Apps
 * iframes don't have a long-lived bearer; the bootstrap IS the auth.
 */
/**
 * Verify failure shape — distinguished so the channel server can map
 * `'expired'` to `BOOTSTRAP_EXPIRED` (client SHOULD refresh) vs
 * `'invalid'` to `BOOTSTRAP_INVALID` (client MUST re-handshake).
 *
 * G14 (2026-05-23): bootstrap envelopes are no longer single-use. A
 * signature-valid + unexpired token authenticates EVERY subscribe
 * within the TTL window; transient WS drops reconnect without a fresh
 * handshake. Past expiry, the iframe MAY refresh via the
 * {@link refresh} surface; past the refresh window, fresh handshake.
 */
export type GguiSessionChannelBootstrapVerifyResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly appId: string;
    }
  | { readonly ok: false; readonly reason: "expired" | "invalid" };

/**
 * Result of {@link GguiSessionChannelBootstrap.refresh}.
 *
 *   - `ok: true`: caller swaps the old envelope for `token` and resumes.
 *   - `ok: false`: caller MUST re-handshake (refresh window closed,
 *     tampered envelope, etc.).
 */
export type GguiSessionChannelBootstrapRefreshResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt: string;
    }
  | { readonly ok: false; readonly reason: "window_closed" | "invalid" };

export interface GguiSessionChannelBootstrap {
  /**
   * Verify a `SubscribePayload.wsToken` token.
   *
   * Returns the bound identity on success, or a discriminated failure.
   * The channel server maps `'expired'` to `BOOTSTRAP_EXPIRED` so the
   * iframe can branch on refresh-vs-rehandshake, and `'invalid'` to
   * `BOOTSTRAP_INVALID` for tamper / format / kind failures (no
   * refresh on those).
   */
  verify(token: string): GguiSessionChannelBootstrapVerifyResult;
  /**
   * Mint a longer-lived reconnect credential to return in
   * `AckPayload.sessionToken`. Called only after a successful
   * `verify()` on a bootstrap subscribe.
   */
  issueSessionToken(sessionId: string, appId: string): string;
  /**
   * Refresh a (possibly-expired-but-signature-valid) bootstrap envelope
   * into a new envelope with a fresh TTL. Used by the
   * `ggui_runtime_refresh_ws_token` MCP tool — iframes that see their
   * bootstrap drift out of the TTL window swap in the refreshed
   * envelope without going back through `ggui_render`.
   *
   * Stateless: verifies HMAC against the same secret used at mint,
   * checks the refresh window against the ORIGINAL `iat`, and mints
   * a fresh bootstrap envelope bound to the SAME `(sessionId, appId)`.
   * Past the refresh window the result is `{ok:false, reason:
   * 'window_closed'}`; tampered envelopes are `{ok:false, reason:
   * 'invalid'}`.
   */
  refresh(token: string): GguiSessionChannelBootstrapRefreshResult;
}

/**
 * Cookie-based authentication for the live-channel upgrade. Used
 * exclusively by the same-origin console viewer; see
 * `console-auth.ts` for the single consumer today.
 */
export interface GguiSessionChannelCookieAuth {
  /**
   * Read the raw cookie value for THIS server's console cookie
   * from the incoming request headers. Returns `null` when the
   * cookie is absent or malformed.
   */
  readCookie(headers: import("node:http").IncomingHttpHeaders): string | null;
  /**
   * Verify a cookie value and return the bound render/app. Returns
   * `null` on any failure (signature, expiry, wrong kind). Never
   * throws.
   */
  verify(cookieValue: string): { sessionId: string; appId: string } | null;
}

export interface SubscribeDeps {
  readonly logger: Logger;
  /** Same `AuthAdapter` the `/mcp` endpoint uses (bearer plane). */
  readonly auth: AuthAdapter;
  readonly renderStore: GguiSessionStore;
  /** Outbound stream replay buffer — snapshot cursor + replay reads. */
  readonly streamBuffer: GguiSessionStreamBuffer;
  /** Live-tail pub/sub seam — one iterator minted per subscriber. */
  readonly streamFanout: StreamFanout;
  /** Bootstrap (ws-token) plumbing — see `GguiSessionChannelOptions.bootstrap`. */
  readonly bootstrap?: GguiSessionChannelBootstrap;
  /** Console cookie plumbing — see `GguiSessionChannelOptions.cookieAuth`. */
  readonly cookieAuth?: GguiSessionChannelCookieAuth;
  /** Identity → appId mapping — see `GguiSessionChannelOptions.appIdFromIdentity`. */
  readonly appIdFromIdentity?: (result: AuthResult) => string;
  /** Version-handshake policy — see `GguiSessionChannelOptions.versionPolicy`. */
  readonly versionPolicy?: "advisory" | "reject";
  readonly sendError: Outbound["sendError"];
  readonly register: SubscriberLifecycle["register"];
  readonly unregister: SubscriberLifecycle["unregister"];
}

/**
 * Arguments for {@link SubscribeHandlers.completeSubscribe} — the
 * transport-neutral subscribe tail. The auth head (WS: version
 * handshake + bootstrap verify; SSE: the HTTP wsToken pre-gate on
 * `/api/sessions/:sessionId/stream`) runs BEFORE this; the tail trusts
 * `stored` + `identity` as already-authorized.
 */
export type CompleteSubscribeArgs = {
  /** Resolved render row the subscriber binds to. */
  readonly stored: StoredGguiSession;
  /** Already-verified identity for the subscriber row. */
  readonly identity: AuthResult;
  /** Transport write surface the tail (and the pump) emits through. */
  readonly sink: SubscriberSink;
  /** GguiSessionEvent-ledger cursor — replays `render_event` frames when set. */
  readonly sinceSequence?: number;
  /** Stream-buffer cursor — replays `data` frames per policy when set. */
  readonly fromSeq?: number;
  /** Correlates the ack / error frames to a WS request. SSE has none. */
  readonly requestId?: string;
  /** Bootstrap-minted reconnect credential to stamp on the ack. */
  readonly sessionToken?: string;
} & (
  | {
      readonly transport: "ws";
      /** The socket — kept on the subscriber row for inbound dispatch. */
      readonly ws: WebSocket;
    }
  | { readonly transport: "sse" }
);

export interface SubscribeHandlers {
  /**
   * Resolve the connecting client's identity at HTTP-upgrade time,
   * across the three auth planes (bootstrap query-gate, console
   * cookie, bearer / `?token=`). Throws `UnauthenticatedError` to
   * reject the upgrade with 401.
   */
  resolveIdentityFromUpgrade(req: IncomingMessage): Promise<AuthResult>;
  /** Handle the `subscribe` message — see the module docstring. */
  handleSubscribe(
    ws: WebSocket,
    identity: AuthResult,
    message: WebSocketMessage & { type: "subscribe" },
    cookieBound?: { readonly sessionId: string; readonly appId: string }
  ): Promise<void>;
  /**
   * The transport-neutral subscribe tail, order preserved exactly:
   * stream-cursor snapshot → stream-buffer replay read → StreamFanout
   * iterator → register (pump starts) → ack → GguiSessionEvent-ledger
   * replay (`render_event` frames, `resumeId` = ledger seq) →
   * stream-replay `data` frames. WS `handleSubscribe` calls this after
   * its auth/provision head; SSE attaches call it via
   * `GguiSessionChannelServer.attachExternalSubscriber`.
   *
   * Returns a `detach` that idempotently unregisters the subscriber
   * (ends the pump, unhooks the StreamFanout, clears polling loops).
   */
  completeSubscribe(args: CompleteSubscribeArgs): Promise<{ readonly detach: () => void }>;
}

/**
 * Marker `userId` (and `workspaceId`) `resolveIdentityFromUpgrade`
 * returns for a bootstrap-gated upgrade — see the "WS-token gate"
 * comment there. It is a placeholder, not a verified identity:
 * `handleSubscribe` MUST reject a subscribe on this identity outright
 * unless the subscribe payload itself presents a `wsToken` that goes on
 * to verify (ggui#438a security review, C1). Never treat this marker as
 * authenticated for identity-default resolution or render provisioning.
 */
const BOOTSTRAP_PENDING_MARKER = "__bootstrap_pending__";

/** Is `identity` the unverified upgrade-time placeholder above? */
function isBootstrapPendingIdentity(identity: AuthResult): boolean {
  return identity.identity.kind === "user" && identity.identity.userId === BOOTSTRAP_PENDING_MARKER;
}

export function createSubscribeHandlers(deps: SubscribeDeps): SubscribeHandlers {
  async function resolveIdentityFromUpgrade(req: IncomingMessage): Promise<AuthResult> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // WS-token gate: when `?wsToken=` is present AND the channel is
    // configured with ws-token-auth plumbing, skip the AuthAdapter
    // entirely at upgrade. The real identity is established in
    // handleSubscribe when the subscribe payload's `wsToken` is
    // verified. This is how MCP Apps iframes connect — they can't set
    // Authorization headers, and the token model is subscribe-scoped
    // anyway.
    //
    // URL-gate here is NOT verification — it's a "don't reject the
    // upgrade for missing bearer" signal. The real verify runs at
    // subscribe time; an invalid token reaches that point and is
    // rejected with BOOTSTRAP_INVALID.
    if (deps.bootstrap && url.searchParams.has("wsToken")) {
      return {
        identity: {
          kind: "user",
          userId: BOOTSTRAP_PENDING_MARKER,
          workspaceId: BOOTSTRAP_PENDING_MARKER,
          roles: [],
        },
        source: "apikey",
      };
    }

    // Embedded-ui cookie gate. Consulted ONLY when the channel is
    // configured with cookie-auth plumbing AND no bootstrap is in
    // play. Unlike bootstrap, cookies ARE verified here: the single
    // consumer (console SPA) sets the cookie out-of-band via
    // `POST /ggui/console/session-cookie` and we do want to
    // reject the upgrade cleanly (HTTP 401 → browser WS error) when
    // the cookie is stale/missing, not carry a doomed handshake into
    // subscribe where the error surface is worse.
    //
    // On success, we stash the bound `{sessionId, appId}` on the
    // request so `handleSubscribe` can enforce that the subscribe
    // payload targets exactly those values. No synthesis from the
    // AuthAdapter — cookies ARE the auth signal.
    if (deps.cookieAuth) {
      const raw = deps.cookieAuth.readCookie(req.headers);
      if (raw) {
        const bound = deps.cookieAuth.verify(raw);
        if (bound) {
          (req as IncomingMessage & UpgradeBindings).__gguiCookieBound = bound;
          return {
            identity: { kind: "builder" },
            source: "apikey",
          };
        }
        // Cookie present but invalid — do NOT fall through to the
        // bearer path. An invalid cookie is a same-origin user error,
        // not a pass-through condition.
        throw new UnauthenticatedError("console cookie invalid");
      }
      // No cookie present → fall through to bearer path below. Mixed
      // deployments (pairing-token bearer + same-origin cookie for
      // viewer) are legal.
    }

    // Browsers can't set Authorization on native WebSocket. Fall back
    // to `?token=<jwt>` for web clients, matching the convention most
    // render-channel endpoints ship with. Server-side clients (Node
    // `ws`, tests) continue to set the header directly.
    if (!req.headers["authorization"]) {
      const token = url.searchParams.get("token");
      if (token) {
        req.headers["authorization"] = `Bearer ${token}`;
      }
    }
    return resolveIdentityFromHeaders(
      deps.auth,
      req.headers,
      req.socket?.remoteAddress ?? undefined
    );
  }

  async function handleSubscribe(
    ws: WebSocket,
    identity: AuthResult,
    message: WebSocketMessage & { type: "subscribe" },
    cookieBound?: { readonly sessionId: string; readonly appId: string }
  ): Promise<void> {
    const payload: SubscribePayload = message.payload;

    // Protocol-version handshake. Opt-in on the client side: absent
    // `supportedVersions` is legacy-pass-through. When present,
    // require the server's PROTOCOL_SCHEMA_VERSION to be in the
    // declared set — otherwise emit UPGRADE_REQUIRED.
    //
    //   - 'reject' (default): emit + close the connection. Canonical
    //     posture for first-party servers.
    //   - 'advisory' (opt-out): emit + keep the connection
    //     open (but stop the subscribe; no ack, no render work).
    //     Clients that ignore the code continue exactly as
    //     pre-handshake.
    //
    // Placed FIRST — before bootstrap verify (which consumes the
    // single-use bootstrap token per the GguiSessionChannelBootstrap
    // docstring) and before render lookup/creation (DB work).
    // Bootstrap iframes with a version mismatch must retry with a
    // fresh bootstrap token; burning the token on a mismatch the
    // client could detect by reading the version-negotiation spec
    // would be a footgun.
    if (
      Array.isArray(payload.supportedVersions) &&
      payload.supportedVersions.length > 0 &&
      !payload.supportedVersions.includes(PROTOCOL_SCHEMA_VERSION)
    ) {
      const policy: "advisory" | "reject" = deps.versionPolicy ?? "reject";
      deps.sendError(
        ws,
        UPGRADE_REQUIRED,
        `Server speaks ${PROTOCOL_SCHEMA_VERSION}; client declared ` +
          `supportedVersions=[${payload.supportedVersions.join(", ")}].`,
        message.requestId,
        {
          serverVersion: PROTOCOL_SCHEMA_VERSION,
          clientSupportedVersions: payload.supportedVersions,
          policy,
        }
      );
      deps.logger.warn("render_channel_version_mismatch", {
        sessionId: payload.sessionId,
        appId: payload.appId,
        serverVersion: PROTOCOL_SCHEMA_VERSION,
        clientSupportedVersions: payload.supportedVersions,
        policy,
      });
      if (policy === "reject") {
        try {
          ws.close();
        } catch {
          // best-effort — socket may already be closing
        }
      }
      return;
    }

    // C1 (ggui#438a security review): `identity` may be the
    // upgrade-time bootstrap-pending PLACEHOLDER (see
    // `resolveIdentityFromUpgrade`'s "WS-token gate" comment and
    // `isBootstrapPendingIdentity` above) — a "don't reject the
    // upgrade" signal, not a verified identity. If the subscribe
    // payload does not itself carry a `wsToken` to verify, this socket
    // has proven nothing about itself and MUST be rejected here —
    // never fall through to identity-default appId resolution or
    // dev-mode render provisioning on an unverified placeholder. A
    // present `payload.wsToken` is verified by the block immediately
    // below, which returns on any verify failure — so by the time this
    // function reaches appId resolution, every bootstrap-pending
    // identity has either been rejected or replaced by a verified one.
    if (
      isBootstrapPendingIdentity(identity) &&
      !(typeof payload.wsToken === "string" && payload.wsToken.length > 0)
    ) {
      deps.sendError(
        ws,
        "UNAUTHENTICATED",
        "Bootstrap-gated socket did not present a wsToken to verify at subscribe",
        message.requestId
      );
      return;
    }

    // WS-token-auth path. When `payload.wsToken` is present, the MCP
    // Apps iframe is asking us to authenticate it via the short-lived
    // token minted by `ggui_render`. This REPLACES the upgrade-time
    // AuthAdapter identity — iframes don't carry bearer tokens.
    // Mutually-exclusive on purpose.
    let effectiveIdentity: AuthResult = identity;
    let mintedSessionToken: string | undefined;
    let tokenBoundAppId: string | undefined;
    if (typeof payload.wsToken === "string" && payload.wsToken.length > 0) {
      if (!deps.bootstrap) {
        deps.sendError(
          ws,
          "BOOTSTRAP_NOT_SUPPORTED",
          "This server was not configured with ws-token-auth plumbing",
          message.requestId
        );
        return;
      }
      const verifyResult = deps.bootstrap.verify(payload.wsToken);
      if (!verifyResult.ok) {
        deps.logger.warn("render_channel_bootstrap_rejected", {
          sessionId: payload.sessionId,
          appId: payload.appId,
          reason: verifyResult.reason,
        });
        // G14 (2026-05-23): distinguish `expired` from `invalid` so the
        // iframe-side handler can branch on refresh-vs-rehandshake.
        // Tamper / format / kind failures collapse into BOOTSTRAP_INVALID
        // (no refresh path); expired-but-signed envelopes emit the
        // dedicated BOOTSTRAP_EXPIRED so the client knows to call
        // `ggui_runtime_refresh_ws_token`.
        if (verifyResult.reason === "expired") {
          deps.sendError(
            ws,
            "BOOTSTRAP_EXPIRED",
            "Bootstrap token expired — call ggui_runtime_refresh_ws_token or re-handshake",
            message.requestId
          );
        } else {
          deps.sendError(
            ws,
            "BOOTSTRAP_INVALID",
            "Bootstrap token invalid (bad signature, malformed, or wrong kind)",
            message.requestId
          );
        }
        return;
      }
      const bound = { sessionId: verifyResult.sessionId, appId: verifyResult.appId };
      if (bound.sessionId !== payload.sessionId) {
        deps.sendError(
          ws,
          "BOOTSTRAP_SESSION_MISMATCH",
          `Bootstrap token is bound to render '${bound.sessionId}' but subscribe targets '${payload.sessionId}'`,
          message.requestId
        );
        return;
      }
      // `payload.appId` is OPTIONAL on the wire (SPEC §12.2): under a
      // bound token, absence resolves to the token's bound appId — the
      // token binding IS the identity-default. Only a PRESENT value
      // that contradicts the binding is a mismatch.
      if (payload.appId !== undefined && payload.appId !== bound.appId) {
        deps.sendError(
          ws,
          "BOOTSTRAP_APP_MISMATCH",
          `Bootstrap token is bound to app '${bound.appId}' but subscribe targets '${payload.appId}'`,
          message.requestId
        );
        return;
      }
      tokenBoundAppId = bound.appId;
      // Synthesize a minimal AuthResult from the bootstrap claims.
      // The subscriber row needs an identity for logging and roster
      // inspection; the bootstrap-derived identity is a first-class
      // citizen for the lifetime of this subscription.
      effectiveIdentity = {
        identity: {
          kind: "user",
          userId: bound.sessionId,
          workspaceId: bound.appId,
          roles: [],
        },
        source: "apikey",
      };
      // Mint the reconnect credential now — before create/observe
      // work — so a downstream failure doesn't leave the client with
      // no way to resume.
      mintedSessionToken = deps.bootstrap.issueSessionToken(bound.sessionId, bound.appId);
      deps.logger.info("render_channel_bootstrap_accepted", {
        sessionId: bound.sessionId,
        appId: bound.appId,
      });
    }

    // Identity-default appId resolution (SPEC §12.2): `payload.appId`
    // is optional on the wire. Absent ⇒ resolve it from the
    // connection's authenticated identity BEFORE any store work —
    // exactly the rule the `/mcp` endpoint applies: a credential
    // binding wins (wsToken binds `(sessionId, appId)`; the console
    // cookie binds the same pair), else the deployment's identity →
    // appId mapping (`appIdFromIdentity`, defaulting to
    // `defaultAppIdFromIdentity`). The resolved value then flows
    // through the EXISTING app-scope gate + provisioning below — never
    // an `undefined` appId on a stored row.
    const effectiveAppId: string =
      payload.appId ??
      tokenBoundAppId ??
      cookieBound?.appId ??
      (deps.appIdFromIdentity ?? defaultAppIdFromIdentity)(effectiveIdentity);

    // Dev-mode render provisioning: look up first; if not present,
    // create with the client-provided id via the widened
    // CreateGguiSessionInput.id seam. Matches the hosted model's shape
    // (agent creates via ggui_render → client subscribes) in a single
    // step — production deployments tighten this by supplying an
    // AuthAdapter that mints render-scoped tokens on render.
    let stored = await deps.renderStore.get(payload.sessionId);
    if (stored) {
      if (stored.appId !== effectiveAppId) {
        deps.sendError(
          ws,
          "APP_MISMATCH",
          `GguiSession ${payload.sessionId} belongs to a different app`,
          message.requestId
        );
        return;
      }
    } else {
      try {
        // NO `userId` here, deliberately (#446). `effectiveIdentity`
        // above may be the bootstrap-synthesized identity whose
        // `userId` IS the sessionId — a render-scoped credential every
        // holder of the bootstrap token presents, not a person.
        // Threading it onto the row would bind the row's SUBJECT to
        // that credential, and the render-read gate would then pass
        // every bearer of the token as "the subject". The row acquires
        // its real subject later, from the agent's commit, via the
        // stores' if-not-exists semantics.
        stored = await deps.renderStore.create({
          id: payload.sessionId,
          appId: effectiveAppId,
        });
      } catch (err) {
        deps.sendError(
          ws,
          "SESSION_CREATE_FAILED",
          err instanceof Error ? err.message : String(err),
          message.requestId
        );
        return;
      }
    }

    // Transport-neutral tail — shared verbatim with the SSE attach
    // path (`attachExternalSubscriber`). The WS head above resolved
    // auth + render; the tail owns snapshot → replay → register →
    // ack → ledger replay → stream replay.
    await completeSubscribe({
      stored,
      identity: effectiveIdentity,
      sink: createWsSink(ws, deps.logger),
      transport: "ws",
      ws,
      ...(payload.sinceSequence !== undefined ? { sinceSequence: payload.sinceSequence } : {}),
      ...(payload.fromSeq !== undefined ? { fromSeq: payload.fromSeq } : {}),
      ...(message.requestId ? { requestId: message.requestId } : {}),
      ...(mintedSessionToken !== undefined ? { sessionToken: mintedSessionToken } : {}),
    });
  }

  async function completeSubscribe(
    args: CompleteSubscribeArgs
  ): Promise<{ readonly detach: () => void }> {
    const { stored, sink } = args;
    // Snapshot the outbound-stream cursor BEFORE registering the
    // subscriber. Any concurrent producer that calls sendToGguiSession
    // between here and registration gets seq > snapshotSeq, so the
    // subscriber will receive it via live fan-out (not via replay).
    //
    // This is race-safe in single-threaded JS: the next few lines run
    // synchronously up to `register(sub)`, and fan-out's per-subscriber
    // `seq <= replayCompletedSeq` guard takes care of the window.
    const snapshotSeq = await deps.streamBuffer.currentSeq(stored.id);

    // Phase B: a render IS the addressable unit, so the active item
    // is the resolved render's visible-bits surface itself.
    const activeItem = stored.render;

    // Reconnect: `fromSeq` present → replay per policy on declared
    // AND reserved channels. Fresh subscribe: `fromSeq` absent →
    // call with `fromSeq=0` + NO spec, so the buffer's spec-channel
    // walk contributes nothing (preserving the "initial state comes
    // from ack.render.props; stream channels are for updates after"
    // doctrine for agent-declared channels) but the reserved-channel
    // walk still surfaces server-pushed state that landed before the
    // subscriber attached.
    const activeStreamSpec =
      activeItem.type !== "mcpApps" && activeItem.type !== "system"
        ? activeItem.streamSpec
        : undefined;
    const replay =
      args.fromSeq !== undefined
        ? await deps.streamBuffer.replay(stored.id, args.fromSeq, activeStreamSpec)
        : await deps.streamBuffer.replay(stored.id, 0, undefined);

    // Subscribe to the StreamFanout BEFORE constructing the Subscriber:
    // the seam returns an AsyncIterable whose iterator we hand off; the
    // pump loop in `register` consumes it. Eager registration on the
    // seam side means any concurrent `streamFanout.publish` from this
    // point onward queues into our iterator — paired with the
    // replayCompletedSeq cursor below, that's race-free.
    const fanoutIter = deps.streamFanout.subscribe(stored.id)[Symbol.asyncIterator]();
    const base = {
      sessionId: stored.id,
      appId: stored.appId,
      identity: args.identity,
      connectedAt: Date.now(),
      replayCompletedSeq: snapshotSeq,
      iter: fanoutIter,
      // Per-subscriber channel-subscribe tracker. Populated
      // lazily by the `channel_subscribe` handler when the operator
      // wired `streamWebSocketLocalTools`; stays empty otherwise
      // (structurally so for SSE — no inbound channel).
      channelSubs: new Map<string, ChannelSubscriptionState>(),
      sink,
    };
    const sub: Subscriber =
      args.transport === "ws"
        ? { ...base, transport: "ws", ws: args.ws }
        : { ...base, transport: "sse" };
    deps.register(sub);
    deps.logger.info("render_channel_subscribed", {
      sessionId: stored.id,
      appId: stored.appId,
      identityKind: args.identity.identity.kind,
      transport: args.transport,
      fromSeq: args.fromSeq,
      snapshotSeq,
      replayCount: replay?.envelopes.length ?? 0,
      replayTruncated: replay?.truncated ?? false,
      bootstrap: args.sessionToken !== undefined,
    });

    const ackPayload: AckPayload = {
      sequence: stored.eventSequence,
      timestamp: Date.now(),
      session: stored.render,
      streamSeq: snapshotSeq,
      // Advertise the server's protocol version on every successful
      // subscribe ack (SPEC §11.2.2). Clients whose
      // CLIENT_SUPPORTED_VERSIONS doesn't contain this string surface
      // UpgradeRequiredError to their caller; clients that don't wire
      // the handshake ignore the field (legacy-pass-through).
      serverVersion: PROTOCOL_SCHEMA_VERSION,
      ...(replay?.truncated ? { replayTruncated: true } : {}),
      ...(args.sessionToken !== undefined ? { sessionToken: args.sessionToken } : {}),
    };
    sink.write({
      type: "ack",
      payload: ackPayload,
      ...(args.requestId ? { requestId: args.requestId } : {}),
    });

    // R7 — GguiSessionEvent ledger replay. When `args.sinceSequence` is
    // present, fetch events with `seq > sinceSequence` from the per-
    // render ledger and emit each as a `render_event` wire frame
    // BEFORE the per-channel stream-buffer replay. Consumers dispatch
    // by `event.type` to fold the wire-frame-equivalent handler
    // (render/props_update/etc.) — same cursor model as the HTTP
    // `/api/sessions/:id/events?sinceSequence=N` endpoint.
    //
    // Each replay frame carries `resumeId` = the ledger seq — the SSE
    // sink stamps it as the `id:` field so the browser's Last-Event-ID
    // lands on the exact same cursor space; the WS sink ignores it.
    //
    // Pagination: a hasMore-loop over 100-event pages (the HTTP
    // route's default page size). Strict superset of the previous
    // single-page-100 WS behavior.
    //
    // Horizon gate: a cursor below the server's replay horizon OR
    // above `lastSequence` (stale from a different deployment) emits
    // an error frame with `code: 'REPLAY_HORIZON_PASSED'` and skips
    // the replay. The frame carries `resumeId` = lastSequence — a
    // dispatched id-bearing frame advances the browser's Last-Event-ID
    // to the fresh high-water mark, and the ack snapshot already
    // re-mounted state. Client recovery: re-mount from a fresh /state
    // read (WS) / the already-delivered ack (SSE).
    if (args.sinceSequence !== undefined) {
      const sinceSeq = args.sinceSequence;
      if (sinceSeq < 0 || !Number.isInteger(sinceSeq)) {
        sink.write({
          type: "error",
          payload: {
            code: "INVALID_SINCE_SEQUENCE",
            message: "sinceSequence must be a non-negative integer",
          },
          ...(args.requestId ? { requestId: args.requestId } : {}),
        });
      } else {
        let cursor = sinceSeq;
        let firstPage = true;
        for (;;) {
          const ledger = await deps.renderStore.listEventsSince(stored.id, cursor, 100);
          if (ledger === null) {
            // GguiSession disappeared between resolve and ledger read —
            // already handled by the broader error envelope path;
            // nothing to do here.
            break;
          }
          if (firstPage && (sinceSeq > ledger.lastSequence || sinceSeq < ledger.horizonSeq)) {
            sink.write(
              {
                type: "error",
                payload: {
                  code: "REPLAY_HORIZON_PASSED",
                  message: `cursor ${sinceSeq} is outside replayable range [${ledger.horizonSeq}, ${ledger.lastSequence}]`,
                  details: { currentSequence: ledger.lastSequence },
                },
                ...(args.requestId ? { requestId: args.requestId } : {}),
              },
              { resumeId: String(ledger.lastSequence) }
            );
            break;
          }
          firstPage = false;
          for (const event of ledger.events) {
            // GguiSessionEvent is now the wire-shape ledger primitive
            // (Wave 7 of flatten-render-identity, 2026-05-28); no
            // projection — emit the store's row directly.
            sink.write({ type: "render_event", payload: event }, { resumeId: String(event.seq) });
            cursor = event.seq;
          }
          // Defensive: an empty page with hasMore would loop forever;
          // the store contract never produces it, but a broken adapter
          // must not spin the server.
          if (!ledger.hasMore || ledger.events.length === 0) break;
        }
      }
    }

    // Send replay frames AFTER the ack. Ordering by `seq` ASC — the
    // buffer returns them pre-sorted. Client sees ack(streamSeq=N) →
    // up to N replay `data` frames → live tail (seq > N). No explicit
    // "replay end" marker is needed; the client uses envelope.seq as
    // the single source of truth for ordering.
    if (replay) {
      for (const env of replay.envelopes) {
        sink.write({ type: "data", payload: env });
      }
    }

    return {
      detach: () => {
        deps.unregister(sub);
      },
    };
  }

  return { resolveIdentityFromUpgrade, handleSubscribe, completeSubscribe };
}
