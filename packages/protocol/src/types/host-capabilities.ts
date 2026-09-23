/**
 * The host's declaration of what it does with a view's gestures (ggui#1309),
 * carried as the `Ggui-Host-Capabilities` request header on the MCP
 * connection to a ggui server.
 *
 * **Parties.** The HOST's own code sets the header (its MCP client's
 * connection configuration) — never the model: a flag the model can write
 * would be the agent writing behaviour into the contract, and could not be
 * verified. The SERVER reads it per request and adjusts agent-facing hints.
 * The AGENT follows the hints it is given.
 *
 * **Value.** Comma-separated tokens. A server ignores a token it does not
 * name (tolerant read, VERSION-POLICY §3.6), so a later capability rides the
 * same header without breaking an older server. On a transport with no
 * headers (stdio) there is no declaration, and behaviour is unchanged.
 */

/** The header name, lowercase (HTTP header names are case-insensitive; Node lowercases them). */
export const GGUI_HOST_CAPABILITIES_HEADER = 'ggui-host-capabilities';

/**
 * `ui-message-turn` — every `ui/message` the view posts becomes the next
 * agent turn: immediately when the conversation is idle, queued while a turn
 * is live; a drop is named by the host, never silent. A host declares it only
 * for a client that does this. Effect on a ggui server: a render response
 * omits its `nextStep: ggui_consume` hint, because a later gesture reaches
 * the agent as a turn anyway — so the agent ends its turn at paint.
 * Observable violation: a view's `ui/message` that never yields a turn.
 */
export const HOST_CAPABILITY_UI_MESSAGE_TURN = 'ui-message-turn';

/**
 * Parse the header's value (a string, a repeated header's array, or absent)
 * into its tokens: trimmed, lowercased, de-duplicated, empties dropped,
 * unknown tokens KEPT. Absent or empty ⇒ `[]`.
 */
export function parseHostCapabilitiesHeader(raw: string | readonly string[] | undefined): readonly string[] {
  if (raw === undefined) return [];
  const joined = typeof raw === 'string' ? raw : raw.join(',');
  const tokens: string[] = [];
  for (const part of joined.split(',')) {
    const token = part.trim().toLowerCase();
    if (token.length > 0 && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}
