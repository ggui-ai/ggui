/**
 * ONE narrowing seam for `ggui_render` results across the
 * wire-scenarios package (ggui#786).
 *
 * Before this existed, every scenario that rendered kept its own
 * hand-typed mirror of the render output — `render-contract.ts` had
 * `{sessionId?: unknown; resourceUri?: unknown}`, `08-cached-render`
 * had a five-field `RenderOut` interface — and none of them read
 * `outcome`. That is the drift this file removes: the shape now comes
 * from `renderOutputSchema`, and the arm from the protocol's own
 * exported guards, so a schema change breaks the build here instead of
 * surfacing in a spec as an undefined `blueprintId`.
 *
 * This takes the WHOLE JSON-RPC response rather than just
 * `structuredContent`, and deliberately does not route through
 * `unwrapStructured`. Both non-rendered outcomes are `isError: true`,
 * so `unwrapStructured` would throw its generic "MCP tool isError=true"
 * before anything could read the refusal's `code` / `fix` — exactly the
 * diagnostic this helper exists to surface.
 */
import {
  isFailedRenderOutput,
  isRefusedRenderOutput,
  isRenderedOutput,
  renderOutputSchema,
  type GguiRenderOutput,
} from '@ggui-ai/protocol';

import type { JsonRpcResponse } from './mcp-client.js';

/**
 * A committed, mountable render: the six identity fields are
 * non-optional (via `isRenderedOutput`) and `resourceUri` is narrowed
 * to a string. Derived from {@link GguiRenderOutput} — never restated.
 */
export type RenderedResult = GguiRenderOutput & { outcome: 'rendered' } & {
  sessionId: string;
  resourceUri: string;
};

/**
 * Narrow a `ggui_render` JSON-RPC response to its RENDERED arm, or
 * throw a message that names why it was not one.
 *
 * The three throws are deliberately distinct — a scenario that fails
 * because the deployment refused should say so with the registry code
 * and the recovery step, not report a missing `sessionId`.
 */
export function unwrapRenderedResult(resp: JsonRpcResponse): RenderedResult {
  if (resp.error !== undefined) {
    throw new Error(`ggui_render RPC error (${resp.error.code}): ${resp.error.message}`);
  }
  const structured = resp.result?.structuredContent;
  if (structured === undefined) {
    throw new Error('ggui_render response carries no structuredContent');
  }

  // Real validation against the composed schema — this is untrusted
  // wire input, and the composed form carries the presence refinements
  // the raw shape cannot (a refusal with a stray identity field fails
  // here rather than flowing into a scenario).
  const parsed = renderOutputSchema.safeParse(structured);
  if (!parsed.success) {
    throw new Error(
      `ggui_render output is not conformant to renderOutputSchema: ${JSON.stringify(structured).slice(0, 400)}`,
    );
  }
  const out = parsed.data;

  // Declined BEFORE any work: nothing was committed and the handshake
  // is intact, so the same handshakeId would still work once fixed.
  if (isRefusedRenderOutput(out)) {
    throw new Error(
      `ggui_render REFUSED (${out.refusal.code}): ${out.refusal.message} ` +
        `Fix: ${out.refusal.fix} [retry=${out.refusal.retry}; handshake intact]`,
    );
  }
  // Generation RAN and produced nothing. The handshake is consumed.
  if (isFailedRenderOutput(out)) {
    throw new Error(
      `ggui_render FAILED (${out.error.code}): ${out.error.message}`,
    );
  }
  if (!isRenderedOutput(out)) {
    throw new Error(`ggui_render returned unknown outcome "${out.outcome}"`);
  }

  // `renderOutputSchema` already refines "rendered ⇒ resourceUri
  // present"; this narrows the TYPE to match that guarantee.
  const { resourceUri } = out;
  if (typeof resourceUri !== 'string' || resourceUri.length === 0) {
    throw new Error('ggui_render rendered result carries no resourceUri');
  }
  return { ...out, resourceUri };
}
