/**
 * `ReferenceServer` — the minimal WS live-channel server this package
 * exports. Honest scope: SPEC §12.2 wire, version handshake,
 * wired-action dispatch. That's it.
 *
 * No auth (accepts any bearer). No persistence. No bundle loading.
 * The whole point is to be narrow enough that the vendor-neutral
 * separation claim (Protocol #6) is empirically grounded — if this
 * server passes `@ggui-ai/protocol-conformance`, the protocol has
 * no implicit `@ggui-ai/mcp-server` coupling.
 *
 * Wire-field note: the consumer (`@ggui-ai/protocol-conformance`)
 * still names the render identity field `sessionId` on the wire (its
 * fixtures have not yet been renamed). The reference server honors
 * the consumer contract by reading that field name verbatim, then
 * binds the value to a `renderId` internally — see {@link Render}
 * for the canonical identity name used throughout this package.
 */
import { createServer, type Server as HttpServer } from 'node:http';

import { PROTOCOL_SCHEMA_VERSION } from '@ggui-ai/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

import { dispatchAction, parseActionFrame } from './action-router.js';
import { RenderStore, type Subscriber } from './render.js';
import { ToolRegistry } from './tool-registry.js';

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
  readonly renders = new RenderStore();
  readonly tools = new ToolRegistry();

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
    let subscribedRenderId: string | null = null;
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
      void this.handleMessage(raw.toString('utf8'), {
        socket,
        subscriber,
        onSubscribed: (renderId) => {
          // If previously subscribed to a different render, unsub
          // from it first.
          if (subscribedRenderId !== null && subscribedRenderId !== renderId) {
            this.renders.removeSubscriber(subscribedRenderId, subscriber);
          }
          subscribedRenderId = renderId;
        },
      });
    });

    socket.on('close', () => {
      if (subscribedRenderId !== null) {
        this.renders.removeSubscriber(subscribedRenderId, subscriber);
      }
    });
  }

  private async handleMessage(
    text: string,
    ctx: {
      readonly socket: WebSocket;
      readonly subscriber: Subscriber;
      readonly onSubscribed: (renderId: string) => void;
    },
  ): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      // Malformed JSON — silently drop per SPEC non-promise "no flow
      // control / no retries". Real servers would log; the reference
      // server keeps it silent so `no-op` fixtures pass.
      return;
    }

    if (frame === null || typeof frame !== 'object') return;
    const f = frame as Record<string, unknown>;

    if (f['type'] === 'subscribe') {
      this.handleSubscribe(f, {
        subscriber: ctx.subscriber,
        onSubscribed: ctx.onSubscribed,
        socket: ctx.socket,
      });
      return;
    }
    if (f['type'] === 'action') {
      const parsed = parseActionFrame(frame);
      if (parsed === undefined) return; // malformed — silently drop
      const render = this.renders.get(parsed.renderId);
      if (render === undefined) return; // drop actions for unknown renders
      await dispatchAction(parsed, { render, tools: this.tools });
      return;
    }
    // Unrecognized type — silently drop (extensibly-closed; third
    // parties may send frame types we don't know about).
  }

  private handleSubscribe(
    frame: Record<string, unknown>,
    ctx: {
      readonly subscriber: Subscriber;
      readonly onSubscribed: (renderId: string) => void;
      readonly socket: WebSocket;
    },
  ): void {
    const payload = frame['payload'];
    if (payload === null || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    // Wire-field acceptance: the conformance kit currently sends
    // `sessionId`; the canonical SPEC field is `renderId`. Read both
    // so the reference server is forward-compatible with the kit's
    // eventual rename without breaking today's fixtures.
    const renderId =
      typeof p['renderId'] === 'string'
        ? p['renderId']
        : typeof p['sessionId'] === 'string'
          ? p['sessionId']
          : undefined;
    if (renderId === undefined) return;
    const appId = typeof p['appId'] === 'string' ? p['appId'] : 'conformance';
    const requestId = typeof frame['requestId'] === 'string' ? frame['requestId'] : undefined;
    const supportedVersions = Array.isArray(p['supportedVersions'])
      ? (p['supportedVersions'] as readonly unknown[]).filter((v): v is string => typeof v === 'string')
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
    const existingRender = this.renders.get(renderId);
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

    // Add the subscriber + emit ack.
    this.renders.addSubscriber(renderId, ctx.subscriber);
    // Preserve appId on first subscribe — create() is no-op if the
    // render already exists from an earlier directive.
    this.renders.create(renderId, appId);
    ctx.onSubscribed(renderId);
    ctx.subscriber.send({
      type: 'ack',
      payload: { serverVersion: advertised },
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }
}
