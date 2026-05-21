/**
 * Shell-facing types. The only type that survives here is
 * {@link AgentState} — the character state machine used by
 * `AgentShell` (and whatever future shells need a three-state
 * idle/thinking/presenting affordance).
 *
 * Everything else this file used to export (ShellContext, ActiveSession,
 * SessionInfo, ShellProps, InboundHandlers, OutboundHandlers,
 * BaseShellProps, ShellProp, ConnectionStatus) was scaffolding around
 * the retired `<BaseShell>` WebSocket-owner pattern. Shells now read
 * endpoint + auth + resume from `useGguiContext()` and spin `useInvoke`
 * internally — no context injection surface left.
 *
 * `ConnectionStatus` lives on `@ggui-ai/protocol/transport/websocket`;
 * import it from there directly if you need it for a non-shell WS
 * client.
 */

// ── Agent State ──────────────────────────────────────────────────────
export type AgentState = 'idle' | 'listening' | 'thinking' | 'presenting' | 'error';
