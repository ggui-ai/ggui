/**
 * `SessionState` — what the decision engine sees about the live
 * session at the moment of a negotiation call.
 *
 * Captures the UI stack (pages previously pushed into this
 * session), recent conversation, and optional interface context
 * (viewport, device class). Consumed by `NegotiatorDecisionInput`
 * to drive `create / update / compose / replace` decisions — the
 * stack tells the engine whether something already on screen can
 * absorb this push as an `update`, and the conversation history
 * feeds the decision LLM.
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
 * One entry on the session's UI stack — a page the agent previously
 * pushed. Minimal shape: every field the decision engine actually
 * reads to decide reuse vs. create.
 */
export interface SessionStackEntry {
  id: string;
  prompt?: string;
  contract?: DataContract;
  componentCode: string;
}

/** Current state of a session — stack + conversation history. */
export interface SessionState {
  stack: SessionStackEntry[];
  conversationHistory: Array<{ role: 'user' | 'agent'; content: string }>;
  interfaceContext?: InterfaceContext;
}
