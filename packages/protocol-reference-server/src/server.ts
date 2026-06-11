/**
 * `ReferenceServer` — the minimal WS live-channel server this package
 * exports. Honest scope: SPEC §12.2 wire (subscribe incl. the §12.2
 * appId-tenancy MUST → APP_MISMATCH), version handshake, the single
 * action-routing model (action → consume-buffer append → ack with
 * sequence; undeclared actions AND schema-violating payloads rejected
 * with CONTRACT_VIOLATION per SPEC §4.6 receipt validation), and
 * `host_context_observed` persistence onto `GguiSession.hostContext`.
 * That's it.
 *
 * No auth (accepts any bearer). No persistence. No bundle loading.
 * The whole point is to be narrow enough that the vendor-neutral
 * separation claim (Protocol #6) is empirically grounded — if this
 * server passes `@ggui-ai/protocol-conformance`, the protocol has
 * no implicit `@ggui-ai/mcp-server` coupling.
 *
 * Wire-field note: the GguiSession identity field is the canonical SPEC
 * field `sessionId` — see {@link GguiSession} for the identity name used
 * throughout this package.
 */
import { createServer, type Server as HttpServer } from 'node:http';

import { PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

import { handleAction, parseActionFrame } from './action-router.js';
import {
  handleHostContextObserved,
  parseHostContextObservedFrame,
} from './host-context.js';
import { isRecord } from './is-record.js';
import {
  DEPLOYMENT_DEFAULT_APP_ID,
  GguiSessionStore,
  type Subscriber,
} from './render.js';

export interface ReferenceServerOptions {
  /** Port to bind. `0` = ephemeral — use {@link ReferenceServer.port}
   *  to read the resolved port after start. */
  readonly port: number;
  /** Host interface. Default `127.0.0.1`. */
  readonly host?: string;
  /**
   * If `true` (default), reject subscribes whose `supportedVersions`
   * does not include `PROTOCOL_SCHEMA_VERSION` by emitting
   * `UPGRADE_REQUIRED` AND closing the underlying WebSocket. This is
   * the default first-party posture. Set to `false` for an 'advisory'
   * posture — the error frame is emitted but the connection stays
   * open (used by tests that need the mismatch emission observable
   * without closing the socket).
   */
  readonly strictVersionPolicy?: boolean;
  /**
   * Override the server-advertised protocol schema version. Defaults to
   * `PROTOCOL_SCHEMA_VERSION` (current canonical). Used by the
   * `server-version-override` conformance directive — a Path-A test
   * boots a sidecar `ReferenceServer` with a deliberately mismatched
   * version so the kit's `version-mismatch` fixture can drive the
   * UPGRADE_REQUIRED emission entirely over WS.
   *
   * Discipline: this field is for conformance-test fault injection ONLY.
   * Production-use of the reference server (none planned — see
   * package non-goals) MUST default to canonical.
   */
  readonly versionOverride?: string;
}

export class ReferenceServer {
  readonly renders = new GguiSessionStore();

  private readonly options: Required<ReferenceServerOptions>;
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private boundPort: number | null = null;

  constructor(options: ReferenceServerOptions) {
    this.options = {
      port: options.port,
      host: options.host ?? '127.0.0.1',
      strictVersionPolicy: options.strictVersionPolicy ?? true,
      versionOverride: options.versionOverride ?? PROTOCOL_SCHEMA_VERSION,
    };
  }

  /**
   * Protocol schema version the server advertises in subscribe ack
   * frames + UPGRADE_REQUIRED error frames. Defaults to
   * `PROTOCOL_SCHEMA_VERSION`; overridable via
   * {@link ReferenceServerOptions.versionOverride} for conformance
   * fault injection.
   */
  get advertisedVersion(): string {
    return this.options.versionOverride;
  }

  /** Resolved port (valid after `start()` resolves). */
  get port(): number {
    if (this.boundPort === null) {
      throw new Error('reference-server: port not resolved — did you await start()?');
    }
    return this.boundPort;
  }

  /** Base URL for the kit's `runConformance({serverUrl})`. */
  get baseUrl(): string {
    return `http://${this.options.host}:${this.port}`;
  }

  async start(): Promise<void> {
    const http = createServer();
    const wss = new WebSocketServer({ server: http, path: '/ws' });

    wss.on('connection', (socket) => {
      this.handleConnection(socket);
    });

    await new Promise<void>((done, fail) => {
      const onError = (err: Error): void => {
        http.off('listening', onListening);
        fail(err);
      };
      const onListening = (): void => {
        http.off('error', onError);
        done();
      };
      http.once('error', onError);
      http.once('listening', onListening);
      http.listen(this.options.port, this.options.host);
    });

    const address = http.address();
    if (address === null || typeof address === 'string') {
      throw new Error('reference-server: failed to resolve bound port');
    }
    this.boundPort = address.port;
    this.http = http;
    this.wss = wss;
  }

  async stop(): Promise<void> {
    const wss = this.wss;
    const http = this.http;
    if (wss !== null) {
      await new Promise<void>((done) => wss.close(() => done()));
      this.wss = null;
    }
    if (http !== null) {
      await new Promise<void>((done) => http.close(() => done()));
      this.http = null;
    }
    this.boundPort = null;
  }

  // ===========================================================================
  // Connection handling
  // ===========================================================================

  private handleConnection(socket: WebSocket): void {
    // Subscribe state is per-connection — one WS may subscribe to
    // one render at a time. Re-subscribe overwrites.
    let subscribedSessionId: string | null = null;
    const subscriber: Subscriber = {
      send: (frame: unknown) => {
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          // Socket lifecycle issues are the caller's problem.
        }
      },
    };

    socket.on('message', (raw: Buffer) => {
      this.handleMessage(raw.toString('utf8'), {
        socket,
        subscriber,
        onSubscribed: (sessionId) => {
          // If previously subscribed to a different render, unsub
          // from it first.
          if (subscribedSessionId !== null && subscribedSessionId !== sessionId) {
            this.renders.removeSubscriber(subscribedSessionId, subscriber);
          }
          subscribedSessionId = sessionId;
        },
      });
    });

    socket.on('close', () => {
      if (subscribedSessionId !== null) {
        this.renders.removeSubscriber(subscribedSessionId, subscriber);
      }
    });
  }

  private handleMessage(
    text: string,
    ctx: {
      readonly socket: WebSocket;
      readonly subscriber: Subscriber;
      readonly onSubscribed: (sessionId: string) => void;
    },
  ): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      // Malformed JSON — silently drop per SPEC non-promise "no flow
      // control / no retries". Real servers would log; the reference
      // server keeps it silent so `no-op` fixtures pass.
      return;
    }

    if (!isRecord(frame)) return;

    if (frame['type'] === 'subscribe') {
      this.handleSubscribe(frame, {
        subscriber: ctx.subscriber,
        onSubscribed: ctx.onSubscribed,
        socket: ctx.socket,
      });
      return;
    }
    if (frame['type'] === 'action') {
      const parsed = parseActionFrame(frame);
      if (parsed === undefined) return; // malformed — silently drop
      const render = this.renders.get(parsed.payload.sessionId);
      if (render === undefined) return; // drop actions for unknown renders
      // Ack + contract rejections reply to the SENDING socket — the
      // dispatcher gets the persistence proof, not the broadcast set.
      handleAction(parsed, { render, reply: ctx.subscriber });
      return;
    }
    if (frame['type'] === 'host_context_observed') {
      // Fire-and-forget observation message — no response frame. The
      // obligation is purely stateful: persist the validated
      // projection onto the named render (idempotent overwrite). The
      // first-party server scopes the write through its subscriber
      // binding; this no-auth server's tenancy scope is the render
      // lookup itself — malformed frames and unknown renders drop,
      // mirroring the action path.
      const parsed = parseHostContextObservedFrame(frame);
      if (parsed === undefined) return; // malformed — silently drop
      const render = this.renders.get(parsed.payload.sessionId);
      if (render === undefined) return; // drop observations for unknown renders
      handleHostContextObserved(parsed, render);
      return;
    }
    // Unrecognized type — silently drop (extensibly-closed; third
    // parties may send frame types we don't know about).
  }

  private handleSubscribe(
    frame: Record<string, unknown>,
    ctx: {
      readonly subscriber: Subscriber;
      readonly onSubscribed: (sessionId: string) => void;
      readonly socket: WebSocket;
    },
  ): void {
    const payload = frame['payload'];
    if (!isRecord(payload)) return;
    // GguiSession-identity field: the canonical SPEC field `sessionId`.
    const sessionId = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined;
    if (sessionId === undefined) return;
    // `appId` is OPTIONAL on the subscribe payload (SPEC §12.2 field
    // table): absent ⇒ the server resolves the caller's
    // identity-default app. This server's identity model is no-auth —
    // every caller is the same anonymous identity — so the
    // identity-default collapses to the deployment-level
    // {@link DEPLOYMENT_DEFAULT_APP_ID}; the resolved value flows
    // through the SAME tenancy gate + provision-on-subscribe path a
    // client-supplied appId takes. A PRESENT-but-non-string `appId` is
    // still a malformed frame and takes the missing-`sessionId`
    // posture: silently dropped, no error frame, no render
    // provisioned.
    const rawAppId = payload['appId'];
    if (rawAppId !== undefined && typeof rawAppId !== 'string') return;
    const appId = rawAppId ?? DEPLOYMENT_DEFAULT_APP_ID;
    const requestId = typeof frame['requestId'] === 'string' ? frame['requestId'] : undefined;
    const rawVersions = payload['supportedVersions'];
    const supportedVersions = Array.isArray(rawVersions)
      ? rawVersions.filter((v): v is string => typeof v === 'string')
      : undefined;

    // Version handshake — if the client declared `supportedVersions`
    // AND our current schema-version is not in the list, emit
    // UPGRADE_REQUIRED per SPEC §12.2.2.
    //
    //   - `strictVersionPolicy: true` (default): emit + close the
    //     WebSocket so the caller cannot proceed.
    //   - `strictVersionPolicy: false` (advisory opt-out): emit +
    //     keep the connection open.
    //
    // Per-render override precedence: if the `server-version-override`
    // directive set a `versionOverride` on this render BEFORE the
    // subscribe landed, advertise that value instead of the instance-
    // level default. Lets parallel kit fixtures share one server while
    // mismatching version on exactly one render.
    const existingRender = this.renders.get(sessionId);
    const advertised = existingRender?.versionOverride ?? this.options.versionOverride;
    if (supportedVersions !== undefined && !supportedVersions.includes(advertised)) {
      ctx.subscriber.send({
        type: 'error',
        payload: {
          code: 'UPGRADE_REQUIRED',
          message: `server advertises '${advertised}'; client supports [${supportedVersions.join(', ')}]`,
          serverVersion: advertised,
        },
        ...(requestId !== undefined ? { requestId } : {}),
      });
      if (this.options.strictVersionPolicy) {
        try {
          ctx.socket.close();
        } catch {
          // best-effort — socket may already be closing
        }
      }
      return;
    }

    // SPEC §12.2 tenancy MUST: the subscribe's `appId` MUST match the
    // GguiSession's bound appId or the subscribe fails APP_MISMATCH
    // (§12.2.3). The code is deliberately distinct from
    // SESSION_NOT_FOUND — the GguiSession EXISTS, it is reachable only
    // from a different app, so the client's recovery is "fix your
    // appId / API key", not "re-handshake". Only an existing render
    // can mismatch: an unknown sessionId falls through to the
    // provision-on-subscribe path below, which binds the subscribe's
    // own appId (mirroring the first-party dev-mode posture: look up
    // first; if not present, create). The mismatch rejects without
    // registering a subscriber and without an ack; the socket stays
    // open (matching the first-party handler).
    if (existingRender !== undefined && existingRender.appId !== appId) {
      ctx.subscriber.send({
        type: 'error',
        payload: {
          code: 'APP_MISMATCH',
          message: `GguiSession '${sessionId}' belongs to a different app`,
        },
        ...(requestId !== undefined ? { requestId } : {}),
      });
      return;
    }

    // Bind the render BEFORE registering the subscriber: create() is a
    // no-op when the render already exists (preserving the appId an
    // earlier directive bound), and for provision-on-subscribe it
    // binds the subscribe payload's own appId. Ordering matters —
    // `addSubscriber`'s create-if-missing fallback binds the default
    // app, which would make this render reject the SAME client's next
    // subscribe with APP_MISMATCH.
    this.renders.create(sessionId, appId);
    this.renders.addSubscriber(sessionId, ctx.subscriber);
    ctx.onSubscribed(sessionId);
    ctx.subscriber.send({
      type: 'ack',
      payload: { serverVersion: advertised },
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
}
