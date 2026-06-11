# @ggui-ai/protocol

TypeScript source of truth for the ggui protocol — the open wire format between agents and generated user interfaces. Ships the envelope types (`ActionEnvelope`, `StreamEnvelope`), the canonical error-frame codes, the WebSocket + MCP transport bindings, and the DTCG design-token contract.

The full normative spec lives at [docs.ggui.ai](https://docs.ggui.ai). This package is what an implementer actually imports.

```bash
npm install @ggui-ai/protocol
```

## How the protocol works

An agent declares a contract. A user clicks a button. The right MCP tool runs. No SDK glue.

Here is what happens when a user clicks "Add" on a generated todo UI:

1. **LLM wrote the hook** — `const addTodo = useAction('addTodo');` bound to the button's `onClick`.
2. **User clicks** — React fires `onClick`, which calls `addTodo(data)`.
3. **Hook dispatches** — `useAction` (from `@ggui-ai/wire`) sends an `ActionEnvelope` on the live channel.
4. **WS transport** — the server receives the envelope on the GguiSession's live-channel WebSocket.
5. **Server persists a consume event** — the validated envelope is appended to the session's event ledger, stamped with an advisory `tool` hint derived server-side from `actionSpec.addTodo.nextStep === 'todo.add'`.
6. **Agent consumes** — the agent drains the event via `ggui_consume` on its next turn and calls `todo.add` itself. Actions drive agent turns; no client-side tool dispatch.
7. **Agent pushes the update** — the agent's update travels back to the UI on the live channel (`props_update`, or a `StreamEnvelope` on a declared stream channel).
8. **UI absorbs the update** — props or the component's `useStream` callback update state, no regeneration.

**No SDK glue.** Every step has a named, typed enforcement layer — schema-subset check at push time, `CONTRACT_VIOLATION` error frames on the live channel at runtime, `@ggui-ai/protocol-conformance` at CI time, TypeScript narrowing at author time. Nothing about this pipeline assumes a specific SDK: a third-party implementer honoring the envelope + channel contracts inherits all four enforcement tiers for free.

## Implementer guide

Building a third-party MCP host that renders ggui UIs, a non-React viewer, or any runtime that speaks the ggui wire contract? The implementer guide at [docs.ggui.ai](https://docs.ggui.ai) covers the three-way quickstart (React via `<McpAppIframe>` / vanilla iframe + postMessage / MCP-host install), the full `ProtocolError` recipe with suggested UX per variant, `ObservabilityEvent` kinds, and version negotiation.

## What this package exports

| Surface                                     | What it is                                                         |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `@ggui-ai/protocol`                         | Root barrel — envelope types, `GguiSession`, `StreamSpec`, actions |
| `@ggui-ai/protocol/content-hash`            | Deterministic hashing for cache keys                               |
| `@ggui-ai/protocol/blueprint-key`           | Server-only blueprint cache-key derivation (uses `node:crypto`)    |
| `@ggui-ai/protocol/transport/websocket`     | Live-channel WS binding — subscribe / ack / resume types           |
| `@ggui-ai/protocol/integrations/mcp-apps`   | MCP Apps host integration types — bootstrap + lifecycle protocol   |
| `@ggui-ai/protocol/version`                 | Protocol version constant + negotiation helpers                    |
| `@ggui-ai/protocol/errors/version-mismatch` | Typed error for version-negotiation failures                       |

## License

Apache-2.0.
