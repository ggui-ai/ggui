/**
 * Server-side directive synthesis for the spec-canonical
 * `_meta["ai.ggui/userAction"]` PURE DOORBELL forwarded out of an iframe
 * (a click that reached the host via `ui/message` because no
 * `ggui_consume` long-poll was listening on the agent side — e.g. after
 * a page reload).
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
 *   - Frontend client (`useMcpAppsChat.send`) stays ggui-protocol-
 *     agnostic: it forwards the content block's `_meta` opaquely in the
 *     POST body's `data.meta`; the backend is the sole trust boundary
 *     that recognizes + guards the `ai.ggui/userAction` key.
 *
 * ## Single kind: `user-action` (PURE DOORBELL)
 *
 * The slice is a pointer ONLY — it names the render whose pending-event
 * pipe holds the gesture, never the action payload. SINGLE SOURCE OF
 * TRUTH is the pipe. The directive's whole job is to make the agent's
 * REQUIRED FIRST TOOL CALL be `ggui_consume({renderId})`, which drains
 * the gesture via the normal tool-execution path. We never drain
 * server-side (that would create a double-truth bug: the pipe still
 * holds the event AND a fabricated consume return claims it was
 * drained), and we never embed the action data in the prompt (that
 * would let the agent act on the inline copy AND drain the pipe = a
 * double-trigger — the action would fire twice). Pointer-only ⇒
 * exactly-once by construction.
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
 * `<ggui_user_action>` block carries the structured pointer fields the
 * LLM acts on.
 *
 * The directive embeds NO action data — the agent retrieves the gesture
 * EXCLUSIVELY by issuing the REQUIRED FIRST TOOL CALL `ggui_consume`.
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
  // Pure doorbell: the gesture is already on the render's pending-event
  // pipe. The REQUIRED FIRST TOOL CALL drains it via the normal
  // tool-execution path; the real consume result flows back through the
  // SDK so the MCP server pipe stays the single source of truth.
  // Imperative-first phrasing prevents Gemini from natural-language-
  // summarizing instead of dispatching.
  return [
    `Your REQUIRED FIRST TOOL CALL is ${userAction.nextStep.tool} with arguments ${JSON.stringify(userAction.nextStep.args)}. Call it NOW to retrieve and process the pending interaction. Do not respond conversationally; do not summarize. Issue the tool call as your next action.`,
    '',
    `<ggui_user_action>`,
    `  <kind>user-action</kind>`,
    `  <render_id>${userAction.renderId}</render_id>`,
    `  <intent>${userAction.intent}</intent>`,
    `  <action_id>${userAction.actionId}</action_id>`,
    `  <submitted_at>${userAction.submittedAt}</submitted_at>`,
    `  <next_tool>${userAction.nextStep.tool}</next_tool>`,
    `  <next_args>${JSON.stringify(userAction.nextStep.args)}</next_args>`,
    `</ggui_user_action>`,
    '',
    `The user interacted with render ${userAction.renderId} while no ggui_consume long-poll was active. The gesture is queued on the consume pipe for that render — it is NOT in this message. After ${userAction.nextStep.tool} returns, react to the returned event with the appropriate domain tool, then call ggui_update on the SAME renderId (${userAction.renderId}).`,
    '',
    `<original_user_message>`,
    originalPrompt,
    `</original_user_message>`,
  ].join('\n');
}
