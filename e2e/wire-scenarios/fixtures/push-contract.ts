/**
 * Helpers that drive the `ggui_new_session` → `ggui_handshake` →
 * `ggui_push` chain against a live ggui MCP endpoint. The handshake's
 * `blueprintDraft.contract` carries a verbatim DataContract; the
 * push accepts it via `decision: {kind:'accept'}`. Push WILL invoke
 * the configured generator (LLM) to produce componentCode — see
 * `ANTHROPIC_API_KEY` gating in each scenario.
 *
 * Returns the rendered URL (`<server>/r/<shortCode>`) and the
 * stackItemId so tests can open the iframe AND drive ggui_consume
 * for the same item.
 */
import { callTool, unwrapStructured } from './mcp-client.js';

export interface PushedContractRef {
  readonly sessionId: string;
  readonly handshakeId: string;
  readonly stackItemId: string;
  /** Absolute URL the renderer is served at. */
  readonly url: string;
}

export interface PushContractOptions {
  /** Full URL to the ggui MCP endpoint (e.g. `http://localhost:6781/mcp`). */
  readonly mcpUrl: string;
  /** Free text intent passed to handshake. */
  readonly intent: string;
  /** Verbatim DataContract draft. Pushed as-is via `decision: {kind:'accept'}`. */
  readonly contract: Record<string, unknown>;
  /** Optional props (required when the contract declares propsSpec). */
  readonly props?: Record<string, unknown>;
  /** Optional deterministic seed for the new session id. */
  readonly seed?: string;
}

/**
 * Run the full new_session → handshake → push chain with the
 * supplied contract. Returns enough to (a) open the renderer URL
 * in a browser AND (b) call `ggui_consume({stackItemId})` to drain
 * the pending-events pipe.
 */
export async function pushKnownContract(
  opts: PushContractOptions,
): Promise<PushedContractRef> {
  const newSession = unwrapStructured<{ sessionId: string }>(
    await callTool(opts.mcpUrl, 'ggui_new_session', {
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    }),
  );

  const handshake = unwrapStructured<{ handshakeId: string }>(
    await callTool(opts.mcpUrl, 'ggui_handshake', {
      sessionId: newSession.sessionId,
      intent: opts.intent,
      blueprintDraft: { contract: opts.contract },
    }),
  );

  // `override` decision forces our verbatim contract instead of the
  // synth's suggestion. `accept` would replace our minimal contract
  // with whatever the synth thought the intent implied (e.g. adding
  // required propsSpec entries our test doesn't supply), making
  // scenarios non-deterministic.
  const push = unwrapStructured<{
    stackItemId: string;
    renderUrl?: string;
    url?: string;
  }>(
    await callTool(opts.mcpUrl, 'ggui_push', {
      handshakeId: handshake.handshakeId,
      decision: {
        kind: 'override',
        blueprintDraft: { contract: opts.contract },
      },
      ...(opts.props !== undefined ? { props: opts.props } : {}),
    }),
  );

  const url =
    push.renderUrl ??
    push.url ??
    deriveRenderUrl(opts.mcpUrl, push.stackItemId);

  return {
    sessionId: newSession.sessionId,
    handshakeId: handshake.handshakeId,
    stackItemId: push.stackItemId,
    url,
  };
}

/**
 * Fallback URL derivation when the push response doesn't carry a
 * fully-resolved renderer URL. The OSS renderer serves at
 * `<server>/r/<shortCode>` where shortCode is derived from
 * `stackItemId`. If push responses already include the URL (current
 * OSS behavior), this never runs.
 */
function deriveRenderUrl(mcpUrl: string, stackItemId: string): string {
  const u = new URL(mcpUrl);
  u.pathname = `/r/${stackItemId}`;
  return u.toString();
}
