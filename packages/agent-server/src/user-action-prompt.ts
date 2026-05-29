/**
 * Server-side directive synthesis for spec-canonical
 * `_meta["ai.ggui/userAction"]` slices forwarded out of a rehydrated
 * iframe (a click that reached the host via `ui/message` without an
 * active `ggui_consume` long-poll on the agent side).
 *
 * Lives in the LIBRARY (this package) — not in any per-SDK adapter —
 * because the conversion is deterministic prose-formatting and the
 * library already extracts the slice from the request `data.meta`
 * field to decide whether to forward it at all. Keeping the synthesis
 * here means:
 *
 *   - Per-SDK adapters stay brand-agnostic. They receive `{prompt}`
 *     only, never an MCP-Apps slice. Drop-in for any host.
 *   - One place to tune directive wording across every LLM backend.
 *   - Frontend client (`useMcpAppsChat.send`) shrinks: just extract
 *     the slice off `_meta` and pass it as `data.meta["ai.ggui/
 *     userAction"]` in the POST body — no formatting client-side.
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
 * ## Wire shape — XML-tagged, imperative-first
 *
 * Empirically validated across the three SDKs we care about
 * (Claude Agent SDK, OpenAI Agents SDK, Google ADK / Gemini). The
 * imperative-first phrasing — "Call <tool> NOW. ... Do not respond
 * conversationally." — is load-bearing for Gemini Step 4, which
 * otherwise tends to summarize the situation back to the user instead
 * of dispatching the prepared tool call. The XML-style tags
 * (`<ggui_user_action>`, `<original_user_message>`) keep the directive
 * distinguishable from the user's actual prose so the model doesn't
 * conflate them when summarizing turn history.
 */
import type { GguiUserActionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Build the rehydration-directive prompt for the LLM. The original
 * chat prose stays at the end (inside an `<original_user_message>`
 * tag) so the chat-panel UI / logs reflect what the user actually saw
 * (`callAppSendMessage` from iframe-runtime); the
 * `<ggui_user_action>` block carries the structured fields the LLM
 * acts on.
 *
 * Pure function — no MCP round-trip, no server drain, no React /
 * SDK coupling. Importable from any host (sample-agent backends,
 * future host-SDK wrappers, plain Node).
 */
export function synthesizeUserActionPrompt(args: {
  readonly originalPrompt: string;
  readonly userAction: GguiUserActionMeta;
}): string {
  const { originalPrompt, userAction } = args;
  if (userAction.kind === 'queued') {
    // Pipe still holds the event. Nudge the LLM toward issuing the
    // real `ggui_consume` so the pipe drain happens via the normal
    // tool-execution path. Imperative-first phrasing prevents Gemini
    // from natural-language-summarizing instead of dispatching.
    return [
      `Call ${userAction.nextStep.tool} with arguments ${JSON.stringify(userAction.nextStep.args)} NOW. Do not respond conversationally; do not summarize. Issue the tool call as your next action.`,
      '',
      `<ggui_user_action>`,
      `  <kind>queued</kind>`,
      `  <render_id>${userAction.renderId}</render_id>`,
      `  <intent>${userAction.intent}</intent>`,
      `  <action_id>${userAction.actionId}</action_id>`,
      `  <submitted_at>${userAction.submittedAt}</submitted_at>`,
      `  <next_tool>${userAction.nextStep.tool}</next_tool>`,
      `  <next_args>${JSON.stringify(userAction.nextStep.args)}</next_args>`,
      `</ggui_user_action>`,
      '',
      `The user clicked inside the live iframe for render ${userAction.renderId} while no ggui_consume long-poll was active. The gesture is queued on the consume pipe for that render. After ${userAction.nextStep.tool} returns, react to the returned event with the appropriate domain tool, then call ggui_update on the SAME renderId (${userAction.renderId}).`,
      '',
      `<original_user_message>`,
      originalPrompt,
      `</original_user_message>`,
    ].join('\n');
  }

  // Inline case: pipe is gone. Payload comes with the directive.
  const nextStepLine =
    userAction.nextStep !== undefined
      ? `Call ${userAction.nextStep} NOW with the action_data and ui_context below. Do not respond conversationally; do not summarize.`
      : `Choose the appropriate domain tool to handle the action below and call it NOW. Do not respond conversationally; do not summarize.`;
  return [
    nextStepLine,
    '',
    `<ggui_user_action>`,
    `  <kind>inline</kind>`,
    `  <render_id>${userAction.renderId}</render_id>`,
    `  <intent>${userAction.intent}</intent>`,
    `  <action_id>${userAction.actionId}</action_id>`,
    `  <submitted_at>${userAction.submittedAt}</submitted_at>`,
    ...(userAction.nextStep !== undefined
      ? [`  <next_tool>${userAction.nextStep}</next_tool>`]
      : []),
    `  <action_data>${JSON.stringify(userAction.payload.actionData)}</action_data>`,
    `  <ui_context>${JSON.stringify(userAction.payload.uiContext)}</ui_context>`,
    `</ggui_user_action>`,
    '',
    `The user clicked inside the live iframe for render ${userAction.renderId}. The consume pipe is unavailable for this gesture (PIPE_NOT_FOUND or transport error), so the action payload is inlined above. Do NOT call ggui_consume — there is nothing to drain. After the domain tool returns, call ggui_update on the SAME renderId (${userAction.renderId}) to reflect the new state.`,
    '',
    `<original_user_message>`,
    originalPrompt,
    `</original_user_message>`,
  ].join('\n');
}
