/**
 * Helpers that drive the `ggui_handshake` → `ggui_render` chain against
 * a live ggui MCP endpoint. The handshake's `blueprintDraft.contract`
 * carries a verbatim DataContract; the render pins it via
 * `override: {contract}`. (Omitting `override` would ACCEPT the synth's
 * suggestion instead.) Render WILL invoke the configured generator (LLM)
 * to produce componentCode — see `ANTHROPIC_API_KEY` gating in each
 * scenario.
 *
 * Returns the render's identity pair: `sessionId` (the agent's handle
 * for `ggui_consume` / `ggui_update`) and `resourceUri` (the
 * spec-canonical MCP-Apps mount handle, `ui://ggui/render/...`). The
 * R5 retirement (2026-05-26) removed the `/r/<shortCode>` renderer-URL
 * surface — `ggui_render`'s wire output carries NO browser URL.
 * Browser scenarios resolve `resourceUri` via MCP `resources/read` and
 * mount it behind the host stand-in: see `mountRenderResource` in
 * fixtures/mcp-app-host.ts.
 */
import { callTool, unwrapStructured } from './mcp-client.js';

export interface RenderedContractRef {
  readonly handshakeId: string;
  readonly sessionId: string;
  /**
   * Spec-canonical MCP-Apps mount handle
   * (`ui://ggui/render/{sessionId}[/{contractHash}]`). Resolve via
   * `resources/read` + mount behind the MCP-Apps host stand-in
   * (fixtures/mcp-app-host.ts `mountRenderResource`).
   */
  readonly resourceUri: string;
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
 * Returns enough to (a) mount the render's MCP-App resource in a
 * browser AND (b) call `ggui_consume({sessionId})` to drain the
 * pending-events pipe.
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
    sessionId?: unknown;
    resourceUri?: unknown;
  }>(
    await callTool(opts.mcpUrl, 'ggui_render', {
      handshakeId: handshake.handshakeId,
      props: opts.props ?? {},
      override: { contract: opts.contract },
    }),
  );

  // Trust-boundary narrowing — the JSON-RPC body is untrusted wire
  // input; validate the two identity fields instead of casting.
  const { sessionId, resourceUri } = render;
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    typeof resourceUri !== 'string' ||
    resourceUri.length === 0
  ) {
    throw new Error(
      `ggui_render output missing sessionId/resourceUri: ${JSON.stringify(render).slice(0, 400)}`,
    );
  }

  return {
    handshakeId: handshake.handshakeId,
    sessionId,
    resourceUri,
  };
}
