/**
 * User-action bridge — rewrites the chat prompt for the LLM when the
 * frontend forwarded a spec-canonical `_meta["ai.ggui/userAction"]`
 * slice (rehydrated-iframe click without an active `ggui_consume`
 * long-poll on the agent side).
 *
 * Design rule: SDK/framework-agnostic. No private SDK injection paths,
 * no synthetic tool-result fabrication. Just a stronger user-message
 * directive that gives the LLM a clear next-tool-call signal with the
 * `renderId` as a structured field instead of a prose substring.
 *
 * Two sub-shapes per the protocol type `GguiUserActionMeta`:
 *
 *   - `kind: 'queued'` — pipe HAS the event. The MCP server's
 *     `ggui_consume({renderId})` will drain it when the agent calls
 *     it. We do NOT drain server-side: that would create a
 *     double-truth bug (server pipe still has the event AND a fake
 *     consume return claims it was drained). Instead the directive
 *     tells the LLM "next tool call: ggui_consume({renderId: X})";
 *     the LLM issues the real call; the real result flows back
 *     through the SDK's normal tool-execution path. The MCP server
 *     pipe stays the single source of truth.
 *
 *   - `kind: 'inline'` — pipe is gone (PIPE_NOT_FOUND or transport
 *     error). The action `payload` IS on the slice. We can't drain
 *     anything (no pipe), so the directive embeds the payload inline
 *     and tells the LLM "do not call ggui_consume; act on this
 *     payload directly + ggui_update on renderId X".
 *
 * Why this works without prose-overfit instructions: the LLM sees a
 * directive block with the `renderId` AS A STRUCTURED FIELD (not
 * embedded in chat prose where it has to be parsed out), framed as
 * "next tool call: <toolName>({renderId: X})" — the same shape the
 * server's `ggui_render` response uses to nudge the LLM toward
 * `ggui_consume` after a render. The model has trained patterns for
 * "next tool call: X" → emit X; no judgment surface, no "do NOT
 * handshake" prose to overfit on.
 */
import type { GguiUserActionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Build the rehydration-directive prompt for the LLM. The original
 * chat prose stays at the end so the chat-panel UI / logs reflect
 * what the user actually saw (`callAppSendMessage` from
 * iframe-runtime); the [GGUI_USER_ACTION] prefix carries the
 * structured fields the LLM actually acts on.
 *
 * Pure function — no MCP round-trip, no server drain, no SDK
 * coupling. Same shape across every per-SDK sample agent.
 */
export function synthesizeUserActionPrompt(args: {
  readonly originalPrompt: string;
  readonly userAction: GguiUserActionMeta;
}): string {
  const { originalPrompt, userAction } = args;
  if (userAction.kind === 'queued') {
    // Pipe still holds the event. Nudge the LLM toward issuing the
    // real `ggui_consume` so the pipe drain happens via the normal
    // tool-execution path. The renderId is structured + named; the
    // "Next tool call" framing matches the server's own nextStep
    // wording on `ggui_render` responses.
    return [
      '[GGUI_USER_ACTION]',
      `kind: queued`,
      `renderId: ${userAction.renderId}`,
      `intent: ${userAction.intent}`,
      `actionId: ${userAction.actionId}`,
      `submittedAt: ${userAction.submittedAt}`,
      '',
      `Next tool call: ${userAction.nextStep.tool}({ "renderId": ${JSON.stringify(userAction.renderId)} })`,
      '',
      `The user clicked inside the live iframe for render ${userAction.renderId} while no ggui_consume long-poll was active. The gesture is queued on the consume pipe for that render. Call ${userAction.nextStep.tool} as shown above to drain it, then react to the returned event with the appropriate domain tool followed by ggui_update on the SAME renderId.`,
      '',
      `Original user message: ${originalPrompt}`,
    ].join('\n');
  }

  // Inline case: pipe is gone. Payload comes with the directive.
  return [
    '[GGUI_USER_ACTION]',
    `kind: inline`,
    `renderId: ${userAction.renderId}`,
    `intent: ${userAction.intent}`,
    `actionId: ${userAction.actionId}`,
    `submittedAt: ${userAction.submittedAt}`,
    '',
    `actionData: ${JSON.stringify(userAction.payload.actionData)}`,
    `uiContext: ${JSON.stringify(userAction.payload.uiContext)}`,
    '',
    `The user clicked inside the live iframe for render ${userAction.renderId}. The consume pipe is unavailable for this gesture (PIPE_NOT_FOUND or transport error), so the action payload is inlined above. Do NOT call ggui_consume — there is nothing to drain. Process actionData with the appropriate domain tool, then call ggui_update on the SAME renderId (${userAction.renderId}) to reflect the new state.`,
    '',
    `Original user message: ${originalPrompt}`,
  ].join('\n');
}
