/**
 * `RenderState` — what the decision engine sees about the live
 * render at the moment of a negotiation call.
 *
 * Captures the current render (if any), recent conversation, and
 * optional interface context (viewport, device class). Consumed by
 * `NegotiatorDecisionInput` to drive `create / update / replace`
 * decisions — the current render tells the engine whether the
 * already-on-screen UI can absorb this push as an `update`, and the
 * conversation history feeds the decision LLM.
 *
 * The decision space is `create | replace | update`: there is at
 * most ONE current render per negotiation call (flatten-render
 * identity has no multi-entry stack), and `currentRender` captures
 * that single live render when present.
 *
 * Kept in `@ggui-ai/negotiator` (not `mcp-server-core`): this is
 * the decision engine's input shape, not a storage seam. An MCP
 * server implementer binding against the public `Negotiator`
 * interface sees `NegotiatorInput` / `NegotiatorResult` — never
 * this internal input shape. Community adapters that want to
 * call `makeDecision` directly (bypassing the `Negotiator` wrapper)
 * import this type.
 */

import type { DataContract, InterfaceContext } from '@ggui-ai/protocol';

/**
 * One entry describing the render currently on screen — minimal
 * shape: every field the decision engine actually reads to decide
 * reuse vs. create.
 *
 * Mirrors the protocol's `ComponentRender` projection but stays
 * intentionally narrower — the engine only consumes identity,
 * authoring prompt, contract, and component code.
 */
export interface RenderEntry {
  id: string;
  prompt?: string;
  contract?: DataContract;
  componentCode: string;
}

/**
 * Current state of the active render — at most ONE current render
 * plus conversation history.
 */
export interface RenderState {
  /**
   * The render currently on screen for this scope, when any. Absent
   * ⇒ no live render exists (cold start or post-clear).
   */
  currentRender?: RenderEntry;
  conversationHistory: Array<{ role: 'user' | 'agent'; content: string }>;
  interfaceContext?: InterfaceContext;
}
