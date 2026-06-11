# @ggui-ai/protocol-reference-server

Minimal reference implementation of the **ggui protocol** — the narrow WebSocket server
that `@ggui-ai/protocol-conformance` runs against to prove the protocol is vendor-neutral.

This package is **not a production server**. It implements exactly enough of the
ggui live-channel WebSocket wire to pass the conformance kit. Its deliberate design
constraint — zero runtime dependency on `@ggui-ai/mcp-server*` — is what makes the
vendor-neutrality claim real: an independent, from-scratch implementation passing the
kit grounds the claim empirically rather than by assertion.

## Scope

- WebSocket transport matching the ggui live-channel wire.
- In-memory render store with a consume-buffer event ledger (no persistence).
- `schemaVersion` handshake with `UPGRADE_REQUIRED` on mismatch.
- Subscribe tenancy: the subscribe's `appId` must match the GguiSession's
  bound `appId` or the subscribe is rejected with an `error` frame, code
  `APP_MISMATCH` (an unknown session id still provisions on subscribe,
  binding the subscribe's own `appId`).
- `host_context_observed` persistence: the client-observed
  `HostContextProjection` is validated against the protocol shape and
  persisted onto `GguiSession.hostContext` (idempotent overwrite, no
  response frame); the conformance host reads it back via
  `readSessionField('hostContext')`.
- The single action-routing model:
  - a declared action appends to the GguiSession's consume buffer and the
    ack carries `payload.sequence` (validate → append → ack);
  - a `data:submit` action absent from the declared actionSpec is rejected
    with an `error` frame, code `CONTRACT_VIOLATION` — nothing is appended.
- The agent-side drain (`ggui_consume`) is an MCP surface this WS-only
  server does not implement — a declared kit grading gap.

## Non-scope

- No authentication (accepts any bearer verbatim).
- No bundle loading / embedded-ui.
- No persistence — restart drops all state.
- Not intended as a runtime for agents. Use `@ggui-ai/mcp-server` for that.

## Boot

```
npx @ggui-ai/protocol-reference-server --port 3100
```

Prints `READY ws://127.0.0.1:3100/ws` when bound. Ctrl-C to stop.

## CI proof

`src/conformance.test.ts` boots this server and runs `@ggui-ai/protocol-conformance`
against it through a `ConformanceHost` adapter. Every drivable conformance fixture must
pass (bootstrap-success, action-ack-sequence, undeclared-action-rejected,
action-payload-schema-violation, version-match, version-mismatch, app-mismatch,
absent-appid-defaults, host-context-observed-persists); directives outside this server's scope
(renderer-url-override, ui-initialize-response-override, and similar) skip cleanly per
the kit's design.
