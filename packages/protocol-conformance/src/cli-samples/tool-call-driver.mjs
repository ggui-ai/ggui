/**
 * A spec-correct `--tool-call-driver` sample: what the flag expects to
 * import. A real driver performs ONE `tools/call` against the deployment
 * under test and returns the raw result the MCP client received; this
 * one answers the catalog's six no-setup scenarios the way a conformant
 * server does — the registered slug LEADS the text (SPEC §7.9 Plane 2,
 * ggui#880), `isError: true`, no `structuredContent`, no `_meta`.
 */
const CODE_BY_TOOL = { ggui_render: 'handshake_not_found' };

export function drive(scenario) {
  const code = CODE_BY_TOOL[scenario.tool] ?? 'session_not_found';
  const id = scenario.args.handshakeId ?? scenario.args.sessionId;
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: "${String(id)}" resolves to nothing on this deployment. Mint a fresh id.` }],
  };
}
