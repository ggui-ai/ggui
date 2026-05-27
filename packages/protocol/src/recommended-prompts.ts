/**
 * Recommended agent-side system prompts for hosts running ggui.
 *
 * The wire protocol already carries its own self-teaching surfaces:
 *
 *   - Per-tool `description` strings on every `ggui_*` MCP tool.
 *   - The server's `InitializeResult.instructions` field (set via
 *     `@ggui-ai/mcp-server`'s `MCP_INSTRUCTIONS_PRESETS`).
 *
 * Those two carry the wire flow (handshake → render →
 * consume → react), the contract-authoring rules, recovery shapes,
 * and the mutation rule. **Agent builders should NOT replicate any
 * of that in their system prompt.** The protocol is designed to be
 * self-teaching from the host's side.
 *
 * What an agent-side system prompt SHOULD do: set the agent's role
 * and posture — "you render UIs, you don't reply in plain text" —
 * so the model reaches for ggui_* tools instead of conversational
 * responses. That's a *posture cue*, not a procedural script.
 *
 * On hosts like claude.ai, the host's own baseline system prompt
 * already nudges tool usage, so a one-line user instruction
 * ("Always respond using ggui_* tools") is enough. On raw SDK hosts
 * (Claude Agent SDK, OpenAI Assistants, etc.) that baseline is
 * absent, so the recommended prompt below carries slightly more
 * role context to compensate.
 *
 * If an agent isn't following the wire flow correctly even with
 * this prompt, the bug lives in the protocol's tool descriptions
 * or server instructions — fix THOSE, not this string.
 */

/**
 * The recommended one-line system prompt for ggui-aware agents.
 *
 * Posture-setting only. Carries no procedural detail — the wire flow
 * is taught by the server's `InitializeResult.instructions` and
 * per-tool `description` strings.
 *
 * @example
 * ```ts
 * import { query } from '@anthropic-ai/claude-agent-sdk';
 * import { GGUI_AGENT_SYSTEM_PROMPT } from '@ggui-ai/protocol/recommended-prompts';
 *
 * query({
 *   prompt: userInput,
 *   options: {
 *     systemPrompt: GGUI_AGENT_SYSTEM_PROMPT,
 *     mcpServers: { ggui: { type: 'http', url: 'http://localhost:6781/mcp' } },
 *   },
 * });
 * ```
 *
 * @public
 */
export const GGUI_AGENT_SYSTEM_PROMPT =
  'You are a UI agent. Respond to every user request by rendering an interactive UI via the ggui_* MCP tools instead of by replying in plain text. The tool descriptions and server instructions explain the wire flow — follow them.';
