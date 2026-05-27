/**
 * Helpers that drive the `ggui_handshake` → `ggui_render` chain against
 * a live ggui MCP endpoint. The handshake's `blueprintDraft.contract`
 * carries a verbatim DataContract; the render accepts it via
 * `decision: {kind:'override'}` (or `{kind:'accept'}`). Render WILL
 * invoke the configured generator (LLM) to produce componentCode — see
 * `ANTHROPIC_API_KEY` gating in each scenario.
 *
 * Returns the rendered URL (`<server>/r/<shortCode>`) and the renderId
 * so tests can open the iframe AND drive ggui_consume for the same
 * render.
 */
import { callTool, unwrapStructured } from './mcp-client.js';

export interface PushedContractRef {
  readonly handshakeId: string;
  readonly renderId: string;
  /** Absolute URL the renderer is served at. */
  readonly url: string;
}

export interface PushContractOptions {
  /** Full URL to the ggui MCP endpoint (e.g. `http://localhost:6781/mcp`). */
  readonly mcpUrl: string;
  /** Free text intent passed to handshake. */
  readonly intent: string;
  /** Verbatim DataContract draft. Pushed as-is via `decision: {kind:'override'}`. */
  readonly contract: Record<string, unknown>;
  /** Optional props (required when the contract declares propsSpec). */
  readonly props?: Record<string, unknown>;
  /** Optional deterministic seed (currently unused after session deletion; reserved). */
  readonly seed?: string;
}

/**
 * Run the full handshake → render chain with the supplied contract.
 * Returns enough to (a) open the renderer URL in a browser AND
 * (b) call `ggui_consume({renderId})` to drain the pending-events pipe.
 */
export async function pushKnownContract(
  opts: PushContractOptions,
): Promise<PushedContractRef> {
  const handshake = unwrapStructured<{ handshakeId: string }>(
    await callTool(opts.mcpUrl, 'ggui_handshake', {
      intent: opts.intent,
      blueprintDraft: { contract: opts.contract },
    }),
  );

  // `override` decision forces our verbatim contract instead of the
  // synth's suggestion. `accept` would replace our minimal contract
  // with whatever the synth thought the intent implied (e.g. adding
  // required propsSpec entries our test doesn't supply), making
  // scenarios non-deterministic.
  const render = unwrapStructured<{
    renderId: string;
    renderUrl?: string;
    url?: string;
  }>(
    await callTool(opts.mcpUrl, 'ggui_render', {
      handshakeId: handshake.handshakeId,
      decision: {
        kind: 'override',
        blueprintDraft: { contract: opts.contract },
      },
      ...(opts.props !== undefined ? { props: opts.props } : {}),
    }),
  );

  const url =
    render.renderUrl ??
    render.url ??
    deriveRenderUrl(opts.mcpUrl, render.renderId);

  return {
    handshakeId: handshake.handshakeId,
    renderId: render.renderId,
    url,
  };
}

/**
 * Fallback URL derivation when the render response doesn't carry a
 * fully-resolved renderer URL. The OSS renderer serves at
 * `<server>/r/<shortCode>` where shortCode is derived from
 * `renderId`. If render responses already include the URL (current
 * OSS behavior), this never runs.
 */
function deriveRenderUrl(mcpUrl: string, renderId: string): string {
  const u = new URL(mcpUrl);
  u.pathname = `/r/${renderId}`;
  return u.toString();
}
