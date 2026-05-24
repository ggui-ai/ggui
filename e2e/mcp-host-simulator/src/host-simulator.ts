/**
 * `HostSimulator` — headless MCP Apps host driver (Tier 2 testing).
 *
 * What an MCP-Apps-aware host (claude.ai, Claude Desktop, Goose, etc.)
 * actually does over the wire on a single user message:
 *
 *   1. `initialize` — MCP Streamable HTTP handshake. The host
 *      advertises `clientCapabilities.experimental[MCP_APPS_UI_CAPABILITY]`
 *      so the server knows it's App-spec-aware.
 *   2. `tools/list` — host pre-fetches every tool's `_meta.ui.resourceUri`
 *      bundle (the spec says hosts SHOULD pre-fetch, NOT lazy-load on
 *      first call) so the iframe shell is ready when a tool finally
 *      fires.
 *   3. `tools/call` — host invokes a tool. When the response carries
 *      `resultMeta._meta.ggui.bootstrap`, the host opens the iframe
 *      with the bootstrap token + WS URL.
 *   4. WebSocket subscribe — iframe runtime connects with the
 *      bootstrap token, gets an ack with a reconnect `sessionToken`,
 *      then receives event frames pushed by the server.
 *   5. **Wired-action bridge** (separate slice T2.5) — when the
 *      iframe renders a wired button + the user "clicks" it, the
 *      iframe posts `ui/message` to the host; the host replies with
 *      the documented 3-message dance from
 *      `docs/development/mcp-apps-wired-actions.md`.
 *
 * This class wraps the MCP SDK client + a bootstrap-token consumer
 * + a WS connection — enough scaffolding to drive happy-path E2E
 * tests against an OSS `createGguiServer` factory or a remote
 * `https://mcp.ggui.ai` endpoint.
 *
 * Out of scope at v1:
 *   - OAuth flow (deferred to T2.6 — for now use a static bearer)
 *   - Wired-action bridge (T2.5)
 *   - Host-shape configs (T2.7)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  hasPushBootstrapMeta,
  MCP_APPS_UI_CAPABILITY,
  type PushResultMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import WebSocket from 'ws';
import {
  buildWiredAction,
  type BuiltWiredAction,
  type WiredActionUpdateContextEnvelope,
  type WiredActionUiMessageEnvelope,
} from './wired-action.js';

export interface HostSimulatorOptions {
  /**
   * Base URL of the MCP server. Common values:
   *   - `http://127.0.0.1:<port>` — OSS createGguiServer in tests
   *   - `https://mcp.ggui.ai` — production (with bearer)
   *   - `https://<env>.mcp.sandbox.ggui.ai` — sandbox
   *
   * The simulator appends the MCP path itself based on
   * {@link mcpPath}.
   */
  readonly url: string;

  /**
   * Path the MCP endpoint mounts at. Defaults to `/mcp` (OSS
   * convention). Cloud `mcp.ggui.ai` uses `/` (bare root) — pass
   * `''` for that case.
   */
  readonly mcpPath?: string;

  /**
   * Optional bearer token. When set, every MCP request carries
   * `Authorization: Bearer <token>`. Use `playground` for the
   * pod's playground bypass; production / sandbox callers use a
   * real `ggui_user_*` key here. Omit when the test boots an OSS
   * server with `devAllowAll` auth.
   */
  readonly bearer?: string;

  /**
   * Client info advertised on `initialize`. Defaults to
   * `{ name: 'host-simulator', version: '1.0' }` — production
   * tests can override to mimic specific hosts (e.g. `claude.ai`)
   * for shape-comparison runs.
   */
  readonly clientInfo?: { name: string; version: string };
}

/**
 * Result of `HostSimulator.callTool()` for a `ggui_push`-shaped
 * tool: the structuredContent, optional bootstrap metadata, and
 * the resourceUri the host should have pre-fetched (declaration-
 * level meta from `tools/list`, surfaced here for assertions).
 */
export interface CallToolResult {
  readonly structuredContent?: unknown;
  readonly content: ReadonlyArray<unknown>;
  /**
   * MCP-spec tool-level error flag. Set to `true` when the tool's
   * handler threw — the MCP SDK auto-wraps the throw into a
   * `{content:[{type:'text',text:msg}], isError:true}` result. Surfacing
   * the flag here is the canonical signal callers (G2 + future
   * error-envelope specs) read to distinguish a tool error from a
   * normal result without parsing `content[*].text` heuristically.
   */
  readonly isError?: boolean;
  /** Set when the tool result carries `_meta.ggui.bootstrap`. */
  readonly bootstrap?: PushResultMeta['ggui']['bootstrap'];
  /**
   * The `_meta.ui.resourceUri` declared on the TOOL (from
   * tools/list), if any. Distinct from per-call `_meta.ui.resourceUri`
   * which currently isn't used by ggui.
   */
  readonly toolResourceUri?: string;
}

/**
 * WebSocket ack frame the iframe runtime expects after subscribe.
 * Mirrors the live-channel wire shape:
 *   - Ack:   `{ type: 'ack', payload: { sessionToken, sequence, stack } }`
 *   - Error: `{ type: 'error', payload: { code } }`
 *
 * The simulator normalises both into a single discriminator on `kind`
 * so test assertions stay flat.
 */
export interface SubscribeAck {
  readonly kind: 'ack' | 'error';
  /** Set on `ack` — the reconnect token replacing the bootstrap one. */
  readonly sessionToken?: string;
  /** Set on `ack` — current sequence number for reconnect resume. */
  readonly sequence?: number;
  /** Set on `error` — wire error code (BOOTSTRAP_INVALID, …). */
  readonly code?: string;
}

interface ToolListEntry {
  readonly name: string;
  readonly description?: string;
  readonly resourceUri?: string;
}

/**
 * Blueprint metadata as projected onto the handshake response. Mirrors
 * the protocol's `BlueprintMeta` shape — the simulator surfaces it
 * structurally rather than re-importing the type so consumers don't
 * pick up a transitive zod dep just to read a handshake response.
 */
export interface SuggestionBlueprintMeta {
  readonly blueprintId: string;
  readonly contractHash: string;
  readonly codeHash?: string;
  readonly generator: string;
  readonly variance: Record<string, unknown>;
  readonly selectedReason?: string;
}

/**
 * Structural mirror of `HandshakeSuggestion`. `origin` is the routing
 * discriminator (`cache` / `agent` / `synth`); `blueprintMeta` is
 * always present; `amendments` is `synth`-only; `validationFindings`
 * surfaces validator output (soft on `cache`).
 */
export interface HandshakeSuggestionView {
  readonly origin: 'cache' | 'agent' | 'synth';
  readonly rationale: string;
  readonly blueprintMeta: SuggestionBlueprintMeta;
  readonly amendments?: {
    readonly contractDiff: ReadonlyArray<Record<string, unknown>>;
    readonly reasoning: string;
  };
  readonly validationFindings?: ReadonlyArray<{
    readonly code: string;
    readonly severity: 'error' | 'warn';
    readonly path: string;
    readonly message: string;
  }>;
}

/**
 * Structural mirror of `handshakeOutputSchema`'s structuredContent.
 * The simulator exposes this on `handshake()` / `openSession()` so
 * tests can branch on `suggestion.origin` without importing the
 * protocol schema directly.
 */
export interface HandshakeOutput {
  readonly handshakeId: string;
  readonly action:
    | 'create'
    | 'reuse'
    | 'update'
    | 'replace'
    | 'compose'
    | 'declined';
  readonly reason: string;
  readonly target: {
    readonly sessionId?: string;
    readonly stackItemId?: string;
  };
  readonly suggestion: HandshakeSuggestionView;
  readonly alternatives?: ReadonlyArray<unknown>;
  readonly contractHash: string;
  readonly nextStep?: {
    readonly tool: 'ggui_push';
    readonly description: string;
    readonly example: string;
  };
}

/**
 * Push input decision discriminator. Mirrors the protocol's
 * `PushDecision`. `accept` reuses the handshake suggestion's
 * provisional `blueprintMeta` verbatim; `override` mints a fresh
 * `blueprintId` against a new draft.
 */
export type PushDecisionInput =
  | { readonly kind: 'accept' }
  | {
      readonly kind: 'override';
      readonly blueprintDraft: {
        readonly contract: Record<string, unknown>;
        readonly variance?: {
          readonly persona?: string;
          readonly aesthetic?: string;
          readonly context?: Record<string, unknown>;
          readonly seedPrompt?: string;
        };
        readonly generator?: string;
      };
    };

/**
 * Args for {@link HostSimulator.simulateWiredAction}. Mirrors the
 * input shape the iframe runtime's `dispatchWiredAction` consumes,
 * minus the wire-level fields the simulator derives itself.
 */
export interface SimulateWiredActionArgs {
  readonly intent: string;
  readonly data?: unknown;
  /**
   * Bootstrap envelope from a prior {@link HostSimulator.callTool}
   * `ggui_push` — supplies the sessionId + appId the action targets.
   * Pass the bootstrap object directly; the simulator pulls the
   * fields it needs.
   */
  readonly bootstrap: PushResultMeta['ggui']['bootstrap'];
  /** Override `firedAt` for deterministic actionId tests. */
  readonly firedAt?: string;
}

/**
 * Result of {@link HostSimulator.simulateWiredAction} — the audit
 * round-trip from the gateway tool plus the two host-internal
 * envelopes that real claude.ai would have routed to its LLM
 * context + chat input. Tests assert on these fields directly.
 */
export interface SimulateWiredActionResult {
  /** FNV-1a 8-hex-char actionId binding the three envelopes. */
  readonly actionId: string;
  /** ISO-8601 firedAt — useful to replay the same actionId. */
  readonly firedAt: string;
  /**
   * `structuredContent` from the gateway tool's response, after the
   * `tools/call ggui_runtime_submit_action` round-trip. Shape per
   * `packages/mcp-server-handlers/src/session-mutations/submit-action.ts`:
   * `{ok, code?, message?, consumerPresent?}` — a minimal ack, not a
   * verbatim echo of the envelope.
   */
  readonly gatewayResult: unknown;
  /**
   * The captured `ui/update-model-context` envelope (not sent over
   * the wire — host-internal in production). Use
   * `pendingActionContext.text` for assertions on the `[ggui:pending-action]`
   * JSON line.
   */
  readonly pendingActionContext: WiredActionUpdateContextEnvelope;
  /**
   * The captured `ui/message` envelope (not sent over the wire — host-
   * internal in production until user consents). Use
   * `consentMessage.text` for the rendered consent prompt.
   */
  readonly consentMessage: WiredActionUiMessageEnvelope;
  /**
   * Pulled out from `pendingActionContext.params.content[0].text` for
   * convenience — the raw `[ggui:pending-action] {...}` line.
   */
  readonly pendingActionText: string;
  /** Pulled out from `consentMessage.params.content[0].text`. */
  readonly consentText: string;
}

export class HostSimulator {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private cachedTools: ToolListEntry[] | null = null;
  private prefetchedResources = new Map<string, string>();
  /**
   * Latest `ui/update-model-context` envelope captured from a wired
   * action. Per spec §1099 each new envelope OVERWRITES the previous —
   * tests use this to verify latest-wins semantics across rapid clicks.
   * `null` until {@link simulateWiredAction} fires at least once.
   */
  private modelContext: WiredActionUpdateContextEnvelope | null = null;
  /**
   * Append-only log of `ui/message` envelopes captured from wired
   * actions. Multiple consent prompts can stack pre-user-send (the
   * user has to clear/send each one); the simulator records all of
   * them for assertion.
   */
  private readonly consentLog: WiredActionUiMessageEnvelope[] = [];
  private readonly opts: HostSimulatorOptions;

  constructor(opts: HostSimulatorOptions) {
    this.opts = opts;
  }

  /**
   * Open the MCP session. Advertises App-spec capability so the
   * server knows it's talking to an MCP-Apps-aware host.
   */
  async connect(): Promise<void> {
    if (this.client) return;
    const mcpPath = this.opts.mcpPath ?? '/mcp';
    const url = new URL(`${this.opts.url}${mcpPath}`);
    const headers: Record<string, string> = {};
    if (this.opts.bearer) {
      headers['Authorization'] = `Bearer ${this.opts.bearer}`;
    }
    this.transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
    this.client = new Client(
      this.opts.clientInfo ?? { name: 'host-simulator', version: '1.0' },
      {
        capabilities: {
          // App-spec opt-in — server checks this on initialize and
          // unlocks resource-uri-bearing tool advertisements.
          experimental: { [MCP_APPS_UI_CAPABILITY]: {} },
        },
      },
    );
    await this.client.connect(this.transport);
  }

  /**
   * `tools/list` + RFC-9708 / App-spec pre-fetch. The host caches
   * each tool's resourceUri body so a subsequent `tools/call`
   * doesn't pay the bundle round-trip on top of the tool latency.
   *
   * Returns the slim `{name, description, resourceUri}` entries the
   * simulator carries — full Tool objects from the SDK are
   * verbose + carry input/outputSchema we don't need at the host
   * boundary.
   */
  async listTools(): Promise<readonly ToolListEntry[]> {
    if (!this.client) throw new Error('connect() first');
    if (this.cachedTools) return this.cachedTools;
    const result = await this.client.listTools();
    const entries: ToolListEntry[] = [];
    for (const tool of result.tools) {
      const meta = (tool as { _meta?: unknown })._meta;
      const ui = (meta as { ui?: { resourceUri?: unknown } } | undefined)?.ui;
      const resourceUri =
        typeof ui?.resourceUri === 'string' ? ui.resourceUri : undefined;
      entries.push({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(resourceUri !== undefined ? { resourceUri } : {}),
      });
      // App-spec pre-fetch: real hosts read each unique resourceUri
      // exactly once on tools/list and cache the bundle. We mirror
      // that so the test can assert pre-fetch happened.
      if (resourceUri && !this.prefetchedResources.has(resourceUri)) {
        try {
          const res = await this.client.readResource({ uri: resourceUri });
          // Take the first text block — the App-spec ui:// resource
          // is a single text resource (the iframe shell HTML or the
          // bundle URL referenced inside).
          const first = res.contents[0];
          const text =
            first && 'text' in first && typeof first.text === 'string'
              ? first.text
              : '';
          this.prefetchedResources.set(resourceUri, text);
        } catch {
          // Resource not readable — record an empty body so the
          // tools/list call itself doesn't fail; the test can
          // assert on `getPrefetchedResource` returning empty.
          this.prefetchedResources.set(resourceUri, '');
        }
      }
    }
    this.cachedTools = entries;
    return entries;
  }

  /**
   * Read the cached body of a pre-fetched resource. Returns
   * `undefined` when {@link listTools} hasn't been called yet OR
   * when no tool declared this resourceUri.
   */
  getPrefetchedResource(uri: string): string | undefined {
    return this.prefetchedResources.get(uri);
  }

  /**
   * `tools/call` with bootstrap-token extraction. When the result's
   * `_meta` matches the `ggui_push` bootstrap shape (per
   * `hasPushBootstrapMeta`), the bootstrap object is surfaced on
   * the return — the test can pass it straight to
   * {@link subscribeWith} to open the WS without parsing meta itself.
   *
   * `options.timeoutMs` overrides the MCP SDK's default per-request
   * timeout (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000`). Cold-gen pushes
   * on cold pods can exceed 60s in cloud e2e scenarios; cold-call
   * tests pass an explicit longer budget (e.g. 180s) to keep MCP-layer
   * timeouts from masking the assertion they want to make. Without
   * this option, an MCP `-32001 Request timed out` surfaces as a
   * cryptic test failure instead of the real perf signal.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { readonly timeoutMs?: number },
  ): Promise<CallToolResult> {
    if (!this.client) throw new Error('connect() first');
    const tools = await this.listTools();
    const toolEntry = tools.find((t) => t.name === name);

    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      options?.timeoutMs !== undefined
        ? { timeout: options.timeoutMs }
        : undefined,
    );
    const meta = (result as { _meta?: unknown })._meta;
    const bootstrap = hasPushBootstrapMeta(meta)
      ? meta.ggui.bootstrap
      : undefined;
    // Propagate the MCP-spec `isError` flag verbatim. The SDK sets it
    // to `true` on tool-handler throws via `createToolError` (server/mcp.js
    // §createToolError). Without surfacing it here, callers can't
    // distinguish error envelopes from normal results without parsing
    // `content[*].text` heuristically — the G2 spec workaround the
    // 2026-05-23 cleanup retired.
    const isError = (result as { isError?: unknown }).isError === true;

    return {
      content: (result.content ?? []) as ReadonlyArray<unknown>,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(isError ? { isError: true } : {}),
      ...(bootstrap !== undefined ? { bootstrap } : {}),
      ...(toolEntry?.resourceUri !== undefined
        ? { toolResourceUri: toolEntry.resourceUri }
        : {}),
    };
  }

  /**
   * Convenience wrapper for `ggui_new_session`. Returns the minted
   * `sessionId`. Pass `seed` for deterministic IDs in tests.
   */
  async newSession(args: { seed?: string; label?: string } = {}): Promise<{
    readonly sessionId: string;
    readonly existing?: true;
  }> {
    const result = await this.callTool('ggui_new_session', {
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
      ...(args.label !== undefined ? { label: args.label } : {}),
    });
    return result.structuredContent as { sessionId: string; existing?: true };
  }

  /**
   * Convenience wrapper for `ggui_handshake` — post-MVB-5 three-step
   * handshake input shape: `{sessionId, intent, blueprintDraft?,
   * forceCreate?}`. Returns the structured handshake output
   * (handshakeId, action, contractHash, suggestion, target, …).
   *
   * The `blueprintDraft` carries the agent's contract draft + optional
   * variance + generator hint. Omit it entirely for the empty-draft
   * path (server falls through to fast-path search / cold gen).
   */
  async handshake(args: {
    readonly sessionId: string;
    readonly intent: string;
    readonly blueprintDraft?: {
      readonly contract: Record<string, unknown>;
      readonly variance?: {
        readonly persona?: string;
        readonly aesthetic?: string;
        readonly context?: Record<string, unknown>;
        readonly seedPrompt?: string;
      };
      readonly generator?: string;
    };
    readonly forceCreate?: boolean;
    /** Forwarded to {@link callTool} — see its `options.timeoutMs`. */
    readonly timeoutMs?: number;
  }): Promise<HandshakeOutput> {
    const blueprintDraft = args.blueprintDraft ?? { contract: {} };
    const result = await this.callTool(
      'ggui_handshake',
      {
        sessionId: args.sessionId,
        intent: args.intent,
        blueprintDraft,
        ...(args.forceCreate !== undefined
          ? { forceCreate: args.forceCreate }
          : {}),
      },
      args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : undefined,
    );
    return result.structuredContent as HandshakeOutput;
  }

  /**
   * Convenience wrapper for `ggui_push` — post-MVB-5 input shape:
   * `{handshakeId, decision, props?}`. The `decision` discriminator
   * routes the push:
   *
   *   - `{kind: 'accept'}` — reuse the handshake suggestion's
   *     provisional blueprintId verbatim. Cache delivery (origin ===
   *     'cache') or gen-against-suggestion (origin === 'agent' /
   *     'synth').
   *   - `{kind: 'override', blueprintDraft: {...}}` — mint a fresh
   *     blueprintId and gen against a new draft. Discards the
   *     handshake's provisional id.
   *
   * The return mirrors {@link callTool}'s `CallToolResult`, with
   * `bootstrap` populated when the push minted one.
   */
  async push(args: {
    readonly handshakeId: string;
    readonly decision: PushDecisionInput;
    readonly props?: unknown;
    /** Forwarded to {@link callTool} — see its `options.timeoutMs`. */
    readonly timeoutMs?: number;
  }): Promise<CallToolResult> {
    return this.callTool(
      'ggui_push',
      {
        handshakeId: args.handshakeId,
        decision: args.decision,
        ...(args.props !== undefined ? { props: args.props } : {}),
      },
      args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : undefined,
    );
  }

  /**
   * One-shot helper for the canonical `new_session → handshake → push`
   * flow. Returns everything a downstream assertion typically needs:
   * the sessionId, handshakeId, the agent's draft contractHash, and
   * the push result (bootstrap + structuredContent).
   *
   * Default behavior: the simulator handshakes with the agent's
   * `blueprintDraft` (or `{contract: {}}` when none is provided), then
   * accepts the server's suggestion verbatim (`decision: 'accept'`).
   * Pass `decision: {kind: 'override', blueprintDraft: {...}}` to
   * mint a fresh blueprintId on push instead. To skip blueprint-search
   * on handshake and force the agent-mode suggestion path, set
   * `forceCreate: true`.
   */
  async openSession(args: {
    readonly intent: string;
    readonly seed?: string;
    readonly blueprintDraft?: {
      readonly contract: Record<string, unknown>;
      readonly variance?: {
        readonly persona?: string;
        readonly aesthetic?: string;
        readonly context?: Record<string, unknown>;
        readonly seedPrompt?: string;
      };
      readonly generator?: string;
    };
    readonly forceCreate?: boolean;
    readonly decision?: PushDecisionInput;
    readonly props?: unknown;
  }): Promise<{
    readonly sessionId: string;
    readonly handshakeId: string;
    readonly contractHash: string;
    readonly handshake: HandshakeOutput;
    readonly push: CallToolResult;
  }> {
    const session = await this.newSession(
      args.seed !== undefined ? { seed: args.seed } : {},
    );
    const handshakeArgs: Parameters<typeof this.handshake>[0] = {
      sessionId: session.sessionId,
      intent: args.intent,
    };
    if (args.blueprintDraft !== undefined) {
      (handshakeArgs as { blueprintDraft?: unknown }).blueprintDraft =
        args.blueprintDraft;
    }
    if (args.forceCreate !== undefined) {
      (handshakeArgs as { forceCreate?: boolean }).forceCreate = args.forceCreate;
    }
    const handshake = await this.handshake(handshakeArgs);

    const pushArgs: Parameters<typeof this.push>[0] = {
      handshakeId: handshake.handshakeId,
      decision: args.decision ?? { kind: 'accept' },
    };
    if (args.props !== undefined) {
      (pushArgs as { props?: unknown }).props = args.props;
    }
    const pushResult = await this.push(pushArgs);
    return {
      sessionId: session.sessionId,
      handshakeId: handshake.handshakeId,
      contractHash: handshake.contractHash,
      handshake,
      push: pushResult,
    };
  }

  /**
   * Open a WebSocket to the bootstrap's `wsUrl`, send a `subscribe`
   * frame with the token, await the ack. Returns the parsed ack
   * frame — the test can assert `kind === 'ack'` and pull the
   * `sessionToken` for reconnect tests.
   *
   * Does NOT keep the socket open beyond ack; the caller can pass
   * `keepOpen: true` to retain the WS for streaming-event tests.
   */
  async subscribeWith(
    bootstrap: PushResultMeta['ggui']['bootstrap'],
    opts: { keepOpen?: boolean } = {},
  ): Promise<{ ack: SubscribeAck; ws?: WebSocket }> {
    if (!bootstrap.wsUrl) {
      throw new Error(
        'subscribeWith: bootstrap.wsUrl is required to open a WS subscription. Self-contained / no-channel bootstraps have no live receiver.',
      );
    }
    // Thread the bootstrap token on the upgrade URL as `?bootstrap=`.
    // Servers that authenticate the WS upgrade (the cloud pod's
    // live-channel `resolveIdentityFromUpgrade`) read the token from
    // the query string — the post-connect `subscribe` frame below is
    // too late to gate the HTTP upgrade and would 401. Mirrors the
    // iframe-runtime's `composeWsUrl`; the token also stays in the
    // subscribe payload for servers that consume it there.
    const upgradeUrl = bootstrap.token
      ? `${bootstrap.wsUrl}${bootstrap.wsUrl.includes('?') ? '&' : '?'}bootstrap=${encodeURIComponent(bootstrap.token)}`
      : bootstrap.wsUrl;
    const ws = new WebSocket(upgradeUrl);
    const ackPromise = new Promise<SubscribeAck>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('WS ack timeout (5s)')),
        5_000,
      );
      ws.once('message', (data) => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data.toString()) as {
            type?: unknown;
            payload?: Record<string, unknown>;
          };
          const kind = parsed.type === 'ack' ? 'ack' : 'error';
          const payload = parsed.payload ?? {};
          resolve({
            kind,
            ...(typeof payload['sessionToken'] === 'string'
              ? { sessionToken: payload['sessionToken'] }
              : {}),
            ...(typeof payload['sequence'] === 'number'
              ? { sequence: payload['sequence'] }
              : {}),
            ...(typeof payload['code'] === 'string'
              ? { code: payload['code'] }
              : {}),
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    // Wire shape per `mcp-apps-outbound.test.ts`:
    //   { type: 'subscribe', payload: { sessionId, appId, bootstrap: token } }
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        payload: {
          sessionId: bootstrap.sessionId,
          appId: bootstrap.appId,
          bootstrap: bootstrap.token,
        },
      }),
    );

    const ack = await ackPromise;
    if (!opts.keepOpen) {
      ws.close();
      return { ack };
    }
    return { ack, ws };
  }

  /**
   * Simulate a wired-action button click — drives the documented
   * 3-message bridge from `docs/development/mcp-apps-wired-actions.md`:
   *
   *   1. `tools/call ggui_runtime_submit_action` — actually fires across
   *      the MCP transport (the server-side submit-action path runs).
   *   2. `ui/update-model-context` — captured into {@link modelContext}
   *      (host-internal in production; never crosses the wire).
   *   3. `ui/message` — captured into {@link consentLog} (host-internal
   *      until user clicks send in production).
   *
   * The 3 envelopes share an FNV-1a 8-hex actionId derived from
   * `intent | JSON.stringify(data) | firedAt`, byte-identical to the
   * iframe runtime's `dispatchWiredAction`. The LLM in production
   * cross-checks the actionId in the consent text against the
   * pending-action context before acting — drift between the two
   * builders breaks that check.
   *
   * Returns the actionId + gateway tool result + both captured
   * envelopes for direct assertion.
   */
  async simulateWiredAction(
    args: SimulateWiredActionArgs,
  ): Promise<SimulateWiredActionResult> {
    if (!this.client) throw new Error('connect() first');
    const built: BuiltWiredAction = buildWiredAction({
      intent: args.intent,
      data: args.data,
      sessionId: args.bootstrap.sessionId,
      appId: args.bootstrap.appId,
      ...(args.bootstrap.stackItemId !== undefined
        ? { stackItemId: args.bootstrap.stackItemId }
        : {}),
      ...(args.firedAt !== undefined ? { firedAt: args.firedAt } : {}),
    });

    // (1) Fire the gateway tool over the real MCP transport — this
    // is the only envelope that crosses the wire to the server.
    const toolResult = await this.client.callTool({
      name: built.toolsCall.params.name,
      arguments: { ...built.toolsCall.params.arguments },
    });
    const gatewayResult: unknown =
      (toolResult as { structuredContent?: unknown }).structuredContent;

    // (2) Update LLM context — latest-wins per spec §1099.
    this.modelContext = built.updateContext;

    // (3) Append consent prompt to the log.
    this.consentLog.push(built.uiMessage);

    return {
      actionId: built.actionId,
      firedAt: built.firedAt,
      gatewayResult,
      pendingActionContext: built.updateContext,
      consentMessage: built.uiMessage,
      pendingActionText: built.pendingActionText,
      consentText: built.consentText,
    };
  }

  /**
   * Latest captured `ui/update-model-context` envelope, or `null`
   * before the first {@link simulateWiredAction}. Subsequent wired
   * actions overwrite this (latest-wins, mirroring spec §1099).
   */
  getModelContext(): WiredActionUpdateContextEnvelope | null {
    return this.modelContext;
  }

  /**
   * All `ui/message` envelopes the simulator has captured since
   * {@link connect}, in the order they were dispatched. Read-only
   * snapshot — the underlying log keeps growing.
   */
  getConsentLog(): readonly WiredActionUiMessageEnvelope[] {
    return [...this.consentLog];
  }

  /** Tear down. Idempotent. */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.transport = null;
    this.cachedTools = null;
    this.prefetchedResources.clear();
    this.modelContext = null;
    this.consentLog.length = 0;
  }
}
