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
- In-memory session store (no persistence).
- `schemaVersion` handshake with `UPGRADE_REQUIRED` on mismatch.
- A 4-handler wired-action registry:
  - `echo` — returns `{received: args}`.
  - `throw` — rejects → `TOOL_THREW` emitted on `_ggui:contract-error`.
  - `timeout` — never resolves → `TOOL_TIMEOUT` after 500ms.
  - `malformed` — shape-mismatched return → `SCHEMA_VIOLATION`.
- `TOOL_NOT_FOUND` when an unregistered action is invoked.

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
pass (bootstrap-success, wired-action-success, wired-action-tool-threw,
stream-schema-violation); directives outside this server's scope (renderer-url-override,
ui-initialize-response-override, and similar) skip cleanly per the kit's design.
