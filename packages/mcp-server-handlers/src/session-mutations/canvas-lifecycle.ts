/**
 * Canvas-lifecycle emitter.
 *
 * Injected seam handlers call to publish `_ggui:lifecycle` envelopes
 * on the live channel. The MCP server's session-channel binds this to its
 * streamFanout/streamBuffer surface; OSS without canvas mode wires
 * nothing (handlers no-op when `deps.canvasLifecycle` is undefined,
 * preserving zero-config behavior).
 *
 * Boundary discipline:
 *   - Handlers describe WHAT to publish (handshake started, push
 *     started, …) — never HOW to route it. Wire-shape lives in
 *     `@ggui-ai/protocol/canvas-lifecycle`; transport lives in
 *     `@ggui-ai/mcp-server`.
 *   - The implementation is fire-and-forget. Handlers MUST NOT
 *     await the emit (a slow transport would stall the agent's
 *     tool call). Errors propagate to the impl's own logging
 *     surface; handlers don't observe them.
 */

import type { CanvasLifecyclePayload } from '@ggui-ai/protocol';

/**
 * Caller-supplied dep. Wired by the session-channel server; absent
 * for OSS deployments without canvas mode.
 *
 * Implementations SHOULD be cheap + non-throwing — handlers fire-
 * and-forget. A failing publish degrades the canvas animator (no
 * pill state changes) but MUST NOT impact the handler's primary
 * result.
 */
export interface CanvasLifecycleEmitter {
  emit(sessionId: string, payload: CanvasLifecyclePayload): void;
}
