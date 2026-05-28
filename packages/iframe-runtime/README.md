# @ggui-ai/iframe-runtime

The iframe-local runtime for [ggui](https://ggui.ai).

A self-contained ESM bundle that boots inside an MCP Apps host iframe,
runs the protocol-version handshake, opens the live-channel WebSocket,
and mounts the rendered UI. It bundles React, ReactDOM, and the
ggui design system inside the artifact so generated component code has a
single seam to read from.

Most consumers never call this package's API directly — they load the
built runtime artifact into an iframe. The package's TypeScript surface
exists for host apps, the `<McpAppIframe>` wrapper, and tests.

## Public surface

For host-side code that needs to validate or react to runtime state:

- `parseBootstrap` (and `parseBootstrapFrom*` variants) —
  parse and validate a render bootstrap before spawning the iframe.
- `ProtocolError` and the `from*` constructors — the canonical typed
  union for every failure the renderer classifies outward.
- `ObservabilityEvent` / `postObservabilityToParent` — the renderer →
  host telemetry seam.
- `LifecycleEmitter` / `postLifecycleToParent` — lifecycle events.

Internal runtime types (`bootSequence`, `connectViaRegistry`, the
per-channel handler factories, and the single-item render mount) are
deliberately not exported — they are an internal implementation
contract, not a public API.

## License

Apache-2.0
