# @ggui-ai/protocol-conformance

Conformance test kit for the ggui protocol. Ships a JSON fixture catalog + a runner that drives each fixture against a live implementation over WebSocket and reports scorecard-style pass / fail / skip output.

This kit is the protocol's conformance surface: it lets a third-party MCP builder prove their implementation is protocol-conformant without reimplementing the test harness.

## Grading mechanisms

The kit grades protocol obligations through **three mechanisms**, each matched to where the obligation is observable:

1. **Path-A WS fixtures** — wire-observable behaviors graded from frames the runner collects over the live channel (acks, error frames, canonical `data` deliveries).
2. **Pure-function catalogs** — deterministic validation obligations (the SPEC §7.7.2 gadget obligations) graded against a caller-supplied function; no host, render, or transport.
3. **Session-state host read-back** — stateful obligations with no wire response (e.g. `host_context_observed` persisting onto `GguiSession.hostContext`): the runner dispatches the C→S frame, waits out the observation window, then reads the GguiSession field back through `ConformanceHost.readSessionField()` and deep-equals it against the fixture's `expected`. No host (or a host without the method, or a read that throws) → the fixture SKIPS with the reason — a host that cannot read state cannot grade it, and the kit never converts that gap into a pass.

A fourth surface — the **Path-B browser-host driver** for DOM-level claims (`bootstrap-failure`, `props-update`) — is honestly absent: it is not yet packaged, and those fixtures skip wherever the kit runs (see below).

## Transport

**v1.0 is WebSocket-only.** The canonical ggui transport is WS (see SPEC §12 Transport Bindings). `TransportConfig` is shaped as an extensibly-closed union so later transports (stdio MCP, HTTP long-poll) can be added post-v1.1 without breaking the public API.

## Path-A vs Path-B matchability

The fixture catalog spans both wire-observable claims and surface-observable claims. The kit's runner (`runConformance()`) handles the **Path-A** subset — behaviors a runner can assert from WS frames alone, with no MCP-Apps-host adapter and no Playwright page.

Path-A-matchable kinds (`matchBehavior` returns `pass` / `fail`):

- `bootstrap-success` — subscribe → `ack` round-trip; optionally (`serverVersion: 'current'`) the ack must also advertise `payload.serverVersion` equal to the kit's compiled `PROTOCOL_SCHEMA_VERSION` — the server half of SPEC §12.2.2's version handshake
- `version-mismatch` — `error` frame with `code: UPGRADE_REQUIRED`; the provoking client declaration travels on the fixture's `subscribe.supportedVersions` knob (`'current'` resolves to the compiled canonical, keeping fixtures evergreen across version bumps)
- `action-ack` — the action's `ack` frame (matched by echoed `requestId`) carries a numeric `payload.sequence`, proving the action event persisted to the GguiSession's consume buffer before the ack
- `error-frame` — `error` frame with the expected `payload.code` (e.g. `CONTRACT_VIOLATION` for an action absent from the declared actionSpec, or one whose `data` violates the declared entry's payload schema)
- `stream-update` — canonical channel-3 delivery frame (`{type: 'data', payload: StreamEnvelope}`, SPEC §12.2) whose envelope names the declared channel and carries the declared value as its `payload` body — exact deep-equal by default, or declared-keys-subset when the fixture authors `valueMatch: 'subset'` (for payloads carrying non-deterministic fields like generated ids)
- `no-op` — silence after input dispatch

One kind is neither Path A nor Path B: `session-state` is graded by the **runner**, not the frame matcher — a post-observation-window read-back via `ConformanceHost.readSessionField()` (mechanism 3 above). `matchBehavior` returns `unmatchable-on-ws` for it, because frames cannot prove state.

Path-B-only kinds (`matchBehavior` returns `unmatchable-on-ws` → runner records SKIP):

- `bootstrap-failure` — fault surface is the host's bootstrap-fetch + `ui/initialize` postMessage round-trip; `renderer-url-override` / `ui-initialize-response-override` setup directives are MCP-Apps-host concerns, not WS server concerns.
- `props-update` — assertion is on rendered DOM after `_ggui:props` is emitted; matchable on WS only as "frame was emitted", not as "DOM reflects it".

The Path-B driver is not yet packaged — no browser-host harness ships with the kit today, so Path-B fixtures skip wherever the kit runs. A future packaged browser-host adapter will fold that capability into the kit so third-party adopters don't reimplement it.

The partition is intentional: Path-A FAILs are vendor-neutrality bugs the server owns; Path-B SKIPs are not fails — they are claims a different driver is responsible for.

One declared grading gap on the action loop: `action-ack` proves the append half of the consume-buffer contract; the retrieval half (the agent draining the buffer via `ggui_consume`) is an MCP tool call a WS-only runner cannot drive. Grading it needs an MCP-binding driver — a future kit surface, not a weaker WS assertion.

## Pure-function conformance catalogs

The behavioral fixture catalog above asserts what an implementation _does_ over the wire. Some protocol obligations aren't transport-observable at all — they are deterministic _validation functions_: given an input, accept or reject it. SPEC §7.7.2's gadget obligations are exactly this. Modeling them as WebSocket fixtures would mean faking wire frames the protocol never emits; instead the kit ships **pure-function catalogs** — accept/reject cases graded against a caller-supplied function, with no host, render, or transport.

Each catalog ships its cases as raw JSON so a non-TypeScript implementer can grade their own implementation, and each runner takes the implementation as a callback — the kit never hard-binds a concrete one. Three catalogs ship today:

- **`@ggui-ai/protocol-conformance/schema-conformance`** — which `DataContract.clientCapabilities` payloads a conformant parser MUST accept / reject (the gadget wire shape).
- **`@ggui-ai/protocol-conformance/registration-conformance`** — which `(contract, appGadgets, appPublicEnv)` triples the push-time gadget gate stack MUST accept / reject, and with which precise SPEC §7.9 reject code (`gadget_not_registered` / `gadget_package_mismatch` / `gadget_public_env_missing` / `duplicate_gadget_hook`).
- **`@ggui-ai/protocol-conformance/resolution-conformance`** — which bundle + style URLs the server MUST compute for a gadget descriptor's transport fields (`bundleHost` precedence, default host, loopback `http` scheme).

```ts
import { runSchemaConformance } from "@ggui-ai/protocol-conformance/schema-conformance";
import { runRegistrationConformance } from "@ggui-ai/protocol-conformance/registration-conformance";
import { runResolutionConformance } from "@ggui-ai/protocol-conformance/resolution-conformance";

const schema = runSchemaConformance((clientCapabilities) =>
  myGadgetWireParser.isValid(clientCapabilities)
);
const gate = runRegistrationConformance((contract, appGadgets, appPublicEnv) =>
  myGadgetGate(contract, appGadgets, appPublicEnv)
);
const urls = runResolutionConformance((entry) => myGadgetUrlResolver(entry));

if (schema.failed.length + gate.failed.length + urls.failed.length > 0) {
  process.exit(1);
}
```

The `schema-conformance` meta-test binds its catalog to the live `@ggui-ai/protocol` `clientCapabilitiesSpecSchema` — a drift-catch if the wire schema diverges from the §7.7.2 obligations the catalog freezes. The `registration-conformance` and `resolution-conformance` meta-tests verify catalog coherence against faithful in-test implementations (the kit stays vendor-neutral — it does not depend on a server implementation); grading the _shipping_ gate / resolver is an implementation-side test that drives the corresponding runner.

## Public API

```ts
import { runConformance } from "@ggui-ai/protocol-conformance";

const result = await runConformance({
  serverUrl: "ws://localhost:3000/ws",
  auth: { kind: "bearer", token: process.env.TOKEN! },
});

// A failed fixture is a red build — and so is a run that executed
// ZERO fixtures (all skips prove nothing).
if (result.failed.length > 0 || result.passed.length === 0) {
  process.exit(1);
}
```

`serverUrl` accepts either a bare origin (`http://localhost:3000` — the runner derives `ws://localhost:3000/ws`) or the full live-channel endpoint (`ws://localhost:3000/ws` — used exactly as given; the runner never appends to an explicit path).

CLI equivalent:

```
npx @ggui-ai/protocol-conformance --url ws://localhost:3000/ws --auth bearer:$TOKEN
```

The CLI exits `0` only when at least one fixture executed and none failed; `1` on any fixture failure; `2` on invocation errors **or** when every fixture skipped (a zero-executed run never reads as success in CI).

To grade setup-dependent fixtures (and any `session-state` fixture), pass a `host` implementing the `ConformanceHost` adapter — `dispatchSetup` / `dispatchTeardown` for the directive vocabulary, plus the optional `readSessionField(sessionId, field)` introspection seam. Fixtures whose requirements the host doesn't meet skip with a precise reason; they never silently pass.

## License

Apache 2.0 — see `../LICENSE`.
