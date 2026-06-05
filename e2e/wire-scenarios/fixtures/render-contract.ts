/**
 * Helpers that drive the `ggui_handshake` → `ggui_render` chain against
 * a live ggui MCP endpoint. The handshake's `blueprintDraft.contract`
 * carries a verbatim DataContract; the render pins it via
 * `override: {contract}`. (Omitting `override` would ACCEPT the synth's
 * suggestion instead.) GguiSession WILL invoke the configured generator (LLM)
 * to produce componentCode — see `ANTHROPIC_API_KEY` gating in each
 * scenario.
 *
 * Returns the rendered URL (`<server>/r/<shortCode>`) and the sessionId
 * so tests can open the iframe AND drive ggui_consume for the same
 * render.
 */
import { callTool, unwrapStructured } from './mcp-client.js';

export interface RenderedContractRef {
  readonly handshakeId: string;
  readonly sessionId: string;
  /** Absolute URL the renderer is served at. */
  readonly url: string;
}

export interface RenderContractOptions {
  /** Full URL to the ggui MCP endpoint (e.g. `http://localhost:6781/mcp`). */
  readonly mcpUrl: string;
  /** Free text intent passed to handshake. */
  readonly intent: string;
  /** Verbatim DataContract draft. Pinned as-is via `override: {contract}`. */
  readonly contract: Record<string, unknown>;
  /** Optional props (required when the contract declares propsSpec). */
  readonly props?: Record<string, unknown>;
  /** Optional deterministic seed (currently unused after render-noun deletion; reserved). */
  readonly seed?: string;
}

/**
 * Run the full handshake → render chain with the supplied contract.
 * Returns enough to (a) open the renderer URL in a browser AND
 * (b) call `ggui_consume({sessionId})` to drain the pending-events pipe.
 */
export async function renderKnownContract(
  opts: RenderContractOptions,
): Promise<RenderedContractRef> {
  const handshake = unwrapStructured<{ handshakeId: string }>(
    await callTool(opts.mcpUrl, 'ggui_handshake', {
      intent: opts.intent,
      blueprintDraft: { contract: opts.contract },
    }),
  );

  // `override.contract` pins our verbatim contract (STRICT cold-gen)
  // instead of the synth's suggestion. Omitting `override` would ACCEPT
  // whatever the synth thought the intent implied (e.g. adding required
  // propsSpec entries our test doesn't supply), making scenarios
  // non-deterministic. `props` is required on every render; default to
  // `{}` since these contracts declare no propsSpec.
  const render = unwrapStructured<{
    sessionId: string;
    renderUrl?: string;
    url?: string;
  }>(
    await callTool(opts.mcpUrl, 'ggui_render', {
      handshakeId: handshake.handshakeId,
      props: opts.props ?? {},
      override: { contract: opts.contract },
    }),
  );

  const url =
    render.renderUrl ??
    render.url ??
    deriveRenderUrl(opts.mcpUrl, render.sessionId);

  return {
    handshakeId: handshake.handshakeId,
    sessionId: render.sessionId,
    url,
  };
}

/**
 * Fallback URL derivation when the render response doesn't carry a
 * fully-resolved renderer URL. The OSS renderer serves at
 * `<server>/r/<shortCode>` where shortCode is derived from
 * `sessionId`. If render responses already include the URL (current
 * OSS behavior), this never runs.
 */
function deriveRenderUrl(mcpUrl: string, sessionId: string): string {
  const u = new URL(mcpUrl);
  u.pathname = `/r/${sessionId}`;
  return u.toString();
}
